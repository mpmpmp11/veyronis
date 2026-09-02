"""VEYRONIS API Server — Production Hardened + Cloudinary + Email + Admin + Feedback."""
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, RedirectResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, date
from jose import JWTError, jwt
import hashlib
import bcrypt
import secrets
from orchestrator import CentralOrchestrator
from guardrails import check_input
from tools.document_parser import DocumentParser
from tools.code_executor import CodeExecutor
from database import (
    save_message, get_history, clear_history,
    create_conversation, get_conversations, rename_conversation,
    delete_conversation,
    create_user, get_user_by_email, get_user_by_id, set_user_pro,
    get_usage_count, increment_usage,
    delete_user, get_user_by_verification_token, verify_user,
    set_verification_token, set_reset_token, get_user_by_reset_token,
    clear_reset_token, get_db,
    save_attachment, get_attachments,
    get_archived_conversations, archive_conversation, unarchive_conversation,
)
from settings import Config
import base64
import uvicorn
import json
import time
import traceback
from fastapi.responses import Response

# Cloudinary
import cloudinary
import cloudinary.uploader

# Email
from email_service import send_reset_email, send_verification_email, send_feedback_email

# Hindsight imports
from hindsight_engine import HindsightEngine

# Google OAuth imports
from auth import get_google_auth_url, handle_google_callback

# ─── CONFIGURE CLOUDINARY ───
if Config.cloudinary_ready():
    cloudinary.config(
        cloud_name=Config.CLOUDINARY_CLOUD_NAME,
        api_key=Config.CLOUDINARY_API_KEY,
        api_secret=Config.CLOUDINARY_API_SECRET
    )
    print("[VEYRONIS] Cloudinary configured successfully")
else:
    print("[VEYRONIS] Cloudinary not configured — uploads will use local storage")

# ─── JWT SETUP ───
Config.validate_jwt()
SECRET_KEY = Config.JWT_SECRET_KEY
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login", auto_error=False)

def verify_password(plain: str, hashed: str) -> bool:
    pwd_hash = hashlib.sha256(plain.encode()).hexdigest()
    return bcrypt.checkpw(pwd_hash.encode("utf-8"), hashed.encode("utf-8"))

def get_password_hash(password: str) -> str:
    pwd_hash = hashlib.sha256(password.encode()).hexdigest()
    return bcrypt.hashpw(pwd_hash.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")

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

# ─── PATH SETUP ───
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="VEYRONIS API")

# ─── HTTPS REDIRECT MIDDLEWARE ───
@app.middleware("http")
async def https_redirect_middleware(request: Request, call_next):
    forwarded_proto = request.headers.get("x-forwarded-proto")
    host = request.headers.get("host", "")
    if forwarded_proto == "http" and ("onrender.com" in host or "railway.app" in host):
        https_url = f"https://{host}{request.url.path}"
        if request.url.query:
            https_url += f"?{request.url.query}"
        return RedirectResponse(https_url, status_code=301)
    return await call_next(request)

# ─── CORS — Restricted ───
ALLOWED_ORIGINS = [
    "http://localhost:8000",
    "http://localhost:3000",
    "http://127.0.0.1:8000",
    "https://veyronis.onrender.com",
    "https://veyronis-production.up.railway.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

orchestrator = CentralOrchestrator()
hindsight_engine = HindsightEngine()

limits_file = BASE_DIR / "daily_limits.json"

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
    pro_code: str = ""  # kept for backward compatibility but ignored
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
async def register(req: RegisterRequest, request: Request):
    client_ip = request.client.host
    if not _check_rate_limit(client_ip, max_requests=3, window_seconds=300):
        raise HTTPException(429, detail="⏳ Too many registration attempts. Please try again later.")

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

        # Send verification email
        if Config.email_ready():
            verification_token = secrets.token_urlsafe(32)
            expires = datetime.utcnow() + timedelta(hours=24)
            set_verification_token(req.email, verification_token, expires)
            base_url = Config.APP_BASE_URL
            success = send_verification_email(req.email, verification_token, base_url)
            if not success:
                print(f"[VEYRONIS] Verification email failed to send for {req.email}")

        # Fetch user to get display_id
        user = get_user_by_id(user_id)
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user_id, "email": req.email, "is_pro": False, "display_id": user.get("display_id") if user else None}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[REGISTER ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Registration failed. Please try again.")

@app.post("/login")
async def login(req: LoginRequest, request: Request):
    client_ip = request.client.host
    if not _check_rate_limit(client_ip, max_requests=5, window_seconds=60):
        raise HTTPException(429, detail="⏳ Too many login attempts. Please try again later.")

    try:
        user = get_user_by_email(req.email)
        if not user:
            raise HTTPException(400, detail="🔐 Invalid email or password.")
        if not verify_password(req.password, user["hashed_password"]):
            raise HTTPException(400, detail="🔐 Invalid email or password.")
        if user.get("is_banned", False):
            raise HTTPException(403, detail="🚫 Your account has been banned. Contact support.")
        token = create_access_token({"sub": str(user["id"])})
        return TokenResponse(
            access_token=token,
            token_type="bearer",
            user={"id": user["id"], "email": user["email"], "is_pro": bool(user["is_pro"]), "display_id": user.get("display_id")}
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[LOGIN ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Login failed. Please try again.")

@app.get("/me")
async def get_me(current_user: dict = Depends(get_current_user_required)):
    try:
        user = get_user_by_id(current_user["id"])
        today = str(date.today())
        usage = get_usage_count(current_user["email"], today) if not user["is_pro"] else None
        remaining = max(0, 20 - usage) if usage is not None else None
        return {
            "user": {
                "id": user["id"],
                "email": user["email"],
                "is_pro": bool(user["is_pro"]),
                "avatar_url": user.get("avatar_url"),
                "usage": usage,
                "remaining": remaining,
                "is_verified": bool(user.get("is_verified", False)),
                "display_id": user.get("display_id")
            }
        }
    except Exception as e:
        print(f"[ME ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not retrieve user info. Please try again.")

@app.post("/upgrade")
async def upgrade_to_pro(current_user: dict = Depends(get_current_user_required)):
    try:
        set_user_pro(current_user["id"], True)
        return {"message": "✅ Upgraded to PRO", "is_pro": True}
    except Exception as e:
        print(f"[UPGRADE ERROR] {e}")
        raise HTTPException(500, detail="😕 Upgrade failed. Please try again.")

# ─── ACCOUNT DELETION ───
@app.delete("/account")
async def delete_account(current_user: dict = Depends(get_current_user_required)):
    user_id = current_user["id"]
    success = delete_user(user_id)
    if not success:
        raise HTTPException(500, detail="😕 Failed to delete account. Please try again.")
    return {"message": "🗑️ Account deleted successfully"}

# ─── FORGOT PASSWORD ───

@app.post("/forgot-password")
async def forgot_password(request: Request):
    if not Config.email_ready():
        return {"message": "📧 If this email exists, a reset link has been sent."}

    try:
        data = await request.json()
        email = data.get("email", "").strip()
        if not email:
            raise HTTPException(400, detail="📝 Email is required.")

        user = get_user_by_email(email)
        if not user:
            return {"message": "📧 If this email exists, a reset link has been sent."}

        token = secrets.token_urlsafe(32)
        expires = datetime.utcnow() + timedelta(hours=1)
        set_reset_token(email, token, expires)

        base_url = Config.APP_BASE_URL
        success = send_reset_email(email, token, base_url)
        if not success:
            print(f"[FORGOT PASSWORD] Failed to send email to {email}")
        return {"message": "📧 If this email exists, a reset link has been sent."}
    except Exception as e:
        print(f"[FORGOT PASSWORD ERROR] {e}")
        return {"message": "📧 If this email exists, a reset link has been sent."}

@app.post("/reset-password")
async def reset_password(request: Request):
    try:
        data = await request.json()
        token = data.get("token", "").strip()
        new_password = data.get("new_password", "").strip()

        if not token or not new_password:
            raise HTTPException(400, detail="📝 Token and new password are required.")
        if len(new_password) < 6:
            raise HTTPException(400, detail="🔑 Password must be at least 6 characters.")

        user = get_user_by_reset_token(token)
        if not user:
            raise HTTPException(400, detail="🔗 Invalid or expired reset link. Please request a new one.")

        hashed = get_password_hash(new_password)
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET hashed_password = %s WHERE id = %s", (hashed, user["id"]))
        cursor.execute("UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = %s", (user["id"],))
        conn.commit()
        conn.close()

        return {"message": "✅ Password reset successfully. Please log in."}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[RESET PASSWORD ERROR] {e}")
        raise HTTPException(500, detail="😕 Failed to reset password. Please try again.")

# ─── EMAIL VERIFICATION ───

@app.get("/verify-email")
async def verify_email(token: str):
    """Redirects to frontend with token in URL hash."""
    return RedirectResponse(f"{Config.APP_BASE_URL}/#email-verified?token={token}")

@app.get("/api/verify-email")
async def api_verify_email(token: str):
    """JSON endpoint for frontend to verify email."""
    user = get_user_by_verification_token(token)
    if not user:
        raise HTTPException(400, detail="Invalid or expired verification link.")
    verify_user(user["email"])
    return {"success": True, "email": user["email"]}

# ─── GOOGLE OAUTH ───

@app.get("/auth/google")
async def google_login(request: Request):
    if not Config.google_oauth_ready():
        raise HTTPException(503, detail="🔧 Google OAuth is not configured.")

    forwarded_host = request.headers.get("x-forwarded-host")
    forwarded_proto = request.headers.get("x-forwarded-proto", "http")

    if forwarded_host:
        base_url = f"{forwarded_proto}://{forwarded_host}"
    else:
        base_url = str(request.base_url).rstrip("/")

    redirect_uri = f"{base_url}/auth/google/callback"
    auth_url = get_google_auth_url(redirect_uri)
    return RedirectResponse(auth_url)

@app.get("/auth/google/callback")
async def google_callback(code: str, request: Request):
    if not Config.google_oauth_ready():
        raise HTTPException(503, detail="🔧 Google OAuth is not configured.")

    forwarded_host = request.headers.get("x-forwarded-host")
    forwarded_proto = request.headers.get("x-forwarded-proto", "http")

    if forwarded_host:
        base_url = f"{forwarded_proto}://{forwarded_host}"
    else:
        base_url = str(request.base_url).rstrip("/")

    redirect_uri = f"{base_url}/auth/google/callback"

    try:
        result = await handle_google_callback(code, redirect_uri)
        frontend_url = (
            f"{base_url}/#auth=success"
            f"&token={result['access_token']}"
            f"&user={result['user']['email']}"
            f"&is_pro={result['user']['is_pro']}"
            f"&name={result['user']['name']}"
            f"&avatar={result['user']['avatar_url']}"
        )
        return RedirectResponse(frontend_url)
    except Exception as e:
        print(f"[GOOGLE CALLBACK ERROR] {e}")
        frontend_url = f"{base_url}/#auth=error&message={str(e)}"
        return RedirectResponse(frontend_url)

# ─── PROTECTED ENDPOINTS ───

@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(str(FRONTEND_DIR / "service-worker.js"), media_type="application/javascript")

@app.get("/favicon.ico")
async def favicon():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#8b5cf6"/><text x="50" y="68" font-size="50" text-anchor="middle" fill="white" font-weight="bold">V</text></svg>"""
    return Response(content=svg, media_type="image/svg+xml")

@app.get("/privacy")
async def privacy_policy():
    file_path = FRONTEND_DIR / "privacy.html"
    if not file_path.exists():
        raise HTTPException(404, detail="Privacy Policy page not found")
    return FileResponse(str(file_path), media_type="text/html")

@app.get("/terms")
async def terms_of_service():
    file_path = FRONTEND_DIR / "terms.html"
    if not file_path.exists():
        raise HTTPException(404, detail="Terms of Service page not found")
    return FileResponse(str(file_path), media_type="text/html")

@app.get("/history")
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

@app.get("/export/{conversation_id}")
async def export_conversation(
    conversation_id: int,
    format: str = "json",
    user_id: str = "",
    current_user: dict = Depends(get_current_user_required)
):
    if user_id != current_user["email"]:
        raise HTTPException(403, detail="🔒 Access denied.")
    if format not in ("json", "txt"):
        raise HTTPException(400, detail="📝 Format must be 'json' or 'txt'.")
    try:
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
    except Exception as e:
        print(f"[EXPORT ERROR] {e}")
        raise HTTPException(500, detail="😕 Export failed. Please try again.")

@app.get("/search")
async def search_messages(
    q: str,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)   # ✅ Use dependency injection
):
    if not q or len(q.strip()) < 2:
        raise HTTPException(400, detail="📝 Please enter at least 2 characters to search.")

    search_term = f"%{q.strip()}%"
    cursor = conn.cursor()

    cursor.execute("""
        SELECT 
            c.id as conversation_id,
            c.title,
            m.id as message_id,
            m.content,
            m.created_at,
            m.role
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.user_id = %s 
        AND m.content LIKE %s
        AND c.user_id = %s
        AND m.role = 'assistant'
        ORDER BY m.created_at DESC
        LIMIT 50
    """, (current_user["email"], search_term, current_user["email"]))

    rows = cursor.fetchall()

    if not rows:
        return {"results": []}

    conversations = {}
    for row in rows:
        cid = row["conversation_id"]
        if cid not in conversations:
            conversations[cid] = {
                "conversation_id": cid,
                "title": row["title"],
                "messages": []
            }
        content = row["content"]
        # Highlight the search term
        idx = content.lower().find(q.lower())
        if idx != -1:
            start = max(0, idx - 50)
            end = min(len(content), idx + len(q) + 50)
            snippet = content[start:end]
            snippet = snippet.replace(q.strip(), f"<mark>{q.strip()}</mark>", 1)
        else:
            snippet = content[:200] + "..."

        conversations[cid]["messages"].append({
            "message_id": row["message_id"],
            "content": content,
            "snippet": snippet,
            "created_at": row["created_at"],
            "role": row["role"]
        })

    return {"results": list(conversations.values())}

@app.get("/conversations")
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

@app.post("/conversations")
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

@app.patch("/conversations/{conversation_id}")
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

@app.delete("/conversations/{conversation_id}")
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

# ─── ARCHIVE ENDPOINTS ───

@app.patch("/conversations/{conversation_id}/archive")
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

@app.patch("/conversations/{conversation_id}/unarchive")
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

@app.get("/conversations/archived")
async def list_archived_conversations(
    current_user: dict = Depends(get_current_user_required)
):
    try:
        return {"conversations": get_archived_conversations(current_user["email"])}
    except Exception as e:
        print(f"[ARCHIVED CONV ERROR] {e}")
        raise HTTPException(500, detail="😕 Could not load archived conversations. Please try again.")

@app.post("/clear")
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

# ─── ATTACHMENTS ENDPOINT ───

@app.get("/attachments")
async def list_attachments(
    conversation_id: int,
    current_user: dict = Depends(get_current_user_required)
):
    convs = get_conversations(current_user["email"], include_archived=True)
    if not any(c["id"] == conversation_id for c in convs):
        raise HTTPException(403, detail="🔒 Access denied.")
    attachments = get_attachments(current_user["email"], conversation_id)
    return {"attachments": attachments}

# ─── UPLOAD ENDPOINT (With Cloudinary + attachment saving) ───

@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    user_id: str = "",
    conversation_id: Optional[int] = None,
    request: Request = None
):
    client_ip = request.client.host if request else "unknown"
    if not _check_rate_limit(client_ip, max_requests=10, window_seconds=60):
        raise HTTPException(429, detail="⏳ Too many uploads. Please slow down.")

    if not user_id:
        user_id = "u_auto_" + str(int(time.time()))

    try:
        content = await file.read()
        cloudinary_url = None

        # Check file size
        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(400, detail="📎 File too large. Maximum size is 10MB.")

        # Check file extension
        allowed_extensions = ('.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.xls')
        if not any(file.filename.lower().endswith(ext) for ext in allowed_extensions):
            raise HTTPException(400, detail="📎 Unsupported file type. Please upload PDF, DOCX, TXT, MD, CSV, or Excel.")

        if Config.cloudinary_ready():
            try:
                upload_result = cloudinary.uploader.upload(
                    content,
                    folder=f"veyronis/uploads/{user_id}",
                    public_id=file.filename,
                    resource_type="auto",
                    use_filename=True,
                    unique_filename=False,
                    overwrite=True
                )
                cloudinary_url = upload_result.get("secure_url")
                print(f"[CLOUDINARY] Uploaded: {cloudinary_url}")
            except Exception as e:
                print(f"[CLOUDINARY ERROR] {e}")
                cloudinary_url = None

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

        file_type = "image" if file.content_type and file.content_type.startswith("image/") else "document"
        attach_id = save_attachment(
            user_id=user_id,
            conversation_id=conversation_id,
            filename=file.filename,
            cloudinary_url=cloudinary_url,
            file_type=file_type,
            size=len(content),
            mime_type=file.content_type
        )

        response = {
            "filename": file.filename,
            "extracted_length": len(text),
            "preview": text[:500],
            "content": text[:3000],
            "conversation_id": conversation_id,
            "cloudinary_url": cloudinary_url,
            "attachment_id": attach_id
        }
        if gemini_analysis:
            response["gemini_analysis"] = gemini_analysis
        return response
    except HTTPException:
        raise
    except Exception as e:
        print(f"[UPLOAD ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Upload failed. Please try again.")

# ─── CHAT ENDPOINTS ───

@app.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    req: Request,
    current_user: Optional[dict] = Depends(get_current_user_optional)
):
    try:
        msg = request.message.strip()
        user_id = request.user_id.strip()
        conversation_id = request.conversation_id

        client_ip = req.client.host
        if not _check_rate_limit(client_ip, max_requests=30, window_seconds=60):
            raise HTTPException(429, detail="⏳ You're moving too fast! Please wait a moment.")

        # Determine user and pro status
        if current_user:
            user_id = current_user["email"]
            is_pro = current_user["is_pro"]
        else:
            is_pro = False
            if not user_id:
                user_id = "u_" + str(int(time.time()))

        today = str(date.today())
        if not is_pro:
            usage = get_usage_count(user_id, today)
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
                    increment_usage(user_id, today)
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
        if not is_pro and not check_free_limit(client_ip):
            raise HTTPException(429, detail="📊 You've reached your daily limit. Upgrade to PRO for unlimited!")

        if not conversation_id:
            title = msg[:40] + ("..." if len(msg) > 40 else "") if msg else "Image upload"
            conversation_id = create_conversation(user_id, title=title)
        image_data_url = _b64_to_data_url(request.image) if request.image else None
        user_content = msg or "[Image uploaded for analysis]"
        save_message(user_id, "user", user_content, conversation_id=conversation_id, image_data=image_data_url)

        result = orchestrator.process_pipeline(
            msg, mode=request.mode, user_id=user_id, conversation_id=conversation_id,
            image_b64=request.image, model_mode=request.model_mode, ai_model=request.ai_model,
            custom_instructions=request.custom_instructions, response_style=request.response_style
        )
        save_message(user_id, "assistant", result["response"], conversation_id=conversation_id)
        if not is_pro:
            add_free_request(client_ip)
            increment_usage(user_id, today)
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

@app.post("/chat/stream")
async def chat_stream(
    request: ChatRequest,
    req: Request,
    current_user: Optional[dict] = Depends(get_current_user_optional)
):
    try:
        msg = request.message.strip()
        user_id = request.user_id.strip()
        conversation_id = request.conversation_id

        client_ip = req.client.host
        if not _check_rate_limit(client_ip, max_requests=30, window_seconds=60):
            async def rate_limit_error():
                yield f"data: {json.dumps({'type': 'error', 'content': '⏳ You\'re moving too fast! Please wait a moment.'})}\n\n"
            return StreamingResponse(rate_limit_error(), media_type="text/event-stream")

        # Determine user and pro status
        if current_user:
            user_id = current_user["email"]
            is_pro = current_user["is_pro"]
        else:
            is_pro = False
            if not user_id:
                user_id = "u_" + str(int(time.time()))

        today = str(date.today())
        if not is_pro:
            usage = get_usage_count(user_id, today)
            if usage >= 20:
                async def limit_error():
                    yield f"data: {json.dumps({'type': 'error', 'content': '📊 You\'ve reached your daily limit (20 messages). Upgrade to PRO for unlimited!'})}\n\n"
                return StreamingResponse(limit_error(), media_type="text/event-stream")

        if request.mode == "canvas" and not is_pro:
            async def err_gen():
                yield f"data: {json.dumps({'type': 'error', 'content': '🎨 Canvas is a Pro feature. Upgrade to use it.'})}\n\n"
            return StreamingResponse(err_gen(), media_type="text/event-stream")

        has_image = request.image is not None and len(request.image) > 0
        has_text = len(msg) > 0
        if has_text and not check_input(msg)[0]:
            async def err_gen():
                yield f"data: {json.dumps({'type': 'error', 'content': '⛔ Blocked'})}\n\n"
            return StreamingResponse(err_gen(), media_type="text/event-stream")
        if not has_text and not has_image:
            async def err_gen():
                yield f"data: {json.dumps({'type': 'error', 'content': '✏️ Please enter a message.'})}\n\n"
            return StreamingResponse(err_gen(), media_type="text/event-stream")
        if not is_pro and not check_free_limit(client_ip):
            async def err_gen():
                yield f"data: {json.dumps({'type': 'error', 'content': '📊 You\'ve reached your daily limit. Upgrade to PRO for unlimited!'})}\n\n"
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

            if request.mode == "simulation":
                try:
                    yield f"data: {json.dumps({'type': 'reasoning', 'content': '🔮 Running Hindsight simulation...'})}\n\n"
                    result, status = hindsight_engine.run(user_id, effective_query, is_pro=is_pro)
                    json_output = result.model_dump_json()
                    yield f"data: {json.dumps({'type': 'token', 'content': json_output})}\n\n"
                    yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free'})}\n\n"
                    save_message(user_id, "assistant", json_output, conversation_id=conversation_id)
                    if not is_pro:
                        increment_usage(user_id, today)
                    return
                except RuntimeError as e:
                    yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
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
                        yield f"data: {json.dumps({'type': 'error', 'content': '😕 An error occurred. Please try again.'})}\n\n"
                        return
                yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'tier': 'pro' if is_pro else 'free'})}\n\n"
                save_message(user_id, "assistant", full_response, conversation_id=conversation_id)
                if not is_pro:
                    add_free_request(client_ip)
                    increment_usage(user_id, today)
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

@app.post("/execute")
async def execute_code(request: Request):
    client_ip = request.client.host
    if not _check_rate_limit(client_ip, max_requests=10, window_seconds=60):
        raise HTTPException(429, detail="⏳ Too many code executions. Please slow down.")

    try:
        data = await request.json()
        code = data.get("code", "").strip()
        if not code:
            raise HTTPException(400, detail="📝 Please enter some code to execute.")
        return CodeExecutor.run(code)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[EXECUTE ERROR] {e}")
        raise HTTPException(500, detail="😕 Code execution failed. Please try again.")

@app.get("/health")
async def health():
    groq_ok = bool(Config.GROQ_API_KEY)
    tavily_ok = bool(Config.TAVILY_API_KEY)
    gemini_ok = Config.gemini_ready()
    google_oauth_ok = Config.google_oauth_ready()
    cloudinary_ok = Config.cloudinary_ready()
    email_ok = Config.email_ready()
    return {
        "status": "VEYRONIS is online",
        "version": "1.3-hindsight",
        "models": {"groq": groq_ok, "tavily": tavily_ok, "gemini": gemini_ok},
        "oauth": {"google": google_oauth_ok},
        "storage": {"cloudinary": cloudinary_ok},
        "email": {"resend": email_ok},
        "timestamp": datetime.now().isoformat()
    }

@app.get("/ping")
async def ping():
    return {"message": "pong"}

@app.get("/routes")
async def routes(current_user: dict = Depends(get_current_user_required)):
    route_list = []
    for route in app.routes:
        route_list.append({"path": route.path, "methods": list(route.methods) if hasattr(route, "methods") else []})
    return {"routes": route_list}

# ─── ADMIN ENDPOINTS ───

@app.get("/admin/users")
async def admin_list_users(
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    """List all users with their status (admin only)"""
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(status_code=403, detail="Admin access required")

    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, email, is_pro, is_verified, is_banned, ban_reason,
               banned_until, created_at, subscription_status, display_id
        FROM users
        ORDER BY created_at DESC
    """)
    users = cursor.fetchall()

    result = []
    for user in users:
        # ✅ FIX: use email (text) not id (integer)
        cursor.execute(
            "SELECT COUNT(*) FROM messages WHERE user_id = %s",
            (user["email"],)
        )
        msg_count = cursor.fetchone()["count"]
        result.append({
            "id": user["id"],
            "email": user["email"],
            "is_pro": bool(user["is_pro"]),
            "is_verified": bool(user["is_verified"]),
            "is_banned": bool(user["is_banned"]),
            "ban_reason": user["ban_reason"],
            "banned_until": user["banned_until"],
            "created_at": user["created_at"],
            "message_count": msg_count,
            "subscription_status": user["subscription_status"],
            "display_id": user.get("display_id")
        })

    return {"users": result}

@app.post("/admin/users/{user_id}/ban")
async def admin_ban_user(
    user_id: str,
    request: dict,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    """Ban a user (admin only)"""
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(status_code=403, detail="Admin access required")

    reason = request.get("reason", "Violation of terms")
    duration_days = request.get("duration_days", 30)

    cursor = conn.cursor()
    cursor.execute("SELECT id, is_banned FROM users WHERE id = %s", (user_id,))
    user = cursor.fetchone()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user["is_banned"]:
        raise HTTPException(status_code=400, detail="User is already banned")

    banned_until = (datetime.utcnow() + timedelta(days=duration_days)).isoformat()

    cursor.execute("""
        UPDATE users
        SET is_banned = TRUE, ban_reason = %s, banned_until = %s
        WHERE id = %s
    """, (reason, banned_until, user_id))

    cursor.execute("""
        INSERT INTO admin_actions (admin_user_id, target_user_id, action, reason, expires_at)
        VALUES (%s, %s, 'ban', %s, %s)
    """, (current_user["id"], user_id, reason, banned_until))

    conn.commit()
    return {"message": f"User {user_id} banned until {banned_until}"}

@app.post("/admin/users/{user_id}/unban")
async def admin_unban_user(
    user_id: str,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    """Unban a user (admin only)"""
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(status_code=403, detail="Admin access required")

    cursor = conn.cursor()
    cursor.execute("""
        UPDATE users
        SET is_banned = FALSE, ban_reason = NULL, banned_until = NULL
        WHERE id = %s
    """, (user_id,))

    cursor.execute("""
        INSERT INTO admin_actions (admin_user_id, target_user_id, action)
        VALUES (%s, %s, 'unban')
    """, (current_user["id"], user_id))

    conn.commit()
    return {"message": f"User {user_id} unbanned"}

@app.get("/admin/reports")
async def admin_list_reports(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    """List all reports (admin only)"""
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(status_code=403, detail="Admin access required")

    cursor = conn.cursor()
    query = """
        SELECT r.*, u.email as reporter_email, m.content as message_content
        FROM reports r
        JOIN users u ON r.reporter_user_id = u.id
        JOIN messages m ON r.reported_message_id = m.id
    """
    params = []
    if status:
        query += " WHERE r.status = %s"
        params.append(status)
    query += " ORDER BY r.created_at DESC"

    cursor.execute(query, params)
    reports = cursor.fetchall()
    return {"reports": reports}

@app.post("/admin/reports/{report_id}/review")
async def admin_review_report(
    report_id: str,
    request: dict,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    """Review a report (admin only)"""
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(status_code=403, detail="Admin access required")

    status = request.get("status")
    notes = request.get("notes", "")
    if status not in ["resolved", "dismissed"]:
        raise HTTPException(status_code=400, detail="Invalid status")

    cursor = conn.cursor()
    cursor.execute("""
        UPDATE reports
        SET status = %s, reviewed_by = %s, reviewed_at = %s, review_notes = %s
        WHERE id = %s
    """, (status, current_user["id"], datetime.utcnow().isoformat(), notes, report_id))

    conn.commit()
    return {"message": f"Report {report_id} {status}"}

# ─── FEEDBACK ENDPOINT ───

@app.post("/feedback")
async def submit_feedback(
    request: dict,
    current_user: dict = Depends(get_current_user_required)
):
    """Send user feedback to admin via email."""
    if not Config.email_ready():
        raise HTTPException(503, detail="Email service not configured")
    message = request.get("message", "").strip()
    if not message:
        raise HTTPException(400, detail="Feedback message cannot be empty")
    admin_emails = Config.ADMIN_EMAILS.split(",")
    for admin in admin_emails:
        send_feedback_email(admin, current_user["email"], message)
    return {"status": "Feedback sent"}

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)