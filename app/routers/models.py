from fastapi import APIRouter, Depends
from app.dependencies import get_current_user_required

router = APIRouter()

@router.get("/models")
async def get_available_models(current_user: dict = Depends(get_current_user_required)):
    is_pro = current_user["is_pro"]
    
    models = [
        {"id": "deepseek", "name": "DeepSeek V3", "limit": "unlimited" if is_pro else "20/day"}
    ]
    
    if is_pro:
        models.extend([
            {"id": "gemini", "name": "Gemini 2.5 Flash", "limit": "35/day"},
            {"id": "openai", "name": "GPT-4o", "limit": "15/day"}
        ])
        
    return {"models": models}