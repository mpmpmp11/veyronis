"""Authentication with JWT + Google OAuth."""
import httpx
from fastapi import HTTPException
from urllib.parse import urlencode
from settings import Config
from database import create_user, get_user_by_google_id, get_user_by_id, get_user_by_email, link_google_account

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

def get_google_auth_url(redirect_uri: str) -> str:
    params = {
        "client_id": Config.GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "email profile openid",
        "access_type": "online",
        "prompt": "select_account"   # ← ADD THIS LINE
    }
    return f"{GOOGLE_AUTH_URL}?{urlencode(params)}"

async def exchange_code_for_tokens(code: str, redirect_uri: str) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": Config.GOOGLE_CLIENT_ID,
                "client_secret": Config.GOOGLE_CLIENT_SECRET,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            }
        )
    if response.status_code != 200:
        raise HTTPException(400, f"Google token exchange failed: {response.text}")
    return response.json()

async def get_google_user_info(access_token: str) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"}
        )
    if response.status_code != 200:
        raise HTTPException(400, f"Failed to fetch user info: {response.text}")
    return response.json()

def create_jwt_for_user(user_id: int) -> str:
    from api import create_access_token
    return create_access_token({"sub": str(user_id)})

async def handle_google_callback(code: str, redirect_uri: str):
    try:
        tokens = await exchange_code_for_tokens(code, redirect_uri)
        access_token = tokens.get("access_token")
        if not access_token:
            raise HTTPException(400, "No access token received")
        
        user_info = await get_google_user_info(access_token)
        
        email = user_info.get("email")
        google_id = user_info.get("sub")
        avatar_url = user_info.get("picture")
        name = user_info.get("name", email.split("@")[0] if email else "User")
        
        if not email or not google_id:
            raise HTTPException(400, "Missing email or Google ID")
        
        # ─── Convert all rows to dict to avoid .get() errors ───
        existing = get_user_by_google_id(google_id)
        if existing:
            existing = dict(existing)  # convert to dict
            user_id = existing["id"]
            is_pro = bool(existing.get("is_pro", False))
            avatar_url = existing.get("avatar_url") or avatar_url
        else:
            existing_email = get_user_by_email(email)
            if existing_email:
                existing_email = dict(existing_email)  # convert to dict
                link_google_account(existing_email["id"], google_id, avatar_url)
                user_id = existing_email["id"]
                is_pro = bool(existing_email.get("is_pro", False))
            else:
                user_id = create_user(email=email, google_id=google_id, avatar_url=avatar_url)
                is_pro = False
        
        jwt_token = create_jwt_for_user(user_id)
        
        return {
            "access_token": jwt_token,
            "token_type": "bearer",
            "user": {
                "id": user_id,
                "email": email,
                "name": name,
                "avatar_url": avatar_url,
                "is_pro": is_pro,
                "auth_method": "google"
            }
        }
    except Exception as e:
        # Log the error and re-raise as HTTPException with clear message
        print(f"[OAUTH ERROR] {e}")
        raise HTTPException(400, str(e))