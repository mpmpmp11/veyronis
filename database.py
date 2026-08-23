"""SQLite database for chat history, users, and usage limits."""
import sqlite3
from datetime import datetime
from typing import List, Dict, Any, Optional
import os

DB_PATH = "veyronis.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def row_to_dict(row):
    """Convert sqlite3.Row to dict for safe attribute access."""
    return dict(row) if row else None

def ensure_users_table():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            hashed_password TEXT,
            google_id TEXT,
            avatar_url TEXT,
            is_pro BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

def ensure_google_columns():
    """Add google_id and avatar_url columns to users table if they don't exist."""
    conn = get_db()
    cursor = conn.execute("PRAGMA table_info(users)")
    columns = [row["name"] for row in cursor.fetchall()]
    
    if "google_id" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN google_id TEXT")
        print("[VEYRONIS] Added google_id column to users")
    
    if "avatar_url" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
        print("[VEYRONIS] Added avatar_url column to users")
    
    conn.commit()
    conn.close()
    
    # Create unique index for google_id (ignoring NULLs)
    try:
        conn = get_db()
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL")
        conn.commit()
        print("[VEYRONIS] Created unique index on google_id")
    except sqlite3.OperationalError as e:
        print(f"[VEYRONIS] Note: {e}")
    finally:
        conn.close()

def ensure_usage_table():
    """Create usage_logs table if it doesn't exist."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS usage_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            date TEXT NOT NULL,
            count INTEGER DEFAULT 0,
            UNIQUE(user_id, date)
        )
    """)
    conn.commit()
    conn.close()
    print("[VEYRONIS] Usage logs table ready")

def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            conversation_id INTEGER,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            image_data TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

def _migrate():
    conn = get_db()
    cursor = conn.execute("PRAGMA table_info(messages)")
    columns = [row["name"] for row in cursor.fetchall()]
    if "conversation_id" not in columns:
        conn.execute("ALTER TABLE messages ADD COLUMN conversation_id INTEGER")
    if "image_data" not in columns:
        conn.execute("ALTER TABLE messages ADD COLUMN image_data TEXT")
    conn.commit()
    conn.close()

# ─── MESSAGES ───

def save_message(user_id: str, role: str, content: str, conversation_id: Optional[int] = None, image_data: Optional[str] = None):
    conn = get_db()
    conn.execute(
        "INSERT INTO messages (user_id, role, content, conversation_id, image_data) VALUES (?, ?, ?, ?, ?)",
        (user_id, role, content, conversation_id, image_data)
    )
    if conversation_id:
        conn.execute("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (conversation_id,))
    conn.commit()
    conn.close()

def get_history(user_id: str, limit: int = 50, conversation_id: Optional[int] = None) -> List[Dict[str, Any]]:
    conn = get_db()
    if conversation_id:
        cursor = conn.execute(
            "SELECT role, content, created_at, image_data FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, conversation_id, limit)
        )
    else:
        cursor = conn.execute(
            "SELECT role, content, created_at, image_data FROM messages WHERE user_id = ? AND conversation_id IS NULL ORDER BY id DESC LIMIT ?",
            (user_id, limit)
        )
    rows = cursor.fetchall()
    conn.close()
    return [{"role": r["role"], "content": r["content"], "time": r["created_at"], "image_data": r["image_data"]} for r in reversed(rows)]

def clear_history(user_id: str, conversation_id: Optional[int] = None):
    conn = get_db()
    if conversation_id:
        conn.execute("DELETE FROM messages WHERE user_id = ? AND conversation_id = ?", (user_id, conversation_id))
    else:
        conn.execute("DELETE FROM messages WHERE user_id = ? AND conversation_id IS NULL", (user_id,))
    conn.commit()
    conn.close()

# ─── CONVERSATIONS ───

def create_conversation(user_id: str, title: str = "New Chat") -> int:
    conn = get_db()
    cursor = conn.execute("INSERT INTO conversations (user_id, title) VALUES (?, ?)", (user_id, title))
    conn.commit()
    cid = cursor.lastrowid
    conn.close()
    return cid

def get_conversations(user_id: str) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC",
        (user_id,)
    )
    rows = cursor.fetchall()
    conn.close()
    return [{"id": r["id"], "title": r["title"], "created_at": r["created_at"], "updated_at": r["updated_at"]} for r in rows]

def rename_conversation(conversation_id: int, title: str) -> bool:
    conn = get_db()
    cursor = conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id))
    conn.commit()
    changed = cursor.rowcount > 0
    conn.close()
    return changed

def delete_conversation(conversation_id: int):
    conn = get_db()
    conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
    conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    conn.commit()
    conn.close()

# ─── USERS ───

def create_user(email: str, hashed_password: str = None, google_id: str = None, avatar_url: str = None) -> int:
    conn = get_db()
    
    if google_id:
        existing = conn.execute("SELECT id FROM users WHERE google_id = ?", (google_id,)).fetchone()
        if existing:
            conn.close()
            return existing["id"]
        
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            conn.execute(
                "UPDATE users SET google_id = ?, avatar_url = ? WHERE id = ?",
                (google_id, avatar_url, existing["id"])
            )
            conn.commit()
            conn.close()
            return existing["id"]
        
        cursor = conn.execute(
            "INSERT INTO users (email, google_id, avatar_url, is_pro) VALUES (?, ?, ?, 0)",
            (email, google_id, avatar_url)
        )
    else:
        if hashed_password is None:
            raise ValueError("Password required for email registration")
        cursor = conn.execute(
            "INSERT INTO users (email, hashed_password) VALUES (?, ?)",
            (email, hashed_password)
        )
    
    conn.commit()
    user_id = cursor.lastrowid
    conn.close()
    return user_id

def get_user_by_email(email: str):
    conn = get_db()
    cursor = conn.execute("SELECT id, email, hashed_password, is_pro, google_id, avatar_url FROM users WHERE email = ?", (email,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)

def get_user_by_id(user_id: int):
    conn = get_db()
    cursor = conn.execute("SELECT id, email, is_pro, avatar_url FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)

def get_user_by_google_id(google_id: str):
    conn = get_db()
    cursor = conn.execute(
        "SELECT id, email, is_pro, avatar_url FROM users WHERE google_id = ?",
        (google_id,)
    )
    row = cursor.fetchone()
    conn.close()
    return row_to_dict(row)

def link_google_account(user_id: int, google_id: str, avatar_url: str = None):
    conn = get_db()
    if avatar_url:
        conn.execute(
            "UPDATE users SET google_id = ?, avatar_url = ? WHERE id = ?",
            (google_id, avatar_url, user_id)
        )
    else:
        conn.execute(
            "UPDATE users SET google_id = ? WHERE id = ?",
            (google_id, user_id)
        )
    conn.commit()
    conn.close()

def set_user_pro(user_id: int, is_pro: bool = True):
    conn = get_db()
    conn.execute("UPDATE users SET is_pro = ? WHERE id = ?", (1 if is_pro else 0, user_id))
    conn.commit()
    conn.close()

def delete_user(user_id: int) -> bool:
    """Permanently delete a user and all associated data (GDPR compliant)."""
    conn = get_db()
    try:
        user = get_user_by_id(user_id)
        if not user:
            return False
        email = user["email"]
        
        # Delete messages from conversations
        conn.execute("""
            DELETE FROM messages WHERE conversation_id IN 
            (SELECT id FROM conversations WHERE user_id = ?)
        """, (email,))
        
        # Delete conversations
        conn.execute("DELETE FROM conversations WHERE user_id = ?", (email,))
        
        # Delete usage logs
        conn.execute("DELETE FROM usage_logs WHERE user_id = ?", (email,))
        
        # Delete user
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        
        conn.commit()
        return True
    except Exception as e:
        print(f"[DELETE USER ERROR] {e}")
        conn.rollback()
        return False
    finally:
        conn.close()

# ─── USAGE LIMITS ───

def get_usage_count(user_id: str, date: str) -> int:
    conn = get_db()
    row = conn.execute(
        "SELECT count FROM usage_logs WHERE user_id = ? AND date = ?",
        (user_id, date)
    ).fetchone()
    conn.close()
    return row["count"] if row else 0

def increment_usage(user_id: str, date: str) -> int:
    conn = get_db()
    conn.execute("""
        INSERT INTO usage_logs (user_id, date, count)
        VALUES (?, ?, 1)
        ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
    """, (user_id, date))
    conn.commit()
    row = conn.execute(
        "SELECT count FROM usage_logs WHERE user_id = ? AND date = ?",
        (user_id, date)
    ).fetchone()
    conn.close()
    return row["count"] if row else 0

# ─── INIT ───
init_db()
_migrate()
ensure_users_table()
ensure_google_columns()
ensure_usage_table()