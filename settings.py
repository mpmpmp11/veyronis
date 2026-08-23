"""
VEYRONIS AI - Final Configuration Module
Includes: 
- Pro/Standard user model logic
- 2026 Groq Official Model IDs
- Rate-limit fallback to Gemini
- Google OAuth configuration
- JWT Secret enforcement
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from groq import Groq
from tavily import TavilyClient

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"

def _strip_bom_from_env():
    """Remove UTF-8 BOM that Windows Notepad adds so dotenv can read the first line."""
    if not ENV_PATH.exists():
        return
    raw = ENV_PATH.read_bytes()
    if raw.startswith(b'\xef\xbb\xbf'):
        ENV_PATH.write_bytes(raw[3:])
        print("[VEYRONIS] Fixed .env file (removed BOM).")

_strip_bom_from_env()
load_dotenv(dotenv_path=ENV_PATH)

class Config:
    # API Keys
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "").strip()
    TAVILY_API_KEY: str = os.getenv("TAVILY_API_KEY", "").strip()
    GOOGLE_API_KEY: str = os.getenv("GOOGLE_API_KEY", "").strip()

    # Google OAuth
    GOOGLE_CLIENT_ID: str = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    GOOGLE_CLIENT_SECRET: str = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()

    # JWT Secret (MUST be set in .env)
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "").strip()

    # Official 2026 Model IDs
    MODEL_ULTRA: str = "openai/gpt-oss-120b"      # Smartest MoE model
    MODEL_STABLE: str = "llama-3.3-70b-versatile"  # Standard high-tier
    GEMINI_MODEL: str = "gemini-1.5-flash-latest"

    GROQ_MODEL: str = MODEL_ULTRA 
    JUDGE_MODEL: str = MODEL_ULTRA

    @classmethod
    def get_model(cls, is_pro: bool = False, is_limited: bool = False) -> str:
        if is_limited:
            return cls.GEMINI_MODEL
        return cls.MODEL_ULTRA if is_pro else cls.MODEL_STABLE

    @classmethod
    def validate(cls) -> None:
        if not cls.GROQ_API_KEY:
            raise ValueError("Missing GROQ_API_KEY in .env file.")
        if not cls.TAVILY_API_KEY:
            raise ValueError("Missing TAVILY_API_KEY in .env file.")

    @classmethod
    def gemini_ready(cls) -> bool:
        return bool(cls.GOOGLE_API_KEY)

    @classmethod
    def google_oauth_ready(cls) -> bool:
        return bool(cls.GOOGLE_CLIENT_ID and cls.GOOGLE_CLIENT_SECRET)

    @classmethod
    def validate_jwt(cls) -> None:
        """Enforce JWT secret is set and secure."""
        if not cls.JWT_SECRET_KEY or len(cls.JWT_SECRET_KEY) < 16:
            raise ValueError(
                "\n" + "=" * 60 + "\n"
                "❌ JWT_SECRET_KEY must be set in .env and be at least 16 characters.\n"
                "Generate one with: python -c 'import secrets; print(secrets.token_urlsafe(32))'\n"
                "Or use: openssl rand -base64 32\n"
                "=" * 60
            )

def get_groq_client() -> Groq:
    Config.validate()
    return Groq(api_key=Config.GROQ_API_KEY)

def get_tavily_client() -> TavilyClient:
    Config.validate()
    return TavilyClient(api_key=Config.TAVILY_API_KEY)