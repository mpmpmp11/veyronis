"""OpenAI Provider."""
from typing import Iterator, List, Dict
from openai import OpenAI
from .base import BaseProvider
import os

class OpenAIProvider(BaseProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "")
        self.client = OpenAI(api_key=self.api_key) if self.api_key else None
        self.model_id = "gpt-4o-mini"

    @property
    def name(self) -> str: return "openai"

    @property
    def capabilities(self) -> List[str]: return ["text", "vision", "tools"]

    def generate(self, messages: List[Dict[str, str]], **kwargs) -> dict:
        if not self.client:
            return {"text": "[ERROR] OpenAI API key is missing.", "tokens_in": 0, "tokens_out": 0}
        try:
            response = self.client.chat.completions.create(model=self.model_id, messages=messages, **kwargs)
            return {
                "text": response.choices[0].message.content.strip(),
                "tokens_in": response.usage.prompt_tokens,
                "tokens_out": response.usage.completion_tokens
            }
        except Exception as e:
            return {"text": f"[ERROR] OpenAI failed: {str(e)}", "tokens_in": 0, "tokens_out": 0}

    def generate_stream(self, messages: List[Dict[str, str]], **kwargs) -> Iterator[str]:
        if not self.client:
            yield "[ERROR] OpenAI API key is missing."
            return
        try:
            stream = self.client.chat.completions.create(model=self.model_id, messages=messages, stream=True, **kwargs)
            for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            yield f"[ERROR] OpenAI stream failed: {str(e)}"

    def estimate_cost(self, tokens_in: int, tokens_out: int) -> float:
        return (((tokens_in / 1_000_000) * 0.15) + ((tokens_out / 1_000_000) * 0.60)) * 100