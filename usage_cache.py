"""In-memory daily usage counter with periodic flush to Postgres.

Design:
- Fast reads: dict lookup for every limit check
- Batched writes: deltas accumulate in memory, flushed every 60s by scheduler
- Cold start: first read for a user loads today's count from Neon once
- Rollover-safe: deltas carry their own (user_id, day) key, survive midnight
- Multi-worker caveat: only safe on Render free tier (single worker).
  If you ever scale to 2+ workers, replace with Redis.
"""
import threading
from datetime import date
from typing import Dict, Tuple

from database import get_usage_count, flush_usage_delta


class UsageCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: Dict[Tuple[str, str], int] = {}
        self._deltas: Dict[Tuple[str, str], int] = {}
        self._loaded: set = set()
        self._today: str = str(date.today())

    def _rollover_if_needed(self) -> None:
        today = str(date.today())
        if today != self._today:
            self._today = today
            self._counts.clear()
            self._loaded.clear()

    def _ensure_loaded(self, user_id: str) -> Tuple[str, str]:
        key = (user_id, self._today)
        if key not in self._loaded:
            self._counts[key] = get_usage_count(user_id, self._today)
            self._loaded.add(key)
        return key

    def get(self, user_id: str) -> int:
        """Return today's usage count for a user."""
        with self._lock:
            self._rollover_if_needed()
            key = self._ensure_loaded(user_id)
            return self._counts.get(key, 0)

    def increment(self, user_id: str) -> int:
        """Increment in-memory count + stage a delta for the next flush."""
        with self._lock:
            self._rollover_if_needed()
            key = self._ensure_loaded(user_id)
            self._counts[key] = self._counts.get(key, 0) + 1
            self._deltas[key] = self._deltas.get(key, 0) + 1
            return self._counts[key]

    def flush(self) -> Tuple[int, int]:
        """Push accumulated deltas to Neon. Returns (users_flushed, messages_flushed)."""
        with self._lock:
            if not self._deltas:
                return (0, 0)
            snapshot = dict(self._deltas)
            self._deltas.clear()

        users_flushed = 0
        messages_flushed = 0
        failed: list = []
        for (user_id, day), delta in snapshot.items():
            try:
                flush_usage_delta(user_id, day, delta)
                users_flushed += 1
                messages_flushed += delta
            except Exception as e:
                print(f"[USAGE CACHE] Flush failed for {user_id}:{day} (+{delta}): {e}")
                failed.append(((user_id, day), delta))

        if failed:
            with self._lock:
                for key, delta in failed:
                    self._deltas[key] = self._deltas.get(key, 0) + delta

        return (users_flushed, messages_flushed)


usage_cache = UsageCache()