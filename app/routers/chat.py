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
    get_usage_count, increment_usage, get_db
)
from usage_cache import usage_cache
from orchestrator import CentralOrchestrator
from guardrails import check_input
from hindsight_engine import HindsightEngine
from settings import Config

from database import check_daily_quota, log_usage

_VALID_MODELS = {"deepseek", "openai", "gemini"}

def _normalize_model(model: str) -> str:
    if not model or model == "groq":
        return "deepseek"
    return model if model in _VALID_MODELS else "deepseek"

def _estimate_cost_cents(provider: str, tokens_in: int, tokens_out: int) -> float:
    rates = {
        "deepseek": (0.14, 0.28),
        "openai":   (0.15, 0.60),
        "gemini":   (0.075, 0.30),
        "qwen":     (0.80, 4.00),
    }
    r_in, r_out = rates.get(provider, (0.15, 0.60))
    return ((tokens_in / 1_000_000) * r_in + (tokens_out / 1_000_000) * r_out) * 100

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

class MoveChatReq(BaseModel):
    room_id: Optional[int] = None
    
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
        print(f"[GATE] /chat HIT user={current_user['email']} msg={request.message[:30]!r} ai_model={request.ai_model!r}")
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

        # ── NEW: per-model quota check ──
        ai_model = _normalize_model(request.ai_model)
        allowed, used, limit = check_daily_quota(user_id, ai_model, is_pro)
        if not allowed:
            if limit == 0:
                raise HTTPException(403, detail=f"🔒 {ai_model} is not available on your plan. Upgrade to PRO to unlock it.")
            raise HTTPException(429, detail=f"📊 Daily limit reached for {ai_model} ({used}/{limit}). Upgrade to PRO for more!")

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


                # ── NEW: cost logging ──
        tokens_in = max(1, len(msg) // 4)
        tokens_out = max(1, len(result["response"]) // 4)
        print(f"[GATE] /chat ABOUT TO LOG user={user_id} model={ai_model} in={tokens_in} out={tokens_out}")
        try:
            log_usage(user_id, ai_model, "chat", tokens_in, tokens_out,
                      _estimate_cost_cents(ai_model, tokens_in, tokens_out))
            print(f"[GATE] /chat LOGGED OK for {user_id}")
        except Exception as e:
            print(f"[GATE FAIL] /chat {type(e).__name__}: {e}")
            traceback.print_exc()


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
        print(f"[GATE] /chat/stream HIT user={current_user['email']} msg={request.message[:30]!r} ai_model={request.ai_model!r}")
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

        # ── NEW: per-model quota check ──
        ai_model = _normalize_model(request.ai_model)
        allowed, used, limit = check_daily_quota(user_id, ai_model, is_pro)
        if not allowed:
            err = (f"🔒 {ai_model} is not available on your plan. Upgrade to PRO."
                   if limit == 0
                   else f"📊 Daily limit reached for {ai_model} ({used}/{limit}).")
            async def quota_error():
                yield f"data: {json.dumps({'type': 'error', 'content': err})}\n\n"
            return StreamingResponse(quota_error(), media_type="text/event-stream")

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

                              # ── NEW: cost logging ──
                tokens_in = max(1, len(effective_query) // 4)
                tokens_out = max(1, len(full_response) // 4)
                print(f"[GATE] /chat/stream ABOUT TO LOG user={user_id} model={ai_model} in={tokens_in} out={tokens_out}")
                try:
                    log_usage(user_id, ai_model, "chat", tokens_in, tokens_out,
                              _estimate_cost_cents(ai_model, tokens_in, tokens_out))
                    print(f"[GATE] /chat/stream LOGGED OK for {user_id}")
                except Exception as e:
                    print(f"[GATE FAIL] /chat/stream {type(e).__name__}: {e}")
                    traceback.print_exc()


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
   
@router.patch("/chats/{chat_id}/move")
async def move_chat(chat_id: int, req: MoveChatReq, user: dict = Depends(get_current_user_required), conn = Depends(get_db)):
    cur = conn.cursor()
    
    # 1. If moving to a room, verify the user owns it
    if req.room_id is not None:
        cur.execute("SELECT id FROM rooms WHERE id=%s AND user_id=%s", (req.room_id, user["email"]))
        if not cur.fetchone(): 
            raise HTTPException(404, "Room not found")
            
    # 2. Update the chat
    cur.execute(
        "UPDATE conversations SET room_id=%s WHERE id=%s AND user_id=%s RETURNING id", 
        (req.room_id, chat_id, user["email"])
    )
    if not cur.fetchone(): 
        raise HTTPException(404, "Chat not found")
        
    conn.commit()
    return {"status": "moved", "room_id": req.room_id}