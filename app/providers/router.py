"""Provider Router - decides which AI model to use based on tier and task."""
from .base import BaseProvider
from .qwen import QwenProvider
from .deepseek import DeepSeekProvider
from .openai import OpenAIProvider

class ProviderRouter:
    def __init__(self):
        self.providers: dict[str, BaseProvider] = {
            "qwen": QwenProvider(),
            "deepseek": DeepSeekProvider(),
            "openai": OpenAIProvider(),
        }

def get_provider(self, task_type: str = "chat", user_context: dict = None) -> BaseProvider:
    user_context = user_context or {}

    deepseek = self.providers.get("deepseek")
    # Use DeepSeek if configured (client exists), else fall back to Qwen
    if deepseek is not None and getattr(deepseek, "client", None) is not None:
        return deepseek
    return self.providers["qwen"]

router = ProviderRouter()