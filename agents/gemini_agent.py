"""Gemini integration agent using google-genai SDK."""
import base64
from google import genai
from google.genai import types
from settings import Config


class GeminiAgent:
    """Gemini agent with auto-fallback models and multi-modal support."""

    MODEL_FALLBACKS = [
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash-image",
        "gemini-3.1-flash-lite",
    ]

    def __init__(self) -> None:
        if not Config.gemini_ready():
            raise ValueError("Gemini not configured. Add GOOGLE_API_KEY to .env")
        # Try v1beta first (AI Studio keys), fall back to v1 (Cloud keys)
        self._clients = []
        for api_ver in ["v1beta", "v1"]:
            try:
                self._clients.append(genai.Client(
                    api_key=Config.GOOGLE_API_KEY,
                    http_options={"api_version": api_ver}
                ))
            except Exception:
                pass
        if not self._clients:
            raise ValueError("Could not create any Gemini client")
        self.model = Config.GEMINI_MODEL

    def _detect_mime(self, data: bytes) -> str:
        """Detect MIME type from file header."""
        if data[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return "image/gif"
        if data[:4] == b"%PDF":
            return "application/pdf"
        return "application/octet-stream"

    def _try_generate(self, contents, config: dict) -> str:
        """Try generating with fallback models, clients, and retry on rate limits."""
        import time
        models = [self.model] + [m for m in self.MODEL_FALLBACKS if m != self.model]
        last_error = None

        for client in self._clients:
            for model_name in models:
                for attempt in range(2):
                    try:
                        response = client.models.generate_content(
                            model=model_name,
                            contents=contents,
                            config=config
                        )
                        # FIX: if text is present, return it; otherwise treat as failure
                        # and continue to next fallback model
                        if response.text:
                            return response.text.strip()
                        # Empty text — log and try next model
                        print(f"[Gemini] {model_name} returned empty response, trying fallback...")
                        last_error = Exception(f"{model_name} returned empty response")
                        break  # break attempt loop, go to next model
                    except Exception as e:
                        last_error = e
                        err_str = str(e).lower()
                        if any(k in err_str for k in ["429", "resource_exhausted", "quota"]):
                            if attempt == 0:
                                print(f"[Gemini] {model_name} rate limited, retrying...")
                                time.sleep(2)
                                continue
                        if any(k in err_str for k in ["404", "not found"]):
                            print(f"[Gemini] {model_name} failed ({e}), trying fallback...")
                            break
                        break

        err_msg = str(last_error)
        if "429" in err_msg.lower() or "resource_exhausted" in err_msg.lower():
            return "[RATE_LIMIT] Gemini quota exceeded. Please wait 60 seconds or upgrade your Google API key."
        if "404" in err_msg.lower() or "not found" in err_msg.lower():
            return (
                "[ERROR] The requested Gemini model was not found.\n\n"
                "This usually means the model name is outdated or not available in your region.\n"
                "VEYRONIS will auto-update model names in future versions."
            )
        if "empty response" in err_msg.lower():
            return "[ERROR] Gemini returned an empty response for all attempted models. The image may be unsupported or the model may have declined to answer. Try adding text to your message or using a different image."
        return f"[ERROR] Gemini inference failed: {err_msg}"

    def generate_response(self, prompt: str, system_context: str = None) -> str:
        """Standard text generation."""
        config = {}
        if system_context:
            config["system_instruction"] = system_context
        return self._try_generate(prompt, config)

    def generate_vision_response(self, image_b64: str, prompt: str, system_context: str = None) -> str:
        """Analyze an image (base64) and answer the prompt."""
        try:
            image_bytes = base64.b64decode(image_b64)
            mime_type = self._detect_mime(image_bytes)

            config = {}
            if system_context:
                config["system_instruction"] = system_context

            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part(text=prompt),
                        types.Part(
                            inline_data=types.Blob(
                                mime_type=mime_type,
                                data=image_bytes
                            )
                        )
                    ]
                )
            ]
            return self._try_generate(contents, config)
        except Exception as e:
            return f"Gemini vision failed: {str(e)}"

    def generate_document_response(self, document_bytes: bytes, filename: str, prompt: str = None, system_context: str = None) -> str:
        """Analyze a document (PDF, DOCX, TXT, MD) using Gemini."""
        try:
            lower = filename.lower()
            if lower.endswith(".pdf"):
                mime_type = "application/pdf"
            elif lower.endswith(".docx"):
                mime_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            elif lower.endswith(".txt") or lower.endswith(".md"):
                mime_type = "text/plain"
            else:
                return f"Unsupported document format: {filename}. Upload PDF, DOCX, TXT, or MD."

            user_prompt = prompt or (
                "Analyze this document thoroughly. Provide:" + "\n" +
                "1. A concise summary" + "\n" +
                "2. Key points and main arguments" + "\n" +
                "3. Any important data, figures, or conclusions" + "\n" +
                "4. Notable sections or headings" + "\n\n" +
                "Be thorough but well-structured."
            )

            config = {}
            if system_context:
                config["system_instruction"] = system_context

            contents = [
                types.Content(
                    role="user",
                    parts=[
                        types.Part(text=user_prompt),
                        types.Part(
                            inline_data=types.Blob(
                                mime_type=mime_type,
                                data=document_bytes
                            )
                        )
                    ]
                )
            ]
            return self._try_generate(contents, config)
        except Exception as e:
            return f"Gemini document analysis failed: {str(e)}"