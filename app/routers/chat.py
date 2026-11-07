"""Chat, Conversation, and History routes."""
import json
import time
import traceback
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import date

from app.dependencies import get_current_user_required, get_current_user_optional
from database import (
    save_message, get_history, clear_history, create_conversation, 
    get_conversations, rename_conversation, delete_conversation,
    get_archived_conversations, archive_conversation, unarchive_conversation,
    get_usage_count, increment_usage
)
from usage_cache import usage_cache
from orchestrator import CentralOrchestrator
from guardrails import check_input
from hindsight_engine import HindsightEngine
from settings import Config

router = APIRouter()
orchestrator = CentralOrchestrator()
hindsight_engine = HindsightEngine()

# ─── PYDANTIC MODELS ───
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
    voice_mode: bool = False
    external_id: Optional[str] = None

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

# ─── ROUTES ───
@router.get("/history")
async def history(
    user_id: str,
    conversation_id: Optional[int] = None,
    current_user: dict = Depends(get_current_user_required)
):
    if user_id != current_user["email"]:
        raise HTTPException(403, detail="🔒 Access denied.")
    try:
        return {"messages": get_history(user_id, conversation_id=conversation_id)}
    except Exception as e:
        print(f"[HISTORY ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not retrieve history. Please try again.")

@router.get("/conversations")
async def list_conversations(
    user_id: str,
    current_user: dict = Depends(get_current_user_required)
):
    if user_id != current_user["email"]:
        raise HTTPException(403, detail="🔒 Access denied.")
    try:
        return {"conversations": get_conversations(user_id)}
    except Exception as e:
        print(f"[CONVERSATIONS ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not load conversations. Please try again.")

@router.post("/conversations")
async def new_conversation(
    req: NewConversationRequest,
    current_user: dict = Depends(get_current_user_required)
):
    if req.user_id != current_user["email"]:
        raise HTTPException(403, detail="🔒 Access denied.")
    try:
        cid = create_conversation(req.user_id, req.title)
        return {"id": cid, "title": req.title}
    except Exception as e:
        print(f"[NEW CONV ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not create conversation. Please try again.")

@router.patch("/conversations/{conversation_id}")
async def patch_conversation(
    conversation_id: int,
    req: RenameRequest,
    current_user: dict = Depends(get_current_user_required)
):
    convs = get_conversations(current_user["email"], include_archived=True)
    if not any(c["id"] == conversation_id for c in convs):
        raise HTTPException(403, detail="🔒 Access denied.")
    if not req.title.strip():
        raise HTTPException(400, detail="📝 Title cannot be empty.")
    try:
        ok = rename_conversation(conversation_id, req.title.strip())
        if not ok:
            raise HTTPException(404, detail="🔍 Conversation not found.")
        return {"status": "renamed"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[RENAME ERROR] {e}")
        raise HTTPException(500, detail="😕 Rename failed. Please try again.")

@router.delete("/conversations/{conversation_id}")
async def remove_conversation(
    conversation_id: int,
    current_user: dict = Depends(get_current_user_required)
):
    convs = get_conversations(current_user["email"], include_archived=True)
    if not any(c["id"] == conversation_id for c in convs):
        raise HTTPException(403, detail="🔒 Access denied.")
    try:
        delete_conversation(conversation_id)
        return {"status": "deleted"}
    except Exception as e:
        print(f"[DELETE CONV ERROR] {e}")
        raise HTTPException(500, detail="😕 Delete failed. Please try again.")

@router.patch("/conversations/{conversation_id}/archive")
async def archive_conv_endpoint(
    conversation_id: int,
    current_user: dict = Depends(get_current_user_required)
):
    convs = get_conversations(current_user["email"], include_archived=True)
    if not any(c["id"] == conversation_id for c in convs):
        raise HTTPException(403, detail="🔒 Access denied.")
    ok = archive_conversation(conversation_id, current_user["email"])
    if not ok:
        raise HTTPException(404, detail="🔍 Conversation not found.")
    return {"status": "archived"}

@router.patch("/conversations/{conversation_id}/unarchive")
async def unarchive_conv_endpoint(
    conversation_id: int,
    current_user: dict = Depends(get_current_user_required)
):
    convs = get_conversations(current_user["email"], include_archived=True)
    if not any(c["id"] == conversation_id for c in convs):
        raise HTTPException(403, detail="🔒 Access denied.")
    ok = unarchive_conversation(conversation_id, current_user["email"])
    if not ok:
        raise HTTPException(404, detail="🔍 Conversation not found.")
    return {"status": "unarchived"}

@router.get("/conversations/archived")
async def list_archived_conversations(
    current_user: dict = Depends(get_current_user_required)
):
    try:
        return {"conversations": get_archived_conversations(current_user["email"])}
    except Exception as e:
        print(f"[ARCHIVED CONV ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not load archived conversations. Please try again.")

@router.post("/clear")
async def clear_chat(
    request: Request,
    current_user: dict = Depends(get_current_user_required)
):
    data = await request.json()
    user_id = data.get("user_id", "")
    conversation_id = data.get("conversation_id")
    if user_id != current_user["email"]:
        raise HTTPException(403, detail="🔒 Access denied.")
    try:
        clear_history(user_id, conversation_id=conversation_id)
        return {"status": "Chat cleared"}
    except Exception as e:
        print(f"[CLEAR ERROR] {e}")
        raise HTTPException(500, detail="😕 Clear failed. Please try again.")

@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    req: Request,
    current_user: dict = Depends(get_current_user_required)
):
    try:
        msg = request.message.strip()
        conversation_id = request.conversation_id

        client_ip = req.client.host
        user_id = current_user["email"]
        is_pro  = current_user["is_pro"]

        today = str(date.today())
        if not is_pro:
            usage = usage_cache.get(user_id)
            if usage >= 20:
                raise HTTPException(429, detail="📊 You've reached your daily limit (20 messages). Upgrade to PRO for unlimited!")

        if request.mode == "simulation":
            if not msg:
                raise HTTPException(400, detail="📝 Please enter a scenario to simulate.")
            try:
                result, status = hindsight_engine.run(user_id, msg, is_pro=is_pro)
                if not conversation_id:
                    title = msg[:40] + ("..." if len(msg) > 40 else "")
                    conversation_id = create_conversation(user_id, title=title)
                save_message(user_id, "user", f"🔮 {msg}", conversation_id=conversation_id)
                save_message(user_id, "assistant", result.model_dump_json(), conversation_id=conversation_id)
                if not is_pro:
                    usage_cache.increment(user_id)
                return ChatResponse(
                    response=result.model_dump_json(),
                    tier="pro" if is_pro else "free",
                    conversation_id=conversation_id,
                    reasoning=f"Simulated {len(result.timeline)} steps"
                )
            except RuntimeError as e:
                raise HTTPException(429, detail=str(e))
            except Exception as e:
                print(f"[HINDSIGHT ERROR] {e}")
                traceback.print_exc()
                raise HTTPException(500, detail="😕 Simulation failed. Please try again.")

        if msg and not check_input(msg)[0]:
            raise HTTPException(400, detail="⛔ Blocked.")
        if not msg and not request.image:
            raise HTTPException(400, detail="✏️ Please enter a message.")
        if request.mode == "canvas" and not is_pro:
            raise HTTPException(403, detail="🎨 Canvas is a Pro feature. Upgrade to use it.")

        if not conversation_id:
            title = msg[:40] + ("..." if len(msg) > 40 else "") if msg else "Image upload"
            conversation_id = create_conversation(user_id, title=title)
        image_data_url = None # Simplification for this route
        user_content = msg or "[Image uploaded for analysis]"
        save_message(user_id, "user", user_content, conversation_id=conversation_id, image_data=image_data_url)

        result = orchestrator.process_pipeline(
            msg, mode=request.mode, user_id=user_id, conversation_id=conversation_id,
            image_b64=request.image, model_mode=request.model_mode, ai_model=request.ai_model,
            custom_instructions=request.custom_instructions, response_style=request.response_style,
            voice_mode=request.voice_mode
        )
        save_message(user_id, "assistant", result["response"], conversation_id=conversation_id, external_id=request.external_id)
        if not is_pro:
            usage_cache.increment(user_id)
        return ChatResponse(
            response=result["response"],
            tier="pro" if is_pro else "free",
            conversation_id=conversation_id,
            reasoning=result.get("reasoning"),
            citations=result.get("citations")
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CHAT ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Chat failed. Please try again.")

@router.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    req: Request,
    current_user: dict = Depends(get_current_user_required)
):
    try:
        msg = request.message.strip()
        conversation_id = request.conversation_id
        client_ip = req.client.host
        user_id = current_user["email"]
        is_pro  = current_user["is_pro"]

        today = str(date.today())
        if not is_pro:
            usage = usage_cache.get(user_id)
            if usage >= 20:
                async def limit_error():
                    yield f"data: {json.dumps({'type': 'error', 'content': '📊 You\'ve reached your daily limit (20 messages). Upgrade to PRO for unlimited!'})}\n\n"
                return StreamingResponse(limit_error(), media_type="text/event-stream")

        has_image = request.image is not None and len(request.image) > 0
        has_text = len(msg) > 0
        if has_text and not check_input(msg)[0]:
            async def err_gen():
                yield f"data: {json.dumps({'type': 'error', 'content': '⛔ Blocked'})}\n\n"
            return StreamingResponse(err_gen(), media_type="text/event-stream")

        if not conversation_id:
            title = msg[:40] + ("..." if len(msg) > 40 else "") if has_text else "Image upload"
            conversation_id = create_conversation(user_id, title=title)
        
        user_content = msg if has_text else "[Image uploaded for analysis]"
        save_message(user_id, "user", user_content, conversation_id=conversation_id)

        async def event_generator():
            full_response = ""
            effective_query = msg if has_text else ""

            if request.mode == "simulation":
                try:
                    yield f"data: {json.dumps({'type': 'reasoning', 'content': '🔮 Running Hindsight simulation...'})}\n\n"
                    result, status = hindsight_engine.run(user_id, effective_query, is_pro=is_pro)
                    json_output = result.model_dump_json()
                    yield f"data: {json.dumps({'type': 'token', 'content': json_output})}\n\n"
                    yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free'})}\n\n"
                    save_message(user_id, "assistant", json_output, conversation_id=conversation_id)
                    if not is_pro:
                        usage_cache.increment(user_id)
                    return
                except Exception as e:
                    print(f"[STREAM SIM ERROR] {e}")
                    yield f"data: {json.dumps({'type': 'error', 'content': '😕 Simulation failed. Please try again.'})}\n\n"
                    return

            try:
                for event_type, content in orchestrator.process_pipeline_stream(
                    effective_query, mode=request.mode, user_id=user_id, conversation_id=conversation_id,
                    image_b64=request.image if has_image else None, model_mode=request.model_mode,
                    ai_model=request.ai_model, custom_instructions=request.custom_instructions,
                    response_style=request.response_style, voice_mode=request.voice_mode
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
                        yield f"data: {json.dumps({'type': 'error', 'content': '😕 An error occurred. Please try again.'})}\n\n"
                        return

                new_msg_id = save_message(user_id, "assistant", full_response, conversation_id=conversation_id, external_id=request.external_id)
                yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free', 'message_id': new_msg_id})}\n\n"

                if not is_pro:
                    usage_cache.increment(user_id)

            except GeneratorExit:
                if full_response:
                    save_message(user_id, "assistant", full_response, conversation_id=conversation_id)
                raise
            except Exception as e:
                print(f"[STREAM ERROR] {e}")
                traceback.print_exc()
                yield f"data: {json.dumps({'type': 'error', 'content': '😕 Stream failed. Please try again.'})}\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    except Exception as e:
        print(f"[STREAM SETUP ERROR] {e}")
        async def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'content': '🔧 Service temporarily unavailable. Please try again.'})}\n\n"
        return StreamingResponse(err_gen(), media_type="text/event-stream")