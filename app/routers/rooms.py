"""Rooms (Classrooms) API"""
import traceback
import json  # <--- ADD THIS
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

from app.dependencies import get_current_user_required
from database import (
    create_room, get_user_rooms, save_room_message, get_room_history, 
    get_db 
)
from app.providers.router import router as provider_router

class NoteReq(BaseModel):
    slot: int
    title: str
    content: str
    
router = APIRouter()

class CreateRoomRequest(BaseModel):
    name: str
    subject: str
    goal: str = ""

class RoomMessageRequest(BaseModel):
    message: str

@router.post("/rooms")
async def new_room(req: CreateRoomRequest, current_user: dict = Depends(get_current_user_required)):
    user_id = current_user["email"]
    try:
        room_id = create_room(user_id, req.name, req.subject, req.goal)
        return {"room_id": room_id, "message": "Room created successfully."}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Failed to create room.")

@router.get("/rooms")
async def list_rooms(current_user: dict = Depends(get_current_user_required)):
    try:
        rooms = get_user_rooms(current_user["email"])
        return {"rooms": rooms}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Failed to fetch rooms.")

@router.post("/rooms/{room_id}/chat")
async def room_chat(room_id: int, req: RoomMessageRequest, current_user: dict = Depends(get_current_user_required)):
    user_id = current_user["email"]
    try:
        # 1. Save user message
        save_room_message(room_id, "user", req.message)
        
        # 2. Get room history for context
        history = get_room_history(room_id)
        
        # 3. Select AI Provider (Free=Qwen, Pro=DeepSeek)
        provider = provider_router.get_provider(task_type="chat", user_context=current_user)
        
        # 4. System prompt specifically for Classrooms
        system_prompt = (
            "You are a Veyronis Study Assistant inside a dedicated Classroom. "
            "Help the student understand the material, answer their questions clearly, "
            "and keep your answers educational and encouraging."
        )
        
        messages = [{"role": "system", "content": system_prompt}] + history
        
        # 5. Generate response
        ai_response = provider.generate(messages)
        
        # 6. Save AI response
        save_room_message(room_id, "assistant", ai_response)
        
        return {"response": ai_response}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Room chat failed.")

@router.post("/rooms/{room_id}/notes")
async def save_note(room_id: int, req: NoteReq, user=Depends(get_current_user_required), conn=Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT notes FROM rooms WHERE id=%s AND user_id=%s", (room_id, user["email"]))
    row = cur.fetchone()
    if not row: 
        raise HTTPException(404, "Room not found")
    
    notes = row["notes"] or []
    # Overwrite the specific slot if it already exists
    notes = [n for n in notes if n["slot"] != req.slot] 
    notes.append(req.dict())
    
    # Check 15k character limit
    if sum(len(n["content"]) + len(n["title"]) for n in notes) > 15000:
        raise HTTPException(400, "Total notes exceed 15,000 character limit")
        
    cur.execute("UPDATE rooms SET notes=%s WHERE id=%s", (json.dumps(notes), room_id))
    conn.commit()
    return {"status": "saved", "notes": notes}

@router.delete("/rooms/{room_id}/notes/{slot}")
async def del_note(room_id: int, slot: int, user=Depends(get_current_user_required), conn=Depends(get_db)):
    cur = conn.cursor()
    cur.execute("SELECT notes FROM rooms WHERE id=%s AND user_id=%s", (room_id, user["email"]))
    row = cur.fetchone()
    if not row: 
        raise HTTPException(404, "Room not found")
    
    notes = [n for n in (row["notes"] or []) if n["slot"] != slot]
    cur.execute("UPDATE rooms SET notes=%s WHERE id=%s", (json.dumps(notes), room_id))
    conn.commit()
    return {"status": "deleted"}