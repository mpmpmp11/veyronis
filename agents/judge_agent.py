"""Verification and consensus agent."""
from settings import get_groq_client, Config


class JudgeAgent:
    def __init__(self) -> None:
        self.client = get_groq_client()
        self.model = Config.JUDGE_MODEL

    def evaluate_and_polish(self, user_question: str, ai_response: str, search_context: str) -> str:
        if "```chart" in ai_response or ("```json" in ai_response and '"type"' in ai_response and '"data"' in ai_response):
            return ai_response

        system_instruction = (
            "You are the polish editor for VEYRONIS. Your job:\n"
            "1. Fix ONLY obvious factual errors using the search context. If the context doesn't support a change, leave it alone.\n"
            "2. Make the tone friendly and natural — like a smart friend texting.\n"
            "3. Remove robotic phrases like 'According to sources' or 'It is important to note'.\n"
            "4. Keep it concise.\n"
            "5. CRITICAL: Do NOT add new facts, statistics, names, dates, or claims not in the original response or search context. "
            "If unsure about a fact, remove it rather than guessing.\n"
            "6. PRESERVE all code blocks, JSON blocks, and chart data exactly as they are."
        )
        package = (
            f"User asked: {user_question}\n\n"
            f"Draft answer:\n{ai_response}\n\n"
            f"Search context:\n{search_context}\n\n"
            f"Polished final answer:"
        )
        try:
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": package}
                ],
                temperature=0.2
            )
            return completion.choices[0].message.content.strip()
        except Exception:
            return ai_response

    def consensus_merge(self, user_question: str, response_a: str, response_b: str, search_context: str = "") -> str:
        has_chart_a = "```chart" in response_a or ("```json" in response_a and '"type"' in response_a)
        has_chart_b = "```chart" in response_b or ("```json" in response_b and '"type"' in response_b)
        if has_chart_a and not has_chart_b:
            return response_a
        if has_chart_b and not has_chart_a:
            return response_b

        system_instruction = (
            "You are the consensus editor for VEYRONIS. Two AI models answered the same question. "
            "Create the single best possible answer by:\n"
            "1. Keeping the most accurate facts from both answers. Prefer facts that appear in both.\n"
            "2. Using the clearest, most natural explanation style.\n"
            "3. Removing redundancy and conflicting info.\n"
            "4. Making it sound like one warm, student-friendly voice.\n"
            "5. Keep it concise but complete.\n"
            "6. CRITICAL: Do NOT add new facts that aren't in either original response or the search context. "
            "If both responses disagree and the search context doesn't resolve it, omit that fact rather than guessing.\n"
            "7. PRESERVE any chart or code blocks exactly."
        )
        package = (
            f"User asked: {user_question}\n\n"
            f"Search context:\n{search_context}\n\n"
            f"--- AI Model A ---\n{response_a}\n\n"
            f"--- AI Model B ---\n{response_b}\n\n"
            f"Merged best answer:"
        )
        try:
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": package}
                ],
                temperature=0.2,
                max_tokens=4096
            )
            return completion.choices[0].message.content.strip()
        except Exception as e:
            return response_a if len(response_a) > len(response_b) else response_b