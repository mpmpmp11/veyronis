"""Shared dependencies for FastAPI routes."""
from fastapi import Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordBearer
from typing import Optional
from jose import JWTError, jwt
from settings import Config
from database import get_user_by_id

SECRET_KEY = Config.JWT_SECRET_KEY
ALGORITHM = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)

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

def get_current_user_required(token: str = Depends(oauth2_scheme)):
    if token is None:
        raise HTTPException(401, detail="🔒 Please log in to continue.")
    payload = decode_token(token)
    if payload is None:
        raise HTTPException(401, detail="🔒 Invalid session. Please log in again.")
    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(401, detail="🔒 Invalid session. Please log in again.")
    user = get_user_by_id(int(user_id))
    if user is None:
        raise HTTPException(401, detail="🔒 User not found. Please log in again.")
    if user.get("is_banned", False):
        raise HTTPException(403, detail="🚫 Your account has been banned. Contact support.")
    return {"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"])}

async def get_current_user_from_token_or_query(request: Request, token: Optional[str] = None):
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
    if not token:
        token = request.query_params.get("token")
    if not token:
        raise HTTPException(401, detail="Missing authentication token")
    payload = decode_token(token)
    if not payload:
        raise HTTPException(401, detail="Invalid token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, detail="Invalid token")
    user = get_user_by_id(int(user_id))
    if not user:
        raise HTTPException(401, detail="User not found")
    if user.get("is_banned", False):
        raise HTTPException(403, detail="Account banned")
    return {"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"])}