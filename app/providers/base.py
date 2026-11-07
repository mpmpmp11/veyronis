"""Base Provider Interface for all AI models."""
from abc import ABC, abstractmethod
from typing import Iterator, List, Dict, Any

class BaseProvider(ABC):
    """Abstract base class that all AI providers must implement."""

    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @property
    @abstractmethod
    def capabilities(self) -> List[str]:
        pass

    @abstractmethod
    def generate(self, messages: List[Dict[str, str]], **kwargs) -> str:
        pass

    @abstractmethod
    def generate_stream(self, messages: List[Dict[str, str]], **kwargs) -> Iterator[str]:
        pass

    @abstractmethod
    def estimate_cost(self, tokens_in: int, tokens_out: int) -> float:
        """Estimate the cost of a request in cents."""
        pass