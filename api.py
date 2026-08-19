"""VEYRONIS API Server + Frontend."""
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from orchestrator import CentralOrchestrator
from guardrails import check_input
from tools.document_parser import DocumentParser
from tools.code_executor import CodeExecutor
from database import (
    save_message, get_history, clear_history,
    create_conversation, get_conversations, rename_conversation,
    delete_conversation
)
from settings import Config
import base64
import uvicorn
from datetime import date, datetime, timedelta
import json
import time
import traceback

# ─── PATH SETUP ───
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="VEYRONIS API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

orchestrator = CentralOrchestrator()
limits_file = BASE_DIR / "daily_limits.json"
PRO_CODES = {"VEYRONIS-PRO-2026", "MATRIX-TEAM-VIP", "DEV-MODE-2026"}


def _b64_to_data_url(b64_string: str) -> str:
    """Detect image MIME from base64 header and return a full data URL."""
    try:
        header = base64.b64decode(b64_string[:32] + "==")
        if header[:3] == b"\xff\xd8\xff":
            return f"data:image/jpeg;base64,{b64_string}"
        if header[:8] == b"\x89PNG\r\n\x1a\n":
            return f"data:image/png;base64,{b64_string}"
        if header[:6] in (b"GIF87a", b"GIF89a"):
            return f"data:image/gif;base64,{b64_string}"
        if len(header) > 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
            return f"data:image/webp;base64,{b64_string}"
    except Exception:
        pass

    return f"data:image/png;base64,{b64_string}"


# Rate limit tracking per IP
_rate_limit_tracker = {}


def _check_rate_limit(client_ip: str, max_requests: int = 30, window_seconds: int = 60):
    """Sliding window rate limiter."""
    now = time.time()
    key = client_ip

    if key not in _rate_limit_tracker:
        _rate_limit_tracker[key] = []

    # Clean old entries
    _rate_limit_tracker[key] = [
        t for t in _rate_limit_tracker[key]
        if now - t < window_seconds
    ]

    if len(_rate_limit_tracker[key]) >= max_requests:
        return False

    _rate_limit_tracker[key].append(now)
    return True


def load_limits():
    if limits_file.exists():
        with open(limits_file, "r") as f:
            return json.load(f)
    return {}


def save_limits(data):
    with open(limits_file, "w") as f:
        json.dump(data, f)


def get_today():
    return str(date.today())


def check_free_limit(client_ip: str):
    data = load_limits()
    key = f"{client_ip}_{get_today()}"
    return data.get(key, 0) < 20


def add_free_request(client_ip: str):
    data = load_limits()
    key = f"{client_ip}_{get_today()}"
    data[key] = data.get(key, 0) + 1
    save_limits(data)


class ChatRequest(BaseModel):
    message: str = ""
    pro_code: str = ""
    user_id: str = ""
    mode: str = "chat"
    model_mode: str = "instant"
    ai_model: str = "groq"
    conversation_id: Optional[int] = None
    image: Optional[str] = None
    custom_instructions: Optional[str] = None
    response_style: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    tier: str = "free"
    conversation_id: Optional[int] = None
    reasoning: Optional[str] = None
    citations: Optional[List[Dict[str, Any]]] = None


class NewConversationRequest(BaseModel):
    user_id: str
    title: str = "New Chat"


class RenameRequest(BaseModel):
    title: str


@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(
        str(FRONTEND_DIR / "service-worker.js"),
        media_type="application/javascript"
    )


@app.get("/history")
async def history(user_id: str, conversation_id: Optional[int] = None):
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")

    msgs = get_history(user_id, conversation_id=conversation_id)
    return {"messages": msgs}


@app.get("/export/{conversation_id}")
async def export_conversation(
    conversation_id: int,
    format: str = "json",
    user_id: str = ""
):
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")

    if format not in ("json", "txt"):
        raise HTTPException(
            status_code=400,
            detail="Format must be json or txt"
        )

    msgs = get_history(
        user_id,
        conversation_id=conversation_id,
        limit=1000
    )

    if format == "json":
        return {
            "conversation_id": conversation_id,
            "exported_at": datetime.now().isoformat(),
            "messages": msgs
        }

    else:
        lines = [
            f"VEYRONIS Chat Export\n{'=' * 50}\n",
            f"Exported: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n",
            f"Conversation ID: {conversation_id}\n",
            f"{'=' * 50}\n\n"
        ]

        for m in msgs:
            role_label = "You" if m["role"] == "user" else "VEYRONIS"
            time_str = m.get("time", "")
            lines.append(
                f"[{role_label}] {time_str}\n{m['content']}\n\n"
            )

        return {
            "content": "".join(lines),
            "filename": f"veyronis_chat_{conversation_id}.txt"
        }


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, req: Request):
    msg = request.message.strip()
    user_id = request.user_id.strip()
    conversation_id = request.conversation_id

    # Guardrails only on text; images bypass empty-text block
    if msg:
        is_safe, reason = check_input(msg)

        if not is_safe:
            raise HTTPException(
                status_code=400,
                detail=f"Blocked: {reason}"
            )

    # Allow image-only sends
    if not msg and not request.image:
        raise HTTPException(
            status_code=400,
            detail="Empty message"
        )

    if not user_id:
        raise HTTPException(
            status_code=400,
            detail="Missing user_id"
        )

    client_ip = req.client.host
    is_pro = request.pro_code in PRO_CODES

    # Canvas is a Pro-only feature
    if request.mode == "canvas" and not is_pro:
        raise HTTPException(
            status_code=403,
            detail="Canvas whiteboard is a Pro feature."
        )

    if not is_pro and not check_free_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail="FREE LIMIT: 20/day used. Upgrade to Pro."
        )

    if not _check_rate_limit(client_ip):
        raise HTTPException(
            status_code=429,
            detail="RATE LIMIT: Too many requests. Please slow down."
        )

    if not conversation_id:
        title = (
            msg[:40] + ("..." if len(msg) > 40 else "")
            if msg
            else "Image upload"
        )
        conversation_id = create_conversation(
            user_id,
            title=title
        )

    image_data_url = (
        _b64_to_data_url(request.image)
        if request.image
        else None
    )

    # Store user message with proper content
    user_content = msg or "[Image uploaded for analysis]"
    save_message(
        user_id,
        "user",
        user_content,
        conversation_id=conversation_id,
        image_data=image_data_url
    )

    try:
        result = orchestrator.process_pipeline(
            msg,
            mode=request.mode,
            user_id=user_id,
            conversation_id=conversation_id,
            image_b64=request.image,
            model_mode=request.model_mode,
            ai_model=request.ai_model,
            custom_instructions=request.custom_instructions,
            response_style=request.response_style
        )

        save_message(
            user_id,
            "assistant",
            result["response"],
            conversation_id=conversation_id
        )

        if not is_pro:
            add_free_request(client_ip)

        return ChatResponse(
            response=result["response"],
            tier="pro" if is_pro else "free",
            conversation_id=conversation_id,
            reasoning=result.get("reasoning"),
            citations=result.get("citations")
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=str(e)
        )


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest, req: Request):
    msg = request.message.strip()
    user_id = request.user_id.strip()
    conversation_id = request.conversation_id
    is_pro = request.pro_code in PRO_CODES

    # Canvas is a Pro-only feature
    if request.mode == "canvas" and not is_pro:
        async def err_gen():
            yield (
                f"data: {json.dumps({'type': 'error', 'content': 'Canvas whiteboard is a Pro feature. Upgrade to unlock.'})}\n\n"
            )

        return StreamingResponse(
            err_gen(),
            media_type="text/event-stream"
        )

    client_ip = req.client.host

    # Check if we have an image
    has_image = request.image is not None and len(request.image) > 0
    has_text = len(msg) > 0

    # Log what we received
    print(f"[VEYRONIS] /chat/stream received - text: {has_text}, image: {has_image}, image_len: {len(request.image) if request.image else 0}")

    # Guardrails only on text
    if has_text:
        is_safe, reason = check_input(msg)
        if not is_safe:
            async def err_gen():
                yield (
                    f"data: {json.dumps({'type': 'error', 'content': f'Blocked: {reason}'})}\n\n"
                )
            return StreamingResponse(
                err_gen(),
                media_type="text/event-stream"
            )

    # Require either text or image
    if not has_text and not has_image:
        async def err_gen():
            yield (
                f"data: {json.dumps({'type': 'error', 'content': 'Empty message - please add text or an image'})}\n\n"
            )
        return StreamingResponse(
            err_gen(),
            media_type="text/event-stream"
        )

    if not user_id:
        async def err_gen():
            yield (
                f"data: {json.dumps({'type': 'error', 'content': 'Missing user_id'})}\n\n"
            )
        return StreamingResponse(
            err_gen(),
            media_type="text/event-stream"
        )

    if not is_pro and not check_free_limit(client_ip):
        async def err_gen():
            yield (
                f"data: {json.dumps({'type': 'error', 'content': 'FREE LIMIT: 20/day used. Upgrade to Pro.'})}\n\n"
            )
        return StreamingResponse(
            err_gen(),
            media_type="text/event-stream"
        )

    if not _check_rate_limit(client_ip):
        async def err_gen():
            yield (
                f"data: {json.dumps({'type': 'error', 'content': 'RATE LIMIT: Too many requests. Please slow down.'})}\n\n"
            )
        return StreamingResponse(
            err_gen(),
            media_type="text/event-stream"
        )

    if not conversation_id:
        title = (
            msg[:40] + ("..." if len(msg) > 40 else "")
            if has_text
            else "Image upload"
        )
        conversation_id = create_conversation(
            user_id,
            title=title
        )

    image_data_url = (
        _b64_to_data_url(request.image)
        if has_image
        else None
    )

    # Store user message with proper content
    user_content = msg if has_text else "[Image uploaded for analysis]"
    save_message(
        user_id,
        "user",
        user_content,
        conversation_id=conversation_id,
        image_data=image_data_url
    )

    async def event_generator():
        full_response = ""

        try:
            # If we have an image but no text, we need to force vision mode
            effective_query = msg if has_text else ""
            
            for event_type, content in orchestrator.process_pipeline_stream(
                effective_query,
                mode=request.mode,
                user_id=user_id,
                conversation_id=conversation_id,
                image_b64=request.image if has_image else None,
                model_mode=request.model_mode,
                ai_model=request.ai_model,
                custom_instructions=request.custom_instructions,
                response_style=request.response_style
            ):
                if event_type == "token":
                    full_response += content
                    yield (
                        f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
                    )

                elif event_type == "reasoning" and content:
                    yield (
                        f"data: {json.dumps({'type': 'reasoning', 'content': content})}\n\n"
                    )

                elif event_type == "citations":
                    yield (
                        f"data: {json.dumps({'type': 'citations', 'content': content})}\n\n"
                    )

                elif event_type == "research_step":
                    yield (
                        f"data: {json.dumps({'type': 'research_step', 'content': content})}\n\n"
                    )

                elif event_type == "error":
                    yield (
                        f"data: {json.dumps({'type': 'error', 'content': content})}\n\n"
                    )
                    return

            yield (
                f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free'})}\n\n"
            )

            save_message(
                user_id,
                "assistant",
                full_response,
                conversation_id=conversation_id
            )

            if not is_pro:
                add_free_request(client_ip)

        except GeneratorExit:
            # Client disconnected (stop button pressed)
            if full_response:
                save_message(
                    user_id,
                    "assistant",
                    full_response,
                    conversation_id=conversation_id
                )
            raise

        except Exception as e:
            print(f"[VEYRONIS] Error in stream: {e}")
            traceback.print_exc()
            yield (
                f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
            )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )


@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    user_id: str = "",
    conversation_id: Optional[int] = None
):
    if not user_id:
        user_id = "u_auto_" + str(int(time.time()))
        print(
            f"[VEYRONIS] Auto-generated user_id for upload: {user_id}"
        )

    content = await file.read()
    text = DocumentParser.extract_text(
        content,
        file.filename
    )

    # Gemini document analysis (if available)
    gemini_analysis = None

    try:
        if Config.gemini_ready() and orchestrator.gemini_agent:
            gemini_analysis = orchestrator.gemini_agent.generate_document_response(
                content,
                file.filename,
                prompt=(
                    "Analyze this document thoroughly. Provide a concise "
                    "summary, key points, main arguments, important data, "
                    "and notable sections."
                )
            )

    except Exception as e:
        print(
            f"[VEYRONIS] Gemini document analysis failed: {e}"
        )

    if not conversation_id:
        conversation_id = create_conversation(
            user_id,
            title=file.filename
        )

    # Document message will be saved when user sends via /chat/stream with their prompt

    response = {
        "filename": file.filename,
        "extracted_length": len(text),
        "preview": text[:500],
        "content": text[:3000],
        "conversation_id": conversation_id
    }

    if gemini_analysis:
        response["gemini_analysis"] = gemini_analysis

    return response


@app.post("/clear")
async def clear_chat(request: Request):
    data = await request.json()
    user_id = data.get("user_id", "")
    conversation_id = data.get("conversation_id")

    if not user_id:
        raise HTTPException(
            status_code=400,
            detail="Missing user_id"
        )

    clear_history(
        user_id,
        conversation_id=conversation_id
    )

    return {"status": "Chat cleared"}


@app.get("/conversations")
async def list_conversations(user_id: str):
    if not user_id:
        raise HTTPException(
            status_code=400,
            detail="Missing user_id"
        )

    return {
        "conversations": get_conversations(user_id)
    }


@app.post("/conversations")
async def new_conversation(req: NewConversationRequest):
    if not req.user_id:
        raise HTTPException(
            status_code=400,
            detail="Missing user_id"
        )

    cid = create_conversation(
        req.user_id,
        req.title
    )

    return {
        "id": cid,
        "title": req.title
    }


@app.patch("/conversations/{conversation_id}")
async def patch_conversation(
    conversation_id: int,
    req: RenameRequest
):
    if not req.title.strip():
        raise HTTPException(
            status_code=400,
            detail="Empty title"
        )

    ok = rename_conversation(
        conversation_id,
        req.title.strip()
    )

    if not ok:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found"
        )

    return {"status": "renamed"}


@app.delete("/conversations/{conversation_id}")
async def remove_conversation(conversation_id: int):
    delete_conversation(conversation_id)
    return {"status": "deleted"}


@app.post("/execute")
async def execute_code(request: Request):
    data = await request.json()
    code = data.get("code", "").strip()

    if not code:
        raise HTTPException(
            status_code=400,
            detail="Empty code"
        )

    result = CodeExecutor.run(code)
    return result


@app.get("/health")
async def health():
    groq_ok = bool(Config.GROQ_API_KEY)
    tavily_ok = bool(Config.TAVILY_API_KEY)
    gemini_ok = Config.gemini_ready()

    return {
        "status": "VEYRONIS is online",
        "version": "1.2-alpha",
        "models": {
            "groq": groq_ok,
            "tavily": tavily_ok,
            "gemini": gemini_ok
        },
        "timestamp": datetime.now().isoformat()
    }


if __name__ == "__main__":
    print("=" * 50)
    print("  VEYRONIS API Server")
    print("  http://localhost:8000")
    print("=" * 50)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000
    )