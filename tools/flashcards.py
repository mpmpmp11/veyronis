"""Flashcard generation tool."""
import re


class FlashcardTool:
    FLASHCARD_TRIGGERS = [
        "flashcard", "flash card", "study card", "quiz me", "test me on",
        "make flashcards", "generate flashcards", "create flashcards",
        "q and a", "question and answer", "drill me on"
    ]
    
    @classmethod
    def is_flashcard_request(cls, query: str) -> bool:
        q = query.lower()
        return any(t in q for t in cls.FLASHCARD_TRIGGERS)