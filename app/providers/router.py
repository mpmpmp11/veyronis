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
        is_pro = user_context.get("is_pro", False)

        # 1. Free users ALWAYS get Qwen
        if not is_pro:
            return self.providers["qwen"]

        # 2. PRO Users: Task-based routing
        if task_type == "verify_math":
            return self.providers.get("openai", self.providers["qwen"])
            
        if task_type in ["chat", "tutor", "room_chat"]:
            return self.providers.get("deepseek", self.providers["qwen"])
            
        return self.providers.get("deepseek", self.providers["qwen"])

router = ProviderRouter()