"""Primary reasoning agent with resilience."""
import time
from typing import Optional, List, Dict, Generator
from settings import get_groq_client, Config

class GroqAgent:
    MAX_RETRIES = 3
    BASE_DELAY = 1.0

    def __init__(self) -> None:
        self.client = get_groq_client()
        self.model = Config.GROQ_MODEL

    def _is_rate_limit(self, error: Exception) -> bool:
        err_str = str(error).lower()
        return any(k in err_str for k in ["429", "rate_limit", "too many requests", "quota"])

    def _is_server_error(self, error: Exception) -> bool:
        err_str = str(error).lower()
        return any(k in err_str for k in ["500", "502", "503", "504", "timeout", "connection"])

    def generate_response(
        self,
        prompt: str,
        system_context: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096
    ) -> str:
        """Non-streaming response with retry."""
        messages = []
        if system_context:
            messages.append({"role": "system", "content": system_context})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})

        last_error = None
        for attempt in range(self.MAX_RETRIES):
            try:
                completion = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=False
                )
                return completion.choices[0].message.content.strip()
            except Exception as e:
                last_error = e
                if self._is_rate_limit(e) and attempt < self.MAX_RETRIES - 1:
                    delay = self.BASE_DELAY * (2 ** attempt)
                    time.sleep(delay)
                    continue
                elif self._is_server_error(e) and attempt < self.MAX_RETRIES - 1:
                    time.sleep(self.BASE_DELAY)
                    continue
                break

        err_msg = str(last_error)
        if self._is_rate_limit(last_error):
            return "[RATE_LIMIT] Groq rate limit hit. Please wait a moment and try again."
        return f"[ERROR] Groq inference failed: {err_msg}"

    def generate_response_stream(
        self,
        prompt: str,
        system_context: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        temperature: float = 0.3,
        max_tokens: int = 4096
    ) -> Generator[str, None, None]:
        """Streaming response with retry."""
        messages = []
        if system_context:
            messages.append({"role": "system", "content": system_context})
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": prompt})

        last_error = None
        for attempt in range(self.MAX_RETRIES):
            try:
                completion = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=True
                )
                for chunk in completion:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
                return
            except Exception as e:
                last_error = e
                if self._is_rate_limit(e) and attempt < self.MAX_RETRIES - 1:
                    delay = self.BASE_DELAY * (2 ** attempt)
                    yield f"[RETRYING] Rate limited. Retrying in {delay}s...\n"
                    time.sleep(delay)
                    continue
                elif self._is_server_error(e) and attempt < self.MAX_RETRIES - 1:
                    yield "[RETRYING] Server error. Retrying...\n"
                    time.sleep(self.BASE_DELAY)
                    continue
                break

        err_msg = str(last_error)
        if self._is_rate_limit(last_error):
            yield "[RATE_LIMIT] Groq rate limit hit. Please wait a moment and try again."
        else:
            yield f"[ERROR] Groq inference failed: {err_msg}"