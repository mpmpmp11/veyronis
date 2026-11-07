"""VEYRONIS API Server — Production Hardened + Cloudinary + Email + Admin + Feedback."""
import os
import requests
import re
from pathlib import Path
from fastapi.responses import HTMLResponse
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, RedirectResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
from scheduler import start_scheduler
start_scheduler()
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, date
from jose import JWTError, jwt
import hashlib
import bcrypt
import edge_tts
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
    save_attachment, get_attachments, get_upload_counts,
    increment_upload_count,
    get_archived_conversations, archive_conversation, unarchive_conversation, delete_old_attachments, save_report, get_reports, review_report, save_message_feedback, save_general_feedback
)
from app.dependencies import get_current_user_required, get_current_user_optional, get_current_user_from_token_or_query
# Import shared dependencies
from app.dependencies import (
    get_current_user_required,
    get_current_user_optional,
    get_current_user_from_token_or_query,
    decode_token
)
# Import auth helpers for the remaining routes in api.py
from app.routers.auth import (
    get_password_hash,
    verify_password,
    create_access_token,
    LoginRequest,
    RegisterRequest,
    TokenResponse
)
from usage_cache import usage_cache
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

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

_SENTRY_DSN = os.getenv("SENTRY_DSN", "").strip()
if _SENTRY_DSN:
    sentry_sdk.init(
        dsn=_SENTRY_DSN,
        integrations=[
            StarletteIntegration(transaction_style="endpoint"),
            FastApiIntegration(transaction_style="endpoint"),
        ],
        environment=os.getenv("RENDER", "dev") or "dev",
        send_default_pii=False,          # don't send user emails/IPs
    )
    print("[VEYRONIS] Sentry error monitoring enabled")
else:
    print("[VEYRONIS] Sentry not configured (SENTRY_DSN missing)")
    
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



# ─── PATH SETUP ───
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="VEYRONIS API")
from app.routers import auth
app.include_router(auth.router)

from app.routers import chat
app.include_router(chat.router)

from app.routers import tutor
app.include_router(tutor.router)

from fastapi.responses import JSONResponse, FileResponse

@app.exception_handler(404)
async def custom_404_handler(request: Request, exc):
    # Return JSON for any API-ish request:
    #  - any non-GET request (POST/PUT/PATCH/DELETE — always API)
    #  - any path starting with a known API prefix
    #  - any request with Accept: application/json
    # Only serve the 404.html page for GET requests to unknown page routes.
    api_prefixes = (
        '/api/', '/static/',
        '/chat', '/upload', '/execute', '/tts',
        '/me', '/health', '/ping',
        '/conversations', '/history', '/search', '/export',
        '/attachments', '/preview',
        '/message-feedback', '/report', '/feedback',
        '/admin', '/subscription', '/usage',
        '/upload-limits', '/account', '/clear',
        '/register', '/login', '/forgot-password', '/reset-password',
        '/verify-email',
    )
    is_api_request = (
        request.method != "GET"
        or request.url.path.startswith(api_prefixes)
        or "application/json" in request.headers.get("accept", "")
    )

    if is_api_request:
        # Reuse the original detail if FastAPI put one on the HTTPException
        detail = getattr(exc, "detail", None) or "Not Found"
        return JSONResponse(status_code=404, content={"detail": detail})

    # Otherwise: genuine page-not-found → serve the beautiful 404 page
    file_path = FRONTEND_DIR / "404.html"
    if file_path.exists():
        return FileResponse(str(file_path), status_code=404)
    return JSONResponse(status_code=404, content={"detail": "Not Found"})
    
# ─── Digital Asset Links for TWA (removes Chrome URL bar) ───
import json as _json
from fastapi.responses import Response

@app.get("/.well-known/assetlinks.json", include_in_schema=False)
async def assetlinks():
    json_content = '''[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.onrender.veyronis.twa",
    "sha256_cert_fingerprints": ["99:68:5E:DB:F1:0A:AC:2C:1E:03:7B:97:0D:74:70:92:61:38:48:5B:97:91:9B:4B:B9:8E:34:A9:D0:D8:6F:E2"]
  }
}]'''
    return Response(content=json_content, media_type="application/json")

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
    # Test mode: bypass rate limits so the smoke test suite can register
    # multiple throwaway users in one session. Set VEYRONIS_TEST_MODE=1
    # in the test environment. Never set this in production.
    if os.environ.get("VEYRONIS_TEST_MODE") == "1":
        return True

    now = time.time()
    key = client_ip
    if key not in _rate_limit_tracker:
        _rate_limit_tracker[key] = []
    _rate_limit_tracker[key] = [t for t in _rate_limit_tracker[key] if now - t < window_seconds]
    if len(_rate_limit_tracker[key]) >= max_requests:
        return False
    _rate_limit_tracker[key].append(now)
    return True


_voice_rate_tracker = {}

def _check_voice_rate_limit(user_email: str, max_per_minute: int = 8):
    """Sliding-window rate limit for voice mode. Returns (ok, wait_seconds)."""
    now = time.time()
    key = f"voice_rl_{user_email}"
    if key not in _voice_rate_tracker:
        _voice_rate_tracker[key] = []
    # Keep only last 60s
    _voice_rate_tracker[key] = [t for t in _voice_rate_tracker[key] if now - t < 60]
    if len(_voice_rate_tracker[key]) >= max_per_minute:
        oldest = _voice_rate_tracker[key][0]
        wait = 60 - (now - oldest)
        return False, wait
    _voice_rate_tracker[key].append(now)
    return True, 0

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



# ─── FORGOT PASSWORD ───

@app.post("/forgot-password")
async def forgot_password(request: Request):
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
            raise HTTPException(500, detail="⚠️ We could not send the reset email. Please try again later or contact support.")

        return {"message": "📧 If this email exists, a reset link has been sent."}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[FORGOT PASSWORD ERROR] {e}")
        traceback.print_exc()
        raise HTTPException(500, detail="😕 Something went wrong. Please try again.")

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
    return RedirectResponse(f"{Config.APP_BASE_URL}/#email-verified?token={token}")

@app.get("/api/verify-email")
async def api_verify_email(token: str):
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
    conn = Depends(get_db)
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


# ─── ATTACHMENTS ENDPOINT ───

@app.get("/attachments")
async def list_attachments(
    conversation_id: int,
    current_user: dict = Depends(get_current_user_required)
):
    user_email = current_user["email"]
    print(f"[ATTACHMENTS] user={user_email}, conv={conversation_id}")

    attachments = get_attachments(user_email, conversation_id)
    print(f"[ATTACHMENTS] found {len(attachments)} rows")

    return {"attachments": attachments}

# ─── UPLOAD ENDPOINT ───

@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    conversation_id: Optional[int] = None,
    request: Request = None,
    current_user: dict = Depends(get_current_user_required)
):
    client_ip = request.client.host if request else "unknown"
    if not _check_rate_limit(client_ip, max_requests=10, window_seconds=60):
        raise HTTPException(429, detail="⏳ Too many uploads. Please slow down.")

    user_id = current_user["email"]
    print(f"[UPLOAD] user: {user_id}, conv: {conversation_id}, file: {file.filename}")

    try:
        content = await file.read()
        cloudinary_url = None

        if len(content) > 10 * 1024 * 1024:
            raise HTTPException(400, detail="📎 File too large. Maximum size is 10MB.")

        allowed_extensions = ('.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.xls')
        if not any(file.filename.lower().endswith(ext) for ext in allowed_extensions):
            raise HTTPException(400, detail="📎 Unsupported file type. Please upload PDF, DOCX, TXT, MD, CSV, or Excel.")

        is_image = file.content_type and file.content_type.startswith("image/")
        today = str(date.today())
        if not current_user["is_pro"]:
            counts = get_upload_counts(current_user["email"], today)
            if is_image and counts["images"] >= 3:
                raise HTTPException(429, detail="📸 Daily image limit reached (3/day). Upgrade to PRO for unlimited.")
            if not is_image and counts["docs"] >= 3:
                raise HTTPException(429, detail="📄 Daily document limit reached (3/day). Upgrade to PRO for unlimited.")

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
            if current_user["is_pro"] and Config.gemini_ready() and orchestrator.gemini_agent:
                gemini_analysis = orchestrator.gemini_agent.generate_document_response(
                    content, file.filename,
                    prompt="Analyze this document thoroughly. Provide a concise summary, key points, main arguments, important data, and notable sections."
                )
        except Exception as e:
            print(f"[VEYRONIS] Gemini doc analysis failed: {e}")

        if not conversation_id:
            conversation_id = create_conversation(user_id, title=file.filename)

        file_type = "image" if is_image else "document"
        attach_id = save_attachment(
            user_id=user_id,
            conversation_id=conversation_id,
            filename=file.filename,
            cloudinary_url=cloudinary_url,
            file_type=file_type,
            size=len(content),
            mime_type=file.content_type
        )
        print(f"[UPLOAD] Saved attachment id: {attach_id}")

        if not current_user["is_pro"]:
            increment_upload_count(user_id, today, file_type)

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

@app.get("/upload-limits")
async def get_upload_limits(current_user: dict = Depends(get_current_user_required)):
    if current_user["is_pro"]:
        return {
            "images": 999, "docs": 999,
            "remaining_images": 999, "remaining_docs": 999,
            "is_pro": True
        }
    today = str(date.today())
    counts = get_upload_counts(current_user["email"], today)
    return {
        "images": 3,
        "docs": 3,
        "remaining_images": max(0, 3 - counts["images"]),
        "remaining_docs": max(0, 3 - counts["docs"]),
        "is_pro": False
    }

from fastapi import Response
from fishaudio import FishAudio
from fishaudio.utils import save
import io

# --- Fish Audio TTS Endpoint ---
def sanitize_for_tts(text: str) -> str:
    if not text:
        return ""
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"
        "\U0001F300-\U0001F5FF"
        "\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF"
        "\U00002700-\U000027BF"
        "\U0001F900-\U0001F9FF"
        "\U00002600-\U000026FF"
        "\U0001FA00-\U0001FAFF"
        "\U00002B00-\U00002BFF"
        "]+", flags=re.UNICODE
    )
    text = emoji_pattern.sub("", text)
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"#{1,6}\s*", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[>\-]{2,}", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

@app.post("/tts")
async def text_to_speech(request: dict):
    text = (request.get("text") or "").strip()
    if not text:
        raise HTTPException(400, detail="📝 No text provided.")
    if not Config.FISH_API_KEY:
        raise HTTPException(503, detail="Fish Audio not configured.")

    text = sanitize_for_tts(text)
    if not text:
        raise HTTPException(400, detail="Nothing speakable after cleaning.")

    if len(text) > 3000:
        text = text[:3000]

    voice_id = request.get("voice_id") or Config.FISH_VOICE_ID

    try:
        resp = requests.post(
            "https://api.fish.audio/v1/tts",
            headers={
                "Authorization": f"Bearer {Config.FISH_API_KEY}",
                "Content-Type": "application/json",
                "model": "s2.1-pro-free",
            },
            json={
                "text": text,
                "reference_id": voice_id,
                "format": "mp3",
                "mp3_bitrate": 128,
                "latency": "normal",
            },
            timeout=60,
        )
        if resp.status_code != 200:
            print(f"[FISH TTS ERROR] {resp.status_code}: {resp.text[:300]}")
            raise HTTPException(500, detail="🎤 TTS generation failed.")
        return Response(content=resp.content, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[FISH TTS EXCEPTION] {e}")
        raise HTTPException(500, detail="🎤 TTS generation failed.")

# ═══════════════════════════════════════════════════════
# VOICE MODE — ElevenLabs Token + Edge-TTS
# ═══════════════════════════════════════════════════════

GEORGIAN_RE = re.compile(r'[\u10A0-\u10FF]')

@app.get("/api/voice/streaming-token")
async def get_streaming_token(current_user: dict = Depends(get_current_user_required)):
    """Generate a single-use ElevenLabs token for browser STT."""
    if not Config.ELEVENLABS_API_KEY:
        raise HTTPException(503, detail="ElevenLabs not configured.")

    try:
        resp = requests.post(
            "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
            headers={"xi-api-key": Config.ELEVENLABS_API_KEY},
            timeout=10
        )
        if resp.status_code != 200:
            print(f"[ELEVENLABS TOKEN ERROR] {resp.status_code}: {resp.text[:300]}")
            raise HTTPException(500, detail="Failed to create streaming token.")
        data = resp.json()
        return {"token": data.get("token")}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ELEVENLABS TOKEN EXCEPTION] {e}")
        raise HTTPException(500, detail="Failed to create streaming token.")

def _detect_voice(text: str) -> str:
    """Pick Georgian or English voice based on text content."""
    georgian_chars = len(GEORGIAN_RE.findall(text))
    total_letters = len(re.findall(r'[^\s\d\W]', text, re.UNICODE))
    if total_letters == 0:
        return "en-US-ChristopherNeural"
    if georgian_chars / total_letters > 0.3:
        return "ka-GE-EkaNeural"
    return "en-US-ChristopherNeural"

def _clean_for_tts(text: str) -> str:
    """Aggressively clean text so Edge-TTS never chokes."""
    if not text:
        return ""

    # 1. Remove code blocks
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    text = re.sub(r'`([^`]*)`', r'\1', text)

    # 2. Remove URLs
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'www\.\S+', '', text)

    # 3. Strip markdown bold/italic/strikethrough
    text = re.sub(r'\*\*\*([^*]+)\*\*\*', r'\1', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)
    text = re.sub(r'~~([^~]+)~~', r'\1', text)

    # 4. Remove markdown headers
    text = re.sub(r'^\s*#{1,6}\s*', '', text, flags=re.MULTILINE)

    # 5. Remove bullet/numbered list markers
    text = re.sub(r'^\s*[\-\*•·‣◦]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\d+[.)]\s+', '', text, flags=re.MULTILINE)

    # 6. Remove markdown links, keep text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)

    # 7. Remove emojis
    emoji_pat = re.compile(
        "["
        "\U0001F300-\U0001F5FF"
        "\U0001F600-\U0001F64F"
        "\U0001F680-\U0001F6FF"
        "\U0001F700-\U0001F77F"
        "\U0001F780-\U0001F7FF"
        "\U0001F800-\U0001F8FF"
        "\U0001F900-\U0001F9FF"
        "\U0001FA00-\U0001FAFF"
        "\U0001F1E0-\U0001F1FF"
        "\U00002600-\U000026FF"
        "\U00002700-\U000027BF"
        "\U0001F000-\U0001F0FF"
        "\U00002B00-\U00002BFF"
        "\U00002190-\U000021FF"
        "\U0000FE00-\U0000FE0F"
        "\U0000200D"
        "]+",
        flags=re.UNICODE
    )
    text = emoji_pat.sub(' ', text)

    # 8. Remove invisible noise
    text = re.sub(r'[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]', '', text)

    # 9. Replace em-dashes and ellipses
    text = text.replace('—', ', ').replace('–', ', ')
    text = text.replace('…', ', ').replace('...', ', ')

    # 10. Replace symbols that break TTS
    text = text.replace('&', ' and ').replace('&amp;', ' and ')
    text = text.replace('@', ' at ').replace('#', ' ')
    text = text.replace('%', ' percent ').replace('+', ' plus ')
    text = text.replace('=', ' equals ').replace('~', ' ')
    text = text.replace('^', ' ').replace('|', ', ')
    text = text.replace('\\', ' ').replace('/', ' or ')
    text = text.replace('[', ' ').replace(']', ' ')
    text = text.replace('{', ' ').replace('}', ' ')
    text = text.replace('<', ' ').replace('>', ' ')

    # 11. Collapse whitespace and stray punctuation
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)
    text = re.sub(r'([.,!?;:])\1+', r'\1', text)
    text = re.sub(r'^[\s.,!?;:]+', '', text)
    text = text.strip()

    # 12. FINAL SAFETY: kill remaining markdown noise
    text = text.replace('*', '').replace('_', ' ').replace('#', ' ').replace('`', '')
    text = re.sub(r'\s+', ' ', text).strip()

    # 13. Hard cap at 1500 chars
    if len(text) > 1500:
        cut = text[:1500]
        last_punct = max(cut.rfind('.'), cut.rfind('!'), cut.rfind('?'))
        text = cut[:last_punct + 1] if last_punct > 0 else cut

    return text

@app.post("/api/voice/tts-georgian")
async def tts_georgian(
    request: dict,
    current_user: dict = Depends(get_current_user_required)
):
    """Generate Georgian or English speech via edge-tts (free, no GPU)."""
    raw_text = (request.get("text") or "").strip()
    if not raw_text:
        raise HTTPException(400, detail="No text provided.")

    text = _clean_for_tts(raw_text)
    if not text:
        raise HTTPException(400, detail="Nothing speakable after cleaning.")

    voice = _detect_voice(text)
    print(f"[EDGE-TTS] voice={voice}, chars={len(text)}")

    async def audio_stream():
        try:
            communicate = edge_tts.Communicate(text=text, voice=voice)
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
        except Exception as e:
            print(f"[EDGE-TTS STREAM ERROR] {e}")

    return StreamingResponse(
        audio_stream(),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline; filename=tts.mp3"}
    )

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

    # ─── REPORT ENDPOINTS ───

@app.post("/report")
async def submit_report(
    request: dict,
    current_user: dict = Depends(get_current_user_required)
):
    message_id = int(request.get("message_id", 0)) # <--- CONVERT TO INT
    reason = request.get("reason", "").strip()

    if not message_id or not reason:
        raise HTTPException(400, detail="Message ID and reason are required.")

    report_id = save_report(current_user["email"], message_id, reason)
    return {"status": "reported", "report_id": report_id}

@app.get("/admin/reports")
async def list_reports(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user_required)
):
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(403, detail="Admin access required.")
    return {"reports": get_reports(status)}

@app.post("/admin/reports/{report_id}/review")
async def review_report_endpoint(
    report_id: int,
    request: dict,
    current_user: dict = Depends(get_current_user_required)
):
    if current_user["email"] not in Config.ADMIN_EMAILS.split(","):
        raise HTTPException(403, detail="Admin access required.")
    
    status = request.get("status")
    notes = request.get("notes", "")
    if status not in ("resolved", "dismissed"):
        raise HTTPException(400, detail="Status must be 'resolved' or 'dismissed'.")
    
    review_report(report_id, status, current_user["id"], notes)
    return {"status": status}

# ─── ADMIN ENDPOINTS ───

@app.get("/admin/users")
async def admin_list_users(
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
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


_voice_minutes_tracker = {}

@app.post("/api/voice/log-minutes")
async def log_voice_minutes(request: dict, current_user: dict = Depends(get_current_user_required)):
    """Log voice usage minutes. Free = 5 min/day, PRO = 60 min/day."""
    minutes = float(request.get("minutes", 0))
    today = str(date.today())
    key = f"{current_user['email']}_{today}"
    _voice_minutes_tracker[key] = _voice_minutes_tracker.get(key, 0) + minutes

    user = get_user_by_email(current_user["email"])
    is_pro = bool(user["is_pro"]) if user else False
    limit = 60 if is_pro else 5

    return {
        "used": round(_voice_minutes_tracker[key], 1),
        "limit": limit,
        "remaining": max(0, round(limit - _voice_minutes_tracker[key], 1))
    }

# ─── FEEDBACK ENDPOINT ───

@app.post("/feedback")
async def submit_feedback(
    request: dict,
    current_user: dict = Depends(get_current_user_required)
):
    message = request.get("message", "").strip()
    if not message:
        raise HTTPException(400, detail="Feedback message cannot be empty")
    
    # 1. Save to database
    save_general_feedback(current_user["email"], message)
    
    # 2. Send email via Brevo
    admin_emails = Config.ADMIN_EMAILS.split(",")
    for admin in admin_emails:
        send_feedback_email(admin, current_user["email"], message)
        
    return {"status": "Feedback sent"}

@app.post("/message-feedback")
async def submit_message_feedback(
    request: dict,
    current_user: dict = Depends(get_current_user_required),
    conn = Depends(get_db)
):
    message_id = int(request.get("message_id", 0))
    is_helpful = request.get("is_helpful")
    if not message_id or is_helpful is None:
        raise HTTPException(400, detail="Invalid feedback data")

    # SECURITY: verify the message belongs to the current user
    cursor = conn.cursor()
    cursor.execute(
        "SELECT 1 FROM messages WHERE id = %s AND user_id = %s LIMIT 1",
        (message_id, current_user["email"])
    )
    if not cursor.fetchone():
        raise HTTPException(404, detail="Message not found")

    save_message_feedback(current_user["email"], message_id, is_helpful)
    return {"status": "success"}

@app.get("/preview/{attachment_id}")
async def preview_file(
    attachment_id: int,
    request: Request,
    token: Optional[str] = None,
    current_user: dict = Depends(get_current_user_from_token_or_query),
    conn = Depends(get_db)
):
    cursor = conn.cursor()
    cursor.execute(
        "SELECT filename, cloudinary_url, mime_type FROM attachments WHERE id = %s AND user_id = %s",
        (attachment_id, current_user["email"])
    )
    row = cursor.fetchone()

    if not row:
        raise HTTPException(404, detail="File not found")

    filename = row["filename"]
    url = row["cloudinary_url"]
    mime_type = row["mime_type"] or ""

    if not url:
        html = f"""
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Preview – {filename}</title></head>
        <body style="font-family:sans-serif;background:#0a0a0c;color:#f0f0f5;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;">
            <div style="font-size:64px;">⚠️</div>
            <h2>File not available</h2>
            <p>The file could not be found. It may have been deleted.</p>
            <a href="/" style="color:#a78bfa;">← Back to VEYRONIS</a>
        </body>
        </html>
        """
        return HTMLResponse(content=html)

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Preview – {filename}</title>
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{
                background: #0a0a0c;
                color: #f0f0f5;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }}
            .container {{
                max-width: 1000px;
                width: 100%;
                background: rgba(18,18,28,0.85);
                backdrop-filter: blur(24px);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 16px;
                padding: 30px;
                box-shadow: 0 24px 80px rgba(0,0,0,0.6);
            }}
            .header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
                flex-wrap: wrap;
                gap: 12px;
            }}
            .filename {{
                font-size: 18px;
                font-weight: 700;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }}
            .filename span {{ color: #a78bfa; }}
            .actions {{
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
            }}
            .btn {{
                padding: 8px 18px;
                border-radius: 8px;
                border: none;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }}
            .btn-primary {{
                background: linear-gradient(135deg, #a78bfa, #818cf8);
                color: #fff;
            }}
            .btn-primary:hover {{
                transform: translateY(-2px);
                box-shadow: 0 8px 24px rgba(167,139,250,0.3);
            }}
            .btn-secondary {{
                background: rgba(255,255,255,0.06);
                color: #a0a0b8;
                border: 1px solid rgba(255,255,255,0.08);
            }}
            .btn-secondary:hover {{
                background: rgba(255,255,255,0.12);
                color: #f0f0f5;
            }}
            .content {{
                min-height: 300px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0,0,0,0.2);
                border-radius: 12px;
                overflow: hidden;
                padding: 20px;
            }}
            .content img {{
                max-width: 100%;
                max-height: 70vh;
                object-fit: contain;
                border-radius: 8px;
            }}
            .content iframe {{
                width: 100%;
                height: 70vh;
                border: none;
                border-radius: 8px;
                background: #fff;
            }}
            .content pre {{
                width: 100%;
                max-height: 70vh;
                overflow: auto;
                padding: 20px;
                background: rgba(0,0,0,0.3);
                border-radius: 8px;
                font-family: 'JetBrains Mono', monospace;
                font-size: 14px;
                line-height: 1.6;
                white-space: pre-wrap;
                word-wrap: break-word;
                color: #e2e8f0;
            }}
            .fallback {{
                text-align: center;
                padding: 40px;
                color: #6e6e8a;
            }}
            .fallback .icon {{ font-size: 64px; margin-bottom: 16px; }}
            .footer {{
                margin-top: 16px;
                text-align: center;
                font-size: 12px;
                color: #6e6e8a;
            }}
            .footer a {{ color: #a78bfa; text-decoration: none; }}
            @media (max-width: 640px) {{
                .header {{ flex-direction: column; align-items: flex-start; }}
                .filename {{ font-size: 14px; white-space: normal; word-break: break-word; }}
                .actions {{ width: 100%; }}
                .btn {{ font-size: 12px; padding: 6px 14px; }}
                .content {{ min-height: 200px; padding: 10px; }}
                .content iframe {{ height: 50vh; }}
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="filename">📎 <span>{filename}</span></div>
                <div class="actions">
                    <a href="{url}?fl_attachment" class="btn btn-primary" download="{filename}">⬇️ Download</a>
                    <a href="{url}" target="_blank" class="btn btn-secondary">📂 Open Original</a>
                </div>
            </div>
            <div class="content" id="preview-content">
                <div class="fallback"><div class="icon">📄</div><p>Loading preview...</p></div>
            </div>
            <div class="footer">
                <a href="/">← Back to VEYRONIS</a>
            </div>
        </div>
        <script>
            const url = "{url}";
            const filename = "{filename}";
            const ext = filename.split('.').pop().toLowerCase();
            const content = document.getElementById('preview-content');

            function showFallback() {{
                content.innerHTML = `
                    <div class="fallback">
                        <div class="icon">📎</div>
                        <p>This file type cannot be previewed directly.</p>
                        <p style="font-size:13px;margin-top:8px;">Click <strong>Download</strong> to save it.</p>
                    </div>
                `;
            }}

            if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) {{
                content.innerHTML = `<img src="${{url}}" alt="${{filename}}" onerror="showFallback()">`;
            }}
            else if (ext === 'pdf') {{
                content.innerHTML = `<iframe src="${{url}}" allowfullscreen></iframe>`;
            }}
            else if (['txt','md','json','xml','css','js','py','html','csv'].includes(ext)) {{
                fetch(url)
                    .then(r => r.text())
                    .then(text => {{
                        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {{
                            showFallback();
                            return;
                        }}
                        content.innerHTML = `<pre>${{text}}</pre>`;
                    }})
                    .catch(() => showFallback());
            }}
            else {{
                showFallback();
            }}
        </script>
    </body>
    </html>
    """

    return HTMLResponse(content=html)

# ═══════════════════════════════════════════════════════
# REAL-TIME VOICE WEBSOCKET
# ═══════════════════════════════════════════════════════
import asyncio
from fastapi import WebSocket, WebSocketDisconnect
import edge_tts

@app.websocket("/ws/voice")
async def voice_stream(websocket: WebSocket, token: Optional[str] = Query(None)):
    # AUTH FIRST — close before accept() so the client gets a clean 1008.
    if not token:
        await websocket.close(code=1008, reason="Missing auth token")
        return

    payload = decode_token(token)
    if not payload:
        await websocket.close(code=1008, reason="Invalid or expired token")
        return

    user_id_sub = payload.get("sub")
    if not user_id_sub:
        await websocket.close(code=1008, reason="Invalid token payload")
        return

    try:
        user = get_user_by_id(int(user_id_sub))
    except (ValueError, TypeError):
        await websocket.close(code=1008, reason="Invalid token subject")
        return

    if not user:
        await websocket.close(code=1008, reason="User not found")
        return
    if user.get("is_banned", False):
        await websocket.close(code=1008, reason="Account banned")
        return

    authenticated_email = user["email"]

    # Auth passed — now accept
    await websocket.accept()
    print(f"[WS] Voice client connected: {authenticated_email}")

    try:
        while True:
            data = await websocket.receive_json()
            user_text = data.get("text", "").strip()
            user_id = authenticated_email  # ignore client-supplied user_id
            if not user_text:
                continue
            print(f"[WS] User said ({authenticated_email}): {user_text}")
            conversation_id = data.get("conversation_id")
            task = asyncio.create_task(
                process_voice_turn(websocket, user_text, user_id, conversation_id)
            )
            try:
                interrupt_msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.1)
                if interrupt_msg.get("type") == "INTERRUPT":
                    print("[WS] 🛑 INTERRUPT RECEIVED. Killing pipeline.")
                    task.cancel()
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        print(f"[WS] Voice client disconnected: {authenticated_email}")
    except Exception as e:
        print(f"[WS] Error: {e}")

async def process_voice_turn(websocket: WebSocket, text: str, user_id: str, conversation_id: int = None):
    try:
        await websocket.send_json({"type": "start_speaking"})
        
        # 1. Get the LLM response from your Orchestrator
        generator = orchestrator.process_pipeline_stream(
            text, user_id=user_id, conversation_id=conversation_id, voice_mode=True
        )
        
        full_response = ""
        sentence_buffer = ""
        
        # 2. Read the LLM stream and buffer by sentence
        for event_type, content in generator:
            if event_type == "token":
                full_response += content
                sentence_buffer += content
                
                # If we hit punctuation, send to TTS immediately
                if re.search(r'[.!?]\s*$', sentence_buffer) and len(sentence_buffer) > 10:
                    await stream_tts(websocket, sentence_buffer)
                    sentence_buffer = ""
            elif event_type == "done":
                break
                
        # Flush any remaining text
        if sentence_buffer.strip():
            await stream_tts(websocket, sentence_buffer)
            
        if full_response:
            save_message(user_id, "assistant", full_response, conversation_id=conversation_id)
            
        await websocket.send_json({"type": "stop_speaking", "text": full_response})
        
    except asyncio.CancelledError:
        print("[WS] Generation cancelled.")
        raise
    except Exception as e:
        print(f"[Pipeline Error] {e}")
        await websocket.send_json({"type": "stop_speaking"})

async def stream_tts(websocket: WebSocket, text: str):
    try:
        # Detect Georgian vs English
        voice = "ka-GE-EkaNeural" if re.search(r'[\u10A0-\u10FF]', text) else "en-US-ChristopherNeural"
        
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                await websocket.send_bytes(chunk["data"])
    except Exception as e:
        print(f"[TTS Error] {e}")
        

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)