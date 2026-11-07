"""Qwen Provider (running via Groq)."""
from typing import Iterator, List, Dict
from .base import BaseProvider
from agents.groq_agent import GroqAgent
from settings import Config

class QwenProvider(BaseProvider):
    def __init__(self):
        self.agent = GroqAgent()
        self.model_id = Config.GROQ_MODEL

    @property
    def name(self) -> str:
        return "qwen"

    @property
    def capabilities(self) -> List[str]:
        return ["text", "tools"]

    def generate(self, messages: List[Dict[str, str]], **kwargs) -> str:
        prompt = messages[-1]["content"] if messages else ""
        system_context = next((m["content"] for m in messages if m["role"] == "system"), None)
        history = [m for m in messages[:-1] if m["role"] != "system"]

        return self.agent.generate_response(
            prompt=prompt, system_context=system_context, history=history, **kwargs
        )

    def generate_stream(self, messages: List[Dict[str, str]], **kwargs) -> Iterator[str]:
        prompt = messages[-1]["content"] if messages else ""
        system_context = next((m["content"] for m in messages if m["role"] == "system"), None)
        history = [m for m in messages[:-1] if m["role"] != "system"]

        yield from self.agent.generate_response_stream(
            prompt=prompt, system_context=system_context, history=history, **kwargs
        )

    def estimate_cost(self, tokens_in: int, tokens_out: int) -> float:
        cost_usd = ((tokens_in / 1_000_000) * 0.80) + ((tokens_out / 1_000_000) * 4.00)
        return cost_usd * 100