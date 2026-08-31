"""PostgreSQL database for VEYRONIS — Production Ready with Connection Pooling."""
import contextlib
from datetime import datetime
from typing import List, Dict, Any, Optional

import psycopg2
from psycopg2 import pool
from psycopg2.extras import RealDictCursor

from settings import Config

# Global connection pool
connection_pool = None


@contextlib.contextmanager
def get_db():
    """FastAPI dependency that yields a connection from the pool."""
    global connection_pool
    if connection_pool is None:
        init_db()
    conn = connection_pool.getconn()
    try:
        yield conn
    finally:
        connection_pool.putconn(conn)


def init_db():
    """Initialize the PostgreSQL connection pool and create tables if they don't exist."""
    global connection_pool

    if connection_pool is None:
        connection_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=Config.DATABASE_URL,
            cursor_factory=RealDictCursor
        )

    # Create tables using a connection from the pool
    with get_db() as conn:
        with conn.cursor() as cur:
            # Users table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    hashed_password TEXT,
                    google_id TEXT,
                    avatar_url TEXT,
                    is_pro BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    verification_token TEXT,
                    verification_token_expires TIMESTAMP,
                    is_verified BOOLEAN DEFAULT FALSE,
                    reset_token TEXT,
                    reset_token_expires TIMESTAMP,
                    is_banned BOOLEAN DEFAULT FALSE,
                    ban_reason TEXT,
                    banned_at TIMESTAMP,
                    banned_until TIMESTAMP,
                    lemon_squeezy_customer_id TEXT,
                    lemon_squeezy_subscription_id TEXT,
                    google_play_purchase_token TEXT,
                    subscription_provider TEXT,
                    subscription_status TEXT DEFAULT 'inactive',
                    subscription_ends_at TIMESTAMP
                )
            """)

            # Conversations table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT DEFAULT 'New Chat',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_archived BOOLEAN DEFAULT FALSE
                )
            """)

            # Messages table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    conversation_id INTEGER,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    image_data TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Attachments table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS attachments (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    conversation_id INTEGER,
                    filename TEXT NOT NULL,
                    cloudinary_url TEXT,
                    file_type TEXT,
                    size INTEGER,
                    mime_type TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Usage logs table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS usage_logs (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    count INTEGER DEFAULT 0,
                    UNIQUE(user_id, date)
                )
            """)

            # Simulation logs table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS simulation_logs (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    sim_date TEXT NOT NULL,
                    count INTEGER DEFAULT 0,
                    UNIQUE(user_id, sim_date)
                )
            """)

            # Reports table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS reports (
                    id SERIAL PRIMARY KEY,
                    reporter_user_id TEXT NOT NULL,
                    reported_message_id TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    reviewed_by TEXT,
                    reviewed_at TIMESTAMP,
                    review_notes TEXT
                )
            """)

            # Admin actions table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS admin_actions (
                    id SERIAL PRIMARY KEY,
                    admin_user_id TEXT NOT NULL,
                    target_user_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    reason TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP
                )
            """)

            # Indexes for performance
            cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_usage_logs_user_date ON usage_logs(user_id, date)")

        conn.commit()


def row_to_dict(row):
    return dict(row) if row else None


# ─── MESSAGES ───

def save_message(user_id: str, role: str, content: str, conversation_id: Optional[int] = None, image_data: Optional[str] = None):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages (user_id, role, content, conversation_id, image_data) VALUES (%s, %s, %s, %s, %s)",
                (user_id, role, content, conversation_id, image_data)
            )
            if conversation_id:
                cur.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = %s", (conversation_id,))
        conn.commit()


def get_history(user_id: str, limit: int = 50, conversation_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_db() as conn:
        with conn.cursor() as cur:
            if conversation_id:
                cur.execute(
                    "SELECT role, content, created_at, image_data FROM messages WHERE user_id = %s AND conversation_id = %s ORDER BY id DESC LIMIT %s",
                    (user_id, conversation_id, limit)
                )
            else:
                cur.execute(
                    "SELECT role, content, created_at, image_data FROM messages WHERE user_id = %s AND conversation_id IS NULL ORDER BY id DESC LIMIT %s",
                    (user_id, limit)
                )
            rows = cur.fetchall()
    return [{"role": r["role"], "content": r["content"], "time": r["created_at"], "image_data": r["image_data"]} for r in reversed(rows)]


def clear_history(user_id: str, conversation_id: Optional[int] = None):
    with get_db() as conn:
        with conn.cursor() as cur:
            if conversation_id:
                cur.execute("DELETE FROM messages WHERE user_id = %s AND conversation_id = %s", (user_id, conversation_id))
            else:
                cur.execute("DELETE FROM messages WHERE user_id = %s AND conversation_id IS NULL", (user_id,))
        conn.commit()


# ─── CONVERSATIONS ───

def create_conversation(user_id: str, title: str = "New Chat") -> int:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("INSERT INTO conversations (user_id, title) VALUES (%s, %s) RETURNING id", (user_id, title))
            cid = cur.fetchone()["id"]
        conn.commit()
    return cid


def get_conversations(user_id: str, include_archived: bool = False) -> List[Dict[str, Any]]:
    with get_db() as conn:
        with conn.cursor() as cur:
            if include_archived:
                cur.execute(
                    "SELECT id, title, created_at, updated_at, is_archived FROM conversations WHERE user_id = %s ORDER BY updated_at DESC",
                    (user_id,)
                )
            else:
                cur.execute(
                    "SELECT id, title, created_at, updated_at, is_archived FROM conversations WHERE user_id = %s AND is_archived = FALSE ORDER BY updated_at DESC",
                    (user_id,)
                )
            rows = cur.fetchall()
    return [{"id": r["id"], "title": r["title"], "created_at": r["created_at"], "updated_at": r["updated_at"], "is_archived": bool(r["is_archived"])} for r in rows]


def get_archived_conversations(user_id: str) -> List[Dict[str, Any]]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, title, created_at, updated_at, is_archived FROM conversations WHERE user_id = %s AND is_archived = TRUE ORDER BY updated_at DESC",
                (user_id,)
            )
            rows = cur.fetchall()
    return [{"id": r["id"], "title": r["title"], "created_at": r["created_at"], "updated_at": r["updated_at"], "is_archived": bool(r["is_archived"])} for r in rows]


def rename_conversation(conversation_id: int, title: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE conversations SET title = %s WHERE id = %s", (title, conversation_id))
            changed = cur.rowcount > 0
        conn.commit()
    return changed


def archive_conversation(conversation_id: int, user_id: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE conversations SET is_archived = TRUE WHERE id = %s AND user_id = %s",
                (conversation_id, user_id)
            )
            changed = cur.rowcount > 0
        conn.commit()
    return changed


def unarchive_conversation(conversation_id: int, user_id: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE conversations SET is_archived = FALSE WHERE id = %s AND user_id = %s",
                (conversation_id, user_id)
            )
            changed = cur.rowcount > 0
        conn.commit()
    return changed


def delete_conversation(conversation_id: int):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM messages WHERE conversation_id = %s", (conversation_id,))
            cur.execute("DELETE FROM conversations WHERE id = %s", (conversation_id,))
        conn.commit()


# ─── ATTACHMENTS ───

def save_attachment(user_id: str, conversation_id: int, filename: str, cloudinary_url: str = None,
                    file_type: str = None, size: int = None, mime_type: str = None) -> int:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO attachments (user_id, conversation_id, filename, cloudinary_url, file_type, size, mime_type)
                VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """, (user_id, conversation_id, filename, cloudinary_url, file_type, size, mime_type))
            aid = cur.fetchone()["id"]
        conn.commit()
    return aid


def get_attachments(user_id: str, conversation_id: int) -> List[Dict[str, Any]]:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, filename, cloudinary_url, file_type, size, mime_type, created_at FROM attachments "
                "WHERE user_id = %s AND conversation_id = %s ORDER BY created_at DESC",
                (user_id, conversation_id)
            )
            rows = cur.fetchall()
    return [dict(r) for r in rows]


def delete_attachment(attachment_id: int, user_id: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM attachments WHERE id = %s AND user_id = %s", (attachment_id, user_id))
            deleted = cur.rowcount > 0
        conn.commit()
    return deleted


# ─── USERS ───

def create_user(email: str, hashed_password: str = None, google_id: str = None, avatar_url: str = None) -> int:
    with get_db() as conn:
        with conn.cursor() as cur:
            if google_id:
                existing = cur.execute("SELECT id FROM users WHERE google_id = %s", (google_id,)).fetchone()
                if existing:
                    return existing["id"]

                existing = cur.execute("SELECT id FROM users WHERE email = %s", (email,)).fetchone()
                if existing:
                    cur.execute(
                        "UPDATE users SET google_id = %s, avatar_url = %s WHERE id = %s",
                        (google_id, avatar_url, existing["id"])
                    )
                    conn.commit()
                    return existing["id"]

                cur.execute(
                    "INSERT INTO users (email, google_id, avatar_url, is_pro) VALUES (%s, %s, %s, FALSE) RETURNING id",
                    (email, google_id, avatar_url)
                )
            else:
                if hashed_password is None:
                    raise ValueError("Password required for email registration")
                cur.execute(
                    "INSERT INTO users (email, hashed_password) VALUES (%s, %s) RETURNING id",
                    (email, hashed_password)
                )
            user_id = cur.fetchone()["id"]
        conn.commit()
    return user_id


def get_user_by_email(email: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, email, hashed_password, is_pro, google_id, avatar_url, is_verified, is_banned, ban_reason FROM users WHERE email = %s", (email,))
            row = cur.fetchone()
    return row_to_dict(row)


def get_user_by_id(user_id: int):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, email, is_pro, avatar_url, is_verified, is_banned, ban_reason FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
    return row_to_dict(row)


def get_user_by_google_id(google_id: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, is_pro, avatar_url FROM users WHERE google_id = %s",
                (google_id,)
            )
            row = cur.fetchone()
    return row_to_dict(row)


def link_google_account(user_id: int, google_id: str, avatar_url: str = None):
    with get_db() as conn:
        with conn.cursor() as cur:
            if avatar_url:
                cur.execute(
                    "UPDATE users SET google_id = %s, avatar_url = %s WHERE id = %s",
                    (google_id, avatar_url, user_id)
                )
            else:
                cur.execute(
                    "UPDATE users SET google_id = %s WHERE id = %s",
                    (google_id, user_id)
                )
        conn.commit()


def set_user_pro(user_id: int, is_pro: bool = True):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET is_pro = %s WHERE id = %s", (is_pro, user_id))
        conn.commit()


def update_user_password(user_id: int, hashed_password: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET hashed_password = %s WHERE id = %s", (hashed_password, user_id))
            changed = cur.rowcount > 0
        conn.commit()
    return changed


def delete_user(user_id: int) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            user = get_user_by_id(user_id)
            if not user:
                return False
            email = user["email"]

            cur.execute("""
                DELETE FROM attachments WHERE conversation_id IN 
                (SELECT id FROM conversations WHERE user_id = %s)
            """, (email,))
            cur.execute("""
                DELETE FROM messages WHERE conversation_id IN 
                (SELECT id FROM conversations WHERE user_id = %s)
            """, (email,))
            cur.execute("DELETE FROM conversations WHERE user_id = %s", (email,))
            cur.execute("DELETE FROM usage_logs WHERE user_id = %s", (email,))
            cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
    return True


# ─── AUTH TOKENS ───

def set_verification_token(email: str, token: str, expires):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET verification_token = %s, verification_token_expires = %s WHERE email = %s",
                (token, expires, email)
            )
        conn.commit()


def get_user_by_verification_token(token: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email FROM users WHERE verification_token = %s AND verification_token_expires > CURRENT_TIMESTAMP",
                (token,)
            )
            row = cur.fetchone()
    return row_to_dict(row)


def verify_user(email: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET is_verified = TRUE, verification_token = NULL, verification_token_expires = NULL WHERE email = %s",
                (email,)
            )
        conn.commit()


def set_reset_token(email: str, token: str, expires):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET reset_token = %s, reset_token_expires = %s WHERE email = %s",
                (token, expires, email)
            )
        conn.commit()


def get_user_by_reset_token(token: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, email FROM users WHERE reset_token = %s AND reset_token_expires > CURRENT_TIMESTAMP",
                (token,)
            )
            row = cur.fetchone()
    return row_to_dict(row)


def clear_reset_token(email: str):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE email = %s",
                (email,)
            )
        conn.commit()


# ─── USAGE LIMITS ───

def get_usage_count(user_id: str, date: str) -> int:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count FROM usage_logs WHERE user_id = %s AND date = %s",
                (user_id, date)
            )
            row = cur.fetchone()
    return row["count"] if row else 0


def increment_usage(user_id: str, date: str) -> int:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO usage_logs (user_id, date, count)
                VALUES (%s, %s, 1)
                ON CONFLICT(user_id, date) DO UPDATE SET count = usage_logs.count + 1
                RETURNING count
            """, (user_id, date))
            row = cur.fetchone()
        conn.commit()
    return row["count"] if row else 1


# ─── INIT ───
init_db()