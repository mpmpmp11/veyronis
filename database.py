"""SQLite database for chat history and users."""
import sqlite3
import json
from datetime import datetime
from typing import List, Dict, Any, Optional
import os

DB_PATH = "veyronis.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    # Conversations table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Messages table
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
    # Users table (NEW)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            is_pro BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


def _migrate():
    """Add missing columns to existing tables."""
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
        conn.execute(
            "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (conversation_id,)
        )
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
    cursor = conn.execute(
        "INSERT INTO conversations (user_id, title) VALUES (?, ?)",
        (user_id, title)
    )
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
    cursor = conn.execute(
        "UPDATE conversations SET title = ? WHERE id = ?",
        (title, conversation_id)
    )
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


# ─── USERS (NEW) ───
def create_user(email: str, hashed_password: str) -> int:
    conn = get_db()
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
    cursor = conn.execute(
        "SELECT id, email, hashed_password, is_pro FROM users WHERE email = ?",
        (email,)
    )
    user = cursor.fetchone()
    conn.close()
    return user


def get_user_by_id(user_id: int):
    conn = get_db()
    cursor = conn.execute(
        "SELECT id, email, is_pro FROM users WHERE id = ?",
        (user_id,)
    )
    user = cursor.fetchone()
    conn.close()
    return user


def set_user_pro(user_id: int, is_pro: bool = True):
    conn = get_db()
    conn.execute(
        "UPDATE users SET is_pro = ? WHERE id = ?",
        (1 if is_pro else 0, user_id)
    )
    conn.commit()
    conn.close()


# Auto-create table on import + run migrations
init_db()
_migrate()