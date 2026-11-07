"""Tutor Mode Engine - State Machine & Pedagogy"""
import traceback
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional

from app.dependencies import get_current_user_required
from database import (
    create_tutor_session, save_tutor_message, get_tutor_history, update_mastery
)
from orchestrator import CentralOrchestrator

router = APIRouter()
orchestrator = CentralOrchestrator()

class StartTutorRequest(BaseModel):
    subject: str
    goal: str
    level: str = "beginner"

class TutorMessageRequest(BaseModel):
    message: str
    is_answer: bool = False
    is_correct: Optional[bool] = None

@router.post("/tutor/start")
async def start_tutor(req: StartTutorRequest, current_user: dict = Depends(get_current_user_required)):
    user_id = current_user["email"]
    try:
        session_id = create_tutor_session(user_id, req.subject, req.goal, req.level)
        
        # The initial system prompt for the tutor
        system_prompt = (
            f"You are a Veyronis Tutor. The student wants to learn {req.subject}. "
            f"Their goal is: {req.goal}. Their level is: {req.level}. "
            "Start by asking them a calibration question to see what they already know. "
            "Do NOT give them the answer directly. Guide them."
        )
        
        # We save a system message to establish context
        save_tutor_message(session_id, "system", system_prompt, "system")
        
        # Ask the AI to generate the first calibration message
        first_message = orchestrator.groq_agent.generate_response(
            prompt="Start the session. Ask me a calibration question.",
            system_context=system_prompt
        )
        
        save_tutor_message(session_id, "tutor", first_message, "explanation")
        
        return {
            "session_id": session_id,
            "message": first_message,
            "state": "calibrate"
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Failed to start tutor session.")

@router.post("/tutor/{session_id}/message")
async def tutor_message(
    session_id: int, 
    req: TutorMessageRequest, 
    current_user: dict = Depends(get_current_user_required)
):
    user_id = current_user["email"]
    try:
        # Save the student's message
        save_tutor_message(session_id, "student", req.message, "chat")
        
        # If it's an answer to a problem, update mastery
        if req.is_answer and req.is_correct is not None:
            # We would ideally extract the concept dynamically, but for now we use a placeholder
            update_mastery(user_id, "general", "current_topic", req.is_correct)
        
        # Fetch history for context
        history = get_tutor_history(session_id)
        
        # Extract system prompt
        system_prompt = next((m["content"] for m in history if m["role"] == "system"), "")
        
        # Get AI response
        ai_response = orchestrator.groq_agent.generate_response(
            prompt=req.message,
            system_context=system_prompt,
            history=[m for m in history if m["role"] != "system"]
        )
        
        save_tutor_message(session_id, "tutor", ai_response, "explanation")
        
        return {
            "message": ai_response,
            "state": "teaching"
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Tutor failed to respond.")