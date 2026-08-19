"""Image generation tool."""
import urllib.parse
import requests
from typing import Optional


class ImageGenTool:
    """Free image generation via Pollinations.ai (no API key required)."""
    
    @staticmethod
    def generate(prompt: str, width: int = 1024, height: int = 1024) -> Optional[str]:
        encoded = urllib.parse.quote(prompt)
        url = f"https://image.pollinations.ai/prompt/{encoded}?width={width}&height={height}&nologo=true&seed=42&enhance=true"
        # Pollinations returns the image directly; we return the URL which will render inline
        return url
    
    @staticmethod
    def is_image_request(query: str) -> bool:
        q = query.lower()
        triggers = [
            "draw me", "draw a", "generate an image", "generate image", "create an image",
            "make an image", "image of", "picture of", "photo of", "render", "illustration of",
            "art of", "sketch", "paint", "visualize", "show me a picture", "show me an image"
        ]
        return any(t in q for t in triggers)