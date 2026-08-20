"""JWT Authentication module for VEYRONIS."""
from datetime import datetime, timedelta
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import HTTPException, Depends, status
from fastapi.security import OAuth2PasswordBearer
from typing import Optional
from database import get_user_by_id
import os

# Configuration
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "veyronis-super-secret-key-change-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a hashed password."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    """Hash a password using bcrypt."""
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> Optional[dict]:
    """Decode and verify a JWT token."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


def get_current_user(token: str = Depends(oauth2_scheme)):
    """Get current user from JWT token. Raises 401 if invalid."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if token is None:
        raise credentials_exception
    
    payload = decode_token(token)
    if payload is None:
        raise credentials_exception
    
    user_id = payload.get("sub")
    if user_id is None:
        raise credentials_exception
    
    user = get_user_by_id(int(user_id))
    if user is None:
        raise credentials_exception
    
    return {
        "id": user["id"],
        "email": user["email"],
        "is_pro": bool(user["is_pro"])
    }


def get_current_user_optional(token: Optional[str] = Depends(oauth2_scheme)):
    """Get current user from JWT token. Returns None if not authenticated."""
    if token is None:
        return None
    try:
        payload = decode_token(token)
        if payload is None:
            return None
        user_id = payload.get("sub")
        if user_id is None:
            return None
        user = get_user_by_id(int(user_id))
        if user is None:
            return None
        return {
            "id": user["id"],
            "email": user["email"],
            "is_pro": bool(user["is_pro"])
        }
    except Exception:
        return None