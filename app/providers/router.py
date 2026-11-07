"""Provider Router - decides which AI model to use."""
from .base import BaseProvider
from .qwen import QwenProvider

class ProviderRouter:
    def __init__(self):
        self.providers: dict[str, BaseProvider] = {
            "qwen": QwenProvider(),
        }

    def get_provider(self, task_type: str = "chat", user_context: dict = None) -> BaseProvider:
        user_context = user_context or {}
        return self.providers["qwen"]

router = ProviderRouter()