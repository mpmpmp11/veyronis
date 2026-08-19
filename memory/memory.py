"""Memory placeholder."""
from typing import Any, List, Dict

class ConversationMemoryPlaceholder:
    def __init__(self) -> None:
        self._history: List[Dict[str, Any]] = []
    
    def save_context(self, user_input: str, final_output: str) -> None:
        self._history.append({"user": user_input, "assistant": final_output})
    
    def fetch_all_history(self) -> List[Dict[str, Any]]:
        return self._history
    
    def clear(self) -> None:
        self._history.clear()