"""VEYRONIS API Server + Frontend + JWT Auth (self-contained)."""
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, date
from jose import JWTError, jwt
from passlib.context import CryptContext
from orchestrator import CentralOrchestrator
from guardrails import check_input
from tools.document_parser import DocumentParser
from tools.code_executor import CodeExecutor
from database import (
    save_message, get_history, clear_history,
    create_conversation, get_conversations, rename_conversation,
    delete_conversation,
    create_user, get_user_by_email, get_user_by_id, set_user_pro
)
from settings import Config
import base64
import uvicorn
import json
import time
import traceback

# ─── JWT SETUP ───
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "veyronis-super-secret-key-change-me")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None

def get_current_user_optional(token: Optional[str] = Depends(oauth2_scheme)):
    if token is None:
        return None
    payload = decode_token(token)
    if payload is None:
        return None
    user_id = payload.get("sub")
    if user_id is None:
        return None
    user = get_user_by_id(int(user_id))
    if user is None:
        return None
    return {"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"])}

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

_rate_limit_tracker = {}

def _check_rate_limit(client_ip: str, max_requests: int = 30, window_seconds: int = 60):
    now = time.time()
    key = client_ip
    if key not in _rate_limit_tracker:
        _rate_limit_tracker[key] = []
    _rate_limit_tracker[key] = [t for t in _rate_limit_tracker[key] if now - t < window_seconds]
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

# ─── REQUEST MODELS ───
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

class RegisterRequest(BaseModel):
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    user: dict

# ─── AUTH ENDPOINTS ───
@app.post("/register")
async def register(req: RegisterRequest):
    try:
        if "@" not in req.email or "." not in req.email:
            raise HTTPException(400, detail="Invalid email")
        if len(req.password) < 6:
            raise HTTPException(400, detail="Password too short")
        existing = get_user_by_email(req.email)
        if existing:
            raise HTTPException(400, detail="Email already registered")
        hashed = get_password_hash(req.password)
        user_id = create_user(req.email, hashed)
        token = create_access_token({"sub": str(user_id)})
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user_id, "email": req.email, "is_pro": False}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[REGISTER ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail=f"Internal error: {str(e)}")

@app.post("/login")
async def login(req: LoginRequest):
    try:
        user = get_user_by_email(req.email)
        if not user:
            raise HTTPException(400, detail="Invalid credentials")
        if not verify_password(req.password, user["hashed_password"]):
            raise HTTPException(400, detail="Invalid credentials")
        token = create_access_token({"sub": str(user["id"])})
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"])}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[LOGIN ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail=f"Internal error: {str(e)}")

@app.get("/me")
async def get_me(current_user: dict = Depends(get_current_user_optional)):
    if current_user is None:
        raise HTTPException(401, detail="Not authenticated")
    return {"user": current_user}

@app.post("/upgrade")
async def upgrade_to_pro(current_user: dict = Depends(get_current_user_optional)):
    if current_user is None:
        raise HTTPException(401, detail="Not authenticated")
    set_user_pro(current_user["id"], True)
    return {"message": "Upgraded to PRO", "is_pro": True}

# ─── MAIN ENDPOINTS ───
@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(str(FRONTEND_DIR / "service-worker.js"), media_type="application/javascript")

@app.get("/history")
async def history(user_id: str, conversation_id: Optional[int] = None):
    if not user_id:
        raise HTTPException(400, detail="Missing user_id")
    return {"messages": get_history(user_id, conversation_id=conversation_id)}

@app.get("/export/{conversation_id}")
async def export_conversation(conversation_id: int, format: str = "json", user_id: str = ""):
    if not user_id:
        raise HTTPException(400, detail="Missing user_id")
    if format not in ("json", "txt"):
        raise HTTPException(400, detail="Format must be json or txt")
    msgs = get_history(user_id, conversation_id=conversation_id, limit=1000)
    if format == "json":
        return {"conversation_id": conversation_id, "exported_at": datetime.now().isoformat(), "messages": msgs}
    else:
        lines = [
            f"VEYRONIS Chat Export\n{'='*50}\n",
            f"Exported: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n",
            f"Conversation ID: {conversation_id}\n",
            f"{'='*50}\n\n"
        ]
        for m in msgs:
            lines.append(f"[{'You' if m['role'] == 'user' else 'VEYRONIS'}] {m.get('time', '')}\n{m['content']}\n\n")
        return {"content": "".join(lines), "filename": f"veyronis_chat_{conversation_id}.txt"}

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, req: Request, current_user: Optional[dict] = Depends(get_current_user_optional)):
    msg = request.message.strip()
    user_id = request.user_id.strip()
    conversation_id = request.conversation_id
    if current_user:
        user_id = current_user["email"]
        is_pro = current_user["is_pro"]
    else:
        is_pro = request.pro_code in PRO_CODES
        if not user_id:
            user_id = "u_" + str(int(time.time()))
    if msg and not check_input(msg)[0]:
        raise HTTPException(400, detail="Blocked")
    if not msg and not request.image:
        raise HTTPException(400, detail="Empty message")
    client_ip = req.client.host
    if request.mode == "canvas" and not is_pro:
        raise HTTPException(403, detail="Canvas is a Pro feature")
    if not is_pro and not check_free_limit(client_ip):
        raise HTTPException(429, detail="FREE LIMIT reached")
    if not _check_rate_limit(client_ip):
        raise HTTPException(429, detail="Rate limit exceeded")
    if not conversation_id:
        title = msg[:40] + ("..." if len(msg) > 40 else "") if msg else "Image upload"
        conversation_id = create_conversation(user_id, title=title)
    image_data_url = _b64_to_data_url(request.image) if request.image else None
    user_content = msg or "[Image uploaded for analysis]"
    save_message(user_id, "user", user_content, conversation_id=conversation_id, image_data=image_data_url)
    try:
        result = orchestrator.process_pipeline(
            msg, mode=request.mode, user_id=user_id, conversation_id=conversation_id,
            image_b64=request.image, model_mode=request.model_mode, ai_model=request.ai_model,
            custom_instructions=request.custom_instructions, response_style=request.response_style
        )
        save_message(user_id, "assistant", result["response"], conversation_id=conversation_id)
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
        raise HTTPException(500, detail=str(e))

@app.post("/chat/stream")
async def chat_stream(request: ChatRequest, req: Request, current_user: Optional[dict] = Depends(get_current_user_optional)):
    msg = request.message.strip()
    user_id = request.user_id.strip()
    conversation_id = request.conversation_id
    if current_user:
        user_id = current_user["email"]
        is_pro = current_user["is_pro"]
    else:
        is_pro = request.pro_code in PRO_CODES
        if not user_id:
            user_id = "u_" + str(int(time.time()))
    if request.mode == "canvas" and not is_pro:
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Canvas is Pro feature'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")
    client_ip = req.client.host
    has_image = request.image is not None and len(request.image) > 0
    has_text = len(msg) > 0
    if has_text and not check_input(msg)[0]:
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Blocked'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")
    if not has_text and not has_image:
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Empty'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")
    if not is_pro and not check_free_limit(client_ip):
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Free limit reached'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")
    if not _check_rate_limit(client_ip):
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Rate limit'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")
    if not conversation_id:
        title = msg[:40] + ("..." if len(msg) > 40 else "") if has_text else "Image upload"
        conversation_id = create_conversation(user_id, title=title)
    image_data_url = _b64_to_data_url(request.image) if has_image else None
    user_content = msg if has_text else "[Image uploaded for analysis]"
    save_message(user_id, "user", user_content, conversation_id=conversation_id, image_data=image_data_url)
    async def event_generator():
        full_response = ""
        effective_query = msg if has_text else ""
        try:
            for event_type, content in orchestrator.process_pipeline_stream(
                effective_query, mode=request.mode, user_id=user_id, conversation_id=conversation_id,
                image_b64=request.image if has_image else None, model_mode=request.model_mode,
                ai_model=request.ai_model, custom_instructions=request.custom_instructions,
                response_style=request.response_style
            ):
                if event_type == "token":
                    full_response += content
                    yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
                elif event_type == "reasoning" and content:
                    yield f"data: {json.dumps({'type': 'reasoning', 'content': content})}\n\n"
                elif event_type == "citations":
                    yield f"data: {json.dumps({'type': 'citations', 'content': content})}\n\n"
                elif event_type == "research_step":
                    yield f"data: {json.dumps({'type': 'research_step', 'content': content})}\n\n"
                elif event_type == "error":
                    yield f"data: {json.dumps({'type': 'error', 'content': content})}\n\n"
                    return
            yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free'})}\n\n"
            save_message(user_id, "assistant", full_response, conversation_id=conversation_id)
            if not is_pro:
                add_free_request(client_ip)
        except GeneratorExit:
            if full_response:
                save_message(user_id, "assistant", full_response, conversation_id=conversation_id)
            raise
        except Exception as e:
            print(f"[STREAM ERROR] {e}")
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/upload")
async def upload_document(file: UploadFile = File(...), user_id: str = "", conversation_id: Optional[int] = None):
    if not user_id:
        user_id = "u_auto_" + str(int(time.time()))
    content = await file.read()
    text = DocumentParser.extract_text(content, file.filename)
    gemini_analysis = None
    try:
        if Config.gemini_ready() and orchestrator.gemini_agent:
            gemini_analysis = orchestrator.gemini_agent.generate_document_response(
                content, file.filename,
                prompt="Analyze this document thoroughly. Provide a concise summary, key points, main arguments, important data, and notable sections."
            )
    except Exception as e:
        print(f"[VEYRONIS] Gemini doc analysis failed: {e}")
    if not conversation_id:
        conversation_id = create_conversation(user_id, title=file.filename)
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
        raise HTTPException(400, detail="Missing user_id")
    clear_history(user_id, conversation_id=conversation_id)
    return {"status": "Chat cleared"}

@app.get("/conversations")
async def list_conversations(user_id: str):
    if not user_id:
        raise HTTPException(400, detail="Missing user_id")
    return {"conversations": get_conversations(user_id)}

@app.post("/conversations")
async def new_conversation(req: NewConversationRequest):
    if not req.user_id:
        raise HTTPException(400, detail="Missing user_id")
    cid = create_conversation(req.user_id, req.title)
    return {"id": cid, "title": req.title}

@app.patch("/conversations/{conversation_id}")
async def patch_conversation(conversation_id: int, req: RenameRequest):
    if not req.title.strip():
        raise HTTPException(400, detail="Empty title")
    ok = rename_conversation(conversation_id, req.title.strip())
    if not ok:
        raise HTTPException(404, detail="Conversation not found")
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
        raise HTTPException(400, detail="Empty code")
    return CodeExecutor.run(code)

@app.get("/health")
async def health():
    groq_ok = bool(Config.GROQ_API_KEY)
    tavily_ok = bool(Config.TAVILY_API_KEY)
    gemini_ok = Config.gemini_ready()
    return {
        "status": "VEYRONIS is online",
        "version": "1.2-alpha",
        "models": {"groq": groq_ok, "tavily": tavily_ok, "gemini": gemini_ok},
        "timestamp": datetime.now().isoformat()
    }

@app.get("/ping")
async def ping():
    return {"message": "pong"}

@app.get("/routes")
async def routes():
    route_list = []
    for route in app.routes:
        route_list.append({"path": route.path, "methods": list(route.methods) if hasattr(route, "methods") else []})
    return {"routes": route_list}

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)