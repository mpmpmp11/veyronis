"""Authentication and User management routes."""
import hashlib
import bcrypt
import secrets
import traceback
from jose import jwt
from fastapi import APIRouter, HTTPException, Request, Depends
from datetime import datetime, timedelta, date
from pydantic import BaseModel

from app.dependencies import get_current_user_required
from settings import Config
from database import (
    create_user, get_user_by_email, get_user_by_id, delete_user,
    set_verification_token, get_usage_count, get_upload_counts
)
from usage_cache import usage_cache
from email_service import send_verification_email

router = APIRouter()

# ─── PYDANTIC MODELS ───
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

# ─── HELPERS ───
def verify_password(plain: str, hashed: str) -> bool:
    pwd_hash = hashlib.sha256(plain.encode()).hexdigest()
    return bcrypt.checkpw(pwd_hash.encode("utf-8"), hashed.encode("utf-8"))

def get_password_hash(password: str) -> str:
    pwd_hash = hashlib.sha256(password.encode()).hexdigest()
    return bcrypt.hashpw(pwd_hash.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")

def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=60*24*7)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, Config.JWT_SECRET_KEY, algorithm="HS256")

# ─── ROUTES ───
@router.post("/register")
async def register(req: RegisterRequest, request: Request):
    try:
        if "@" not in req.email or "." not in req.email:
            raise HTTPException(400, detail="📧 Please enter a valid email address.")
        if len(req.password) < 6:
            raise HTTPException(400, detail="🔑 Password must be at least 6 characters.")
        existing = get_user_by_email(req.email)
        if existing:
            raise HTTPException(400, detail="📧 This email is already registered. Please log in instead.")
        
        hashed = get_password_hash(req.password)
        user_id = create_user(req.email, hashed)
        token = create_access_token({"sub": str(user_id)})

        if Config.email_ready():
            verification_token = secrets.token_urlsafe(32)
            expires = datetime.utcnow() + timedelta(hours=24)
            set_verification_token(req.email, verification_token, expires)
            send_verification_email(req.email, verification_token, Config.APP_BASE_URL)

        user = get_user_by_id(user_id)
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user_id, "email": req.email, "is_pro": False, "display_id": user.get("display_id") if user else None, "full_name": user.get("full_name") if user else None}
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Registration failed. Please try again.")

@router.post("/login")
async def login(req: LoginRequest, request: Request):
    try:
        user = get_user_by_email(req.email)
        if not user or not verify_password(req.password, user["hashed_password"]):
            raise HTTPException(400, detail="🔐 Invalid email or password.")
        if user.get("is_banned", False):
            raise HTTPException(403, detail="🚫 Your account has been banned. Contact support.")
            
        token = create_access_token({"sub": str(user["id"])})
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"]), "display_id": user.get("display_id"), "full_name": user.get("full_name")}
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Login failed. Please try again.")

@router.get("/me")
async def get_me(current_user: dict = Depends(get_current_user_required)):
    try:
        user = get_user_by_id(current_user["id"])
        today = str(date.today())
        usage = usage_cache.get(current_user["email"]) if not user["is_pro"] else None
        remaining = max(0, 20 - usage) if usage is not None else None

        now = datetime.utcnow()
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        reset_at_iso = tomorrow.isoformat() + "Z"

        upload_counts = {"images": 0, "docs": 0}
        if not user["is_pro"]:
            upload_counts = get_upload_counts(current_user["email"], today)

        return {
            "user": {
                "id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"]),
                "avatar_url": user.get("avatar_url"), "usage": usage, "remaining": remaining,
                "is_verified": bool(user.get("is_verified", False)), "display_id": user.get("display_id"),
                "full_name": user.get("full_name"), "reset_at": reset_at_iso, "uploads_today": upload_counts,
            }
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Could not retrieve user info. Please try again.")

@router.delete("/account")
async def delete_account(current_user: dict = Depends(get_current_user_required)):
    success = delete_user(current_user["id"])
    if not success:
        raise HTTPException(500, detail="😕 Failed to delete account. Please try again.")
    return {"message": "🗑️ Account deleted successfully"}