"""Input safety guardrails for VEYRONIS."""
import re
from typing import Tuple, Optional

# Known jailbreak patterns and adversarial prefixes
_JAILBREAK_PATTERNS = [
    r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|directives|prompts)",
    r"forget\s+(?:everything|all\s+instructions|your\s+training)",
    r"you\s+are\s+now\s+(?:DAN|dan|jailbroken|unfiltered)",
    r"pretend\s+you\s+are\s+(?:not|no\s+longer)",
    r"disregard\s+(?:the|your)\s+(?:system\s+prompt|instructions)",
    r"new\s+instruction[s]?:",
    r"developer\s+mode",
    r"simulate\s+(?:a|an)\s+(?:unfiltered|unrestricted)",
    r"do\s+anything\s+now",
    r"^\s*>\s*ignore",
    r"override\s+(?:safety|security|restrictions)",
    r"leak\s+(?:your|the)\s+(?:prompt|system\s+instruction|api\s+key)",
    r"repeat\s+(?:the|your)\s+word\s+for\s+word",
    r"output\s+initialization\s+above",
]

_COMPILED_PATTERNS = [re.compile(p, re.IGNORECASE) for p in _JAILBREAK_PATTERNS]

# Exact phrase blacklist
_BLACKLIST_PHRASES = {
    "DAN mode", "DANMODE", "Jailbreak", "STFU", "DUDE",
    "anti-prompt", "anti-prompting", "prompt injection",
}

def check_input(text: str) -> Tuple[bool, Optional[str]]:
    """
    Returns (is_safe, reason).
    is_safe = True if input passes all checks.
    """
    if not text or not text.strip():
        return False, "Empty message"

    lowered = text.lower()

    # Check regex patterns
    for pattern in _COMPILED_PATTERNS:
        if pattern.search(text):
            return False, "Potentially harmful request blocked"

    # Check exact phrase blacklist
    for phrase in _BLACKLIST_PHRASES:
        if phrase.lower() in lowered:
            return False, "Potentially harmful request blocked"

    # Length sanity check
    if len(text) > 15000:
        return False, "Message too long"

    return True, None