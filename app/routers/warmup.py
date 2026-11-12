"""Daily Warmup Router - Generates 3 review questions for weak concepts."""
import json
import traceback
from fastapi import APIRouter, HTTPException, Depends
from app.dependencies import get_current_user_required
from database import get_weakest_concepts
from app.providers.router import router as provider_router

router = APIRouter()

@router.get("/warmup")
async def get_daily_warmup(current_user: dict = Depends(get_current_user_required)):
    user_id = current_user["email"]
    
    try:
        weak_concepts = get_weakest_concepts(user_id, limit=3)
        if not weak_concepts:
            return {"status": "no_weak_concepts", "questions": []}
            
        provider = provider_router.get_provider(task_type="daily_warmup", user_context=current_user)
        concept_list = ", ".join([f"{c['concept']} ({c['subject']})" for c in weak_concepts])
        
        prompt = f"""
        The student needs a quick warmup review on these concepts: {concept_list}.
        Generate exactly 3 short, simple questions (one for each concept) to test their basic understanding.
        Return ONLY a valid JSON array of strings, like this: ["Question 1", "Question 2", "Question 3"]. No markdown formatting.
        """
        
        messages = [{"role": "user", "content": prompt}]
        result = provider.generate(messages)
        
        raw_text = result["text"].strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text.replace("```json", "").replace("```", "").strip()
            
        questions = json.loads(raw_text)
        return {"status": "success", "questions": questions, "concepts": weak_concepts}
        
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="Failed to generate daily warmup.")