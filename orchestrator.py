"""Central brain with Multi-AI Router."""
import json
import re
import traceback
from tools.calculator import SafeCalculator
from tools.search import WebSearchTool
from tools.image_gen import ImageGenTool
from tools.flashcards import FlashcardTool
from agents.groq_agent import GroqAgent
from agents.gemini_agent import GeminiAgent
from agents.judge_agent import JudgeAgent
from memory.memory import ConversationMemoryPlaceholder
from database import get_history
from settings import Config


class CentralOrchestrator:
    def __init__(self) -> None:
        self.calculator = SafeCalculator()
        self.search_tool = WebSearchTool()
        self.groq_agent = GroqAgent()
        self.judge_agent = JudgeAgent()
        self.memory = ConversationMemoryPlaceholder()
        self.gemini_agent = None
        if Config.gemini_ready():
            try:
                self.gemini_agent = GeminiAgent()
                print("[VEYRONIS] Gemini agent initialized successfully.")
            except Exception as e:
                print(f"[VEYRONIS] Gemini init failed: {e}")
                traceback.print_exc()
                self.gemini_agent = None
        else:
            print("[VEYRONIS] GOOGLE_API_KEY not set. Gemini vision disabled.")

    def _get_history(self, user_id: str, current_query: str, conversation_id: int = None) -> list:
        raw = get_history(user_id, limit=21, conversation_id=conversation_id)
        history = []
        for row in raw:
            if row["role"] == "user" and row["content"] == current_query:
                continue
            history.append({"role": row["role"], "content": row["content"]})
        return history[-20:]

    def _get_model_config(self, model_mode: str) -> dict:
        configs = {
            "instant": {"temperature": 0.3, "max_tokens": 2048},
            "smart":   {"temperature": 0.5, "max_tokens": 4096},
            "genius":  {"temperature": 0.7, "max_tokens": 8192},
        }
        return configs.get(model_mode, configs["instant"])

    def _build_style_modifier(self, response_style: str) -> str:
        modifiers = {
            "concise": "\n\nSTYLE: Be extremely concise. Use short sentences. Avoid fluff. Get to the point immediately.",
            "creative": "\n\nSTYLE: Be creative, expressive, and imaginative. Use vivid language, metaphors, and an engaging narrative voice when appropriate.",
            "technical": "\n\nSTYLE: Be precise and technical. Use proper terminology, structured explanations, and assume the user wants depth and accuracy over simplification.",
            "balanced": ""
        }
        return modifiers.get(response_style, "")

    def _inject_personality(self, system_prompt: str, custom_instructions: str = None, response_style: str = None) -> str:
        if response_style and response_style != "balanced":
            system_prompt += self._build_style_modifier(response_style)
        if custom_instructions and custom_instructions.strip():
            system_prompt += "\n\nUSER CUSTOM INSTRUCTIONS (follow these above all else):\n" + custom_instructions.strip()
        return system_prompt

    def _is_rate_limit_error(self, text: str) -> bool:
        return "[RATE_LIMIT]" in text or "[ERROR]" in text

    def _fallback_to_gemini(self, user_query: str, system_prompt: str, history: list) -> dict:
        """Fallback to Gemini when Groq fails."""
        if not self.gemini_agent:
            return {"response": "⚠️ Both primary and fallback AI models are unavailable. Please try again later.", "reasoning": "Groq failed, Gemini not configured", "citations": []}
        try:
            resp = self.gemini_agent.generate_response(user_query, system_context=system_prompt)
            return {"response": resp + "\n\n_(Fallback: Gemini used due to primary model unavailability)_", "reasoning": "Auto-fallback to Gemini", "citations": []}
        except Exception as e:
            return {"response": f"⚠️ All AI models unavailable. Error: {str(e)}", "reasoning": "Complete failure", "citations": []}

    def _sanitize_chart_blocks(self, text: str) -> str:
        pattern = r"```json\s*\n([\s\S]*?)\n```"
        def replacer(match):
            content = match.group(1).strip()
            try:
                cfg = json.loads(content)
                valid_types = ["bar", "line", "pie", "doughnut", "radar", "polarArea", "scatter", "bubble"]
                if cfg.get("type") in valid_types and "data" in cfg:
                    return f"```chart\n{content}\n```"
            except Exception:
                pass
            return match.group(0)
        return re.sub(pattern, replacer, text)

    def _extract_reasoning(self, text: str) -> tuple:
        pattern = r"<think_reasoning>([\s\S]*?)</think_reasoning>"
        match = re.search(pattern, text)
        if match:
            reasoning = match.group(1).strip()
            cleaned = re.sub(pattern, "", text).strip()
            return reasoning, cleaned
        return None, text

    def _build_vision_prompt(self, user_query: str) -> str:
        """Build vision prompt with fallback for image-only queries."""
        if user_query and user_query.strip() and user_query != "[Image uploaded for analysis]":
            return user_query
        # Default vision prompt for image-only analysis
        return (
            "Analyze this image in detail. Describe what you see in the image, including:\n"
            "1. The main subject(s) and objects\n"
            "2. The setting or environment\n"
            "3. Any visible text or writing\n"
            "4. Colors, lighting, and mood\n"
            "5. Any notable details or patterns\n\n"
            "Be thorough but concise. If there's any text in the image, transcribe it accurately."
        )

    def _optimize_search_query(self, query: str) -> str:
        if len(query.split()) <= 5:
            return query
        try:
            optimized = self.groq_agent.generate_response(
                prompt=f"Convert this user question into a concise, specific web search query (5-10 words max). Return ONLY the search query, nothing else.\n\nUser question: {query}",
                system_context="You are a search query optimizer. Output only the optimized query with no quotes or explanations.",
                temperature=0.1,
                max_tokens=64
            )
            if "failed:" in optimized.lower():
                return query
            return optimized.strip().strip('"').strip("'") or query
        except Exception:
            return query

    def _classify_route(self, query: str) -> str:
        q = query.lower()
        if FlashcardTool.is_flashcard_request(query):
            return "flashcards"
        if ImageGenTool.is_image_request(query):
            return "image"
        if self.calculator.is_math_expression(query):
            return "math"
        creative_triggers = ["write me", "story about", "poem", "song", "fiction", "imagine a", "creative", "make up", "draft", "compose"]
        if any(t in q for t in creative_triggers):
            return "creative" if self.gemini_agent else "standard"
        return "standard"

    def _run_standard(self, query: str, system_prompt: str, history: list, model_mode: str = "instant") -> dict:
        config = self._get_model_config(model_mode)
        search_result = self.search_tool.search(self._optimize_search_query(query))
        search_text = search_result["formatted"]
        citations = search_result.get("results", [])
        full_system = system_prompt + "\n\nWeb Context (use for facts only):\n" + search_text
        base = self.groq_agent.generate_response(
            query,
            system_context=full_system,
            history=history,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )

        # Fallback to Gemini if Groq fails
        if self._is_rate_limit_error(base):
            return self._fallback_to_gemini(query, system_prompt, history)

        if "```chart" in base or ("```json" in base and '"type"' in base and '"data"' in base):
            reasoning, cleaned = self._extract_reasoning(base)
            return {"response": cleaned, "reasoning": reasoning, "citations": citations}

        polished = self.judge_agent.evaluate_and_polish(query, base, search_text)
        reasoning, cleaned = self._extract_reasoning(polished)
        return {"response": cleaned, "reasoning": reasoning, "citations": citations}

    def _run_creative(self, query: str, system_prompt: str, model_mode: str = "instant") -> dict:
        try:
            if self.gemini_agent:
                resp = self.gemini_agent.generate_response(query, system_context=system_prompt)
                return {"response": resp, "reasoning": None, "citations": []}
        except Exception:
            pass
        config = self._get_model_config(model_mode)
        resp = self.groq_agent.generate_response(
            query,
            system_context=system_prompt,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )
        reasoning, cleaned = self._extract_reasoning(resp)
        return {"response": cleaned, "reasoning": reasoning, "citations": []}

    def _run_math(self, query: str, system_prompt: str, history: list, model_mode: str = "instant") -> dict:
        result = self.calculator.evaluate(query)
        steps_prompt = (
            f"Show step-by-step how to solve: {query}\n"
            f"Final answer: {result}\n\n"
            f"Explain like you're teaching a 15-year-old. Number each step. Keep it simple."
        )
        config = self._get_model_config(model_mode)
        explanation = self.groq_agent.generate_response(
            steps_prompt,
            system_context=system_prompt,
            history=history,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )
        reasoning, cleaned = self._extract_reasoning(explanation)
        return {"response": f"🧮 Step-by-Step:\n\n{cleaned}\n\n✅ Answer: {result}", "reasoning": reasoning, "citations": []}

    def _run_image(self, query: str) -> dict:
        url = ImageGenTool.generate(query)
        return {"response": f"![Generated Image]({url})\n\n*Prompt: {query}*", "reasoning": None, "citations": []}

    def _run_flashcards(self, query: str, history: list, model_mode: str = "instant") -> dict:
        config = self._get_model_config(model_mode)

        source_text = query
        if not source_text or len(source_text) < 50:
            for h in reversed(history):
                if h["role"] == "assistant":
                    source_text = h["content"]
                    break

        prompt = (
            f"Create 5-8 study flashcards from the following content. "
            f"Each flashcard must have a question (Q) and answer (A). "
            f"Output ONLY a JSON array in this exact format inside ```flashcards code block:\n"
            f"```flashcards\n"
            f'[{{"q":"Question text","a":"Answer text"}},...]\n'
            f"```\n\n"
            f"Content to extract from:\n{source_text[:4000]}"
        )

        resp = self.groq_agent.generate_response(
            prompt,
            system_context="You are a flashcard generator. Create concise, accurate Q&A pairs for studying.",
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )
        return {"response": resp, "reasoning": "Generated flashcards from content", "citations": []}

    def _run_canvas(self, query: str, system_prompt: str, history: list, model_mode: str = "instant") -> dict:
        """Canvas whiteboard mode - generates structured visualization instructions."""
        config = self._get_model_config(model_mode)

        canvas_prompt = (
            f"Generate a structured visualization for the whiteboard based on this request: {query}\n\n"
            f"Return a JSON object with these keys:\n"
            f"- 'type': 'drawing', 'diagram', 'chart', or 'mindmap'\n"
            f"- 'instructions': step-by-step drawing instructions\n"
            f"- 'elements': array of objects with 'shape', 'x', 'y', 'color', and 'label' properties\n"
            f"- 'title': title for the visualization\n\n"
            f"Make it clear and educational. Use simple shapes that can be drawn on a canvas."
        )

        resp = self.groq_agent.generate_response(
            canvas_prompt,
            system_context="You are a whiteboard visualization assistant. Create clear, structured instructions for drawing on a canvas.",
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )

        reasoning, cleaned = self._extract_reasoning(resp)
        return {"response": cleaned, "reasoning": reasoning or "Canvas visualization generated", "citations": []}

    def _run_research(self, query: str, system_prompt: str, history: list, model_mode: str = "instant", custom_instructions: str = None, response_style: str = None) -> dict:
        """Multi-step deep research: plan → search → synthesize."""
        config = self._get_model_config(model_mode)

        # Step 1: Plan - break into sub-questions
        plan_prompt = (
            f"Break this research question into 3-5 specific sub-questions that will help answer it comprehensively. "
            f"Return ONLY a JSON array of strings, nothing else.\n\nQuestion: {query}"
        )
        plan_raw = self.groq_agent.generate_response(
            plan_prompt,
            system_context="You are a research planner. Output only valid JSON array of sub-questions.",
            temperature=0.3,
            max_tokens=512
        )

        # Extract JSON array
        sub_questions = []
        try:
            # Try to find JSON array in response
            match = re.search(r'\[(.*?)\]', plan_raw.replace('\n', ' '), re.DOTALL)
            if match:
                sub_questions = json.loads('[' + match.group(1) + ']')
            else:
                sub_questions = json.loads(plan_raw)
            if not isinstance(sub_questions, list):
                sub_questions = []
        except Exception:
            # Fallback: split by numbers or newlines
            lines = [l.strip('- ').strip() for l in plan_raw.split('\n') if l.strip() and len(l.strip()) > 10]
            sub_questions = lines[:5] if lines else [query]

        if not sub_questions:
            sub_questions = [query]

        # Step 2: Search each sub-question
        all_citations = []
        all_contexts = []

        for idx, sq in enumerate(sub_questions, 1):
            search_result = self.search_tool.search(sq)
            if search_result.get("results"):
                all_citations.extend(search_result["results"])
                all_contexts.append(f"--- Sub-question {idx}: {sq} ---\n{search_result['formatted']}\n")

        # Deduplicate citations by URL
        seen_urls = set()
        unique_citations = []
        for c in all_citations:
            if c["url"] not in seen_urls:
                seen_urls.add(c["url"])
                c["index"] = len(unique_citations) + 1
                unique_citations.append(c)

        # Renumber
        for i, c in enumerate(unique_citations, 1):
            c["index"] = i

        combined_context = "\n".join(all_contexts)

        # Step 3: Synthesize
        research_system = system_prompt + "\n\nYou are now in DEEP RESEARCH mode. Write a comprehensive, well-structured research report. Use clear section headers, bullet points, and cite sources using [1], [2], etc. Be thorough but concise."
        research_system = self._inject_personality(research_system, custom_instructions, response_style)

        synthesis_prompt = (
            f"Research Question: {query}\n\n"
            f"Based on the following search results, write a comprehensive research report:\n\n"
            f"{combined_context[:8000]}\n\n"
            f"Structure your response with:\n"
            f"1. Executive Summary\n"
            f"2. Key Findings (with citations)\n"
            f"3. Detailed Analysis\n"
            f"4. Conclusion\n\n"
            f"Use markdown formatting. Cite sources using [1], [2], etc."
        )

        report = self.groq_agent.generate_response(
            synthesis_prompt,
            system_context=research_system,
            history=history,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        )

        reasoning, cleaned = self._extract_reasoning(report)
        cleaned = self._sanitize_chart_blocks(cleaned)

        return {
            "response": cleaned,
            "reasoning": reasoning or f"Researched {len(sub_questions)} sub-questions across {len(unique_citations)} sources.",
            "citations": unique_citations,
            "sub_questions": sub_questions
        }

    def _run_research_stream(self, query: str, system_prompt: str, history: list, model_mode: str = "instant", custom_instructions: str = None, response_style: str = None):
        """Streaming deep research with progress updates."""
        config = self._get_model_config(model_mode)

        # Step 1: Plan
        yield ("research_step", {"phase": "planning", "message": "Planning research strategy..."})

        plan_prompt = (
            f"Break this research question into 3-5 specific sub-questions that will help answer it comprehensively. "
            f"Return ONLY a JSON array of strings, nothing else.\n\nQuestion: {query}"
        )
        plan_raw = self.groq_agent.generate_response(
            plan_prompt,
            system_context="You are a research planner. Output only valid JSON array of sub-questions.",
            temperature=0.3,
            max_tokens=512
        )

        sub_questions = []
        try:
            match = re.search(r'\[(.*?)\]', plan_raw.replace('\n', ' '), re.DOTALL)
            if match:
                sub_questions = json.loads('[' + match.group(1) + ']')
            else:
                sub_questions = json.loads(plan_raw)
            if not isinstance(sub_questions, list):
                sub_questions = []
        except Exception:
            lines = [l.strip('- ').strip() for l in plan_raw.split('\n') if l.strip() and len(l.strip()) > 10]
            sub_questions = lines[:5] if lines else [query]

        if not sub_questions:
            sub_questions = [query]

        yield ("research_step", {"phase": "planned", "message": f"Breaking into {len(sub_questions)} research angles...", "sub_questions": sub_questions})

        # Step 2: Search
        all_citations = []
        all_contexts = []

        for idx, sq in enumerate(sub_questions, 1):
            yield ("research_step", {"phase": "searching", "message": f"Searching: {sq[:60]}...", "current": idx, "total": len(sub_questions)})
            search_result = self.search_tool.search(sq)
            if search_result.get("results"):
                all_citations.extend(search_result["results"])
                all_contexts.append(f"--- Sub-question {idx}: {sq} ---\n{search_result['formatted']}\n")

        # Deduplicate
        seen_urls = set()
        unique_citations = []
        for c in all_citations:
            if c["url"] not in seen_urls:
                seen_urls.add(c["url"])
                c["index"] = len(unique_citations) + 1
                unique_citations.append(c)

        for i, c in enumerate(unique_citations, 1):
            c["index"] = i

        yield ("citations", unique_citations)
        yield ("research_step", {"phase": "synthesizing", "message": f"Synthesizing findings from {len(unique_citations)} sources..."})

        # Step 3: Synthesize
        combined_context = "\n".join(all_contexts)
        research_system = system_prompt + "\n\nYou are now in DEEP RESEARCH mode. Write a comprehensive, well-structured research report. Use clear section headers, bullet points, and cite sources using [1], [2], etc. Be thorough but concise."
        research_system = self._inject_personality(research_system, custom_instructions, response_style)

        synthesis_prompt = (
            f"Research Question: {query}\n\n"
            f"Based on the following search results, write a comprehensive research report:\n\n"
            f"{combined_context[:8000]}\n\n"
            f"Structure your response with:\n"
            f"1. Executive Summary\n"
            f"2. Key Findings (with citations)\n"
            f"3. Detailed Analysis\n"
            f"4. Conclusion\n\n"
            f"Use markdown formatting. Cite sources using [1], [2], etc."
        )

        full_text = ""
        for token in self.groq_agent.generate_response_stream(
            synthesis_prompt,
            system_context=research_system,
            history=history,
            temperature=config["temperature"],
            max_tokens=config["max_tokens"]
        ):
            full_text += token
            yield ("token", token)

        reasoning, cleaned = self._extract_reasoning(full_text)
        if reasoning:
            yield ("reasoning", reasoning)

        cleaned = self._sanitize_chart_blocks(cleaned)
        self.memory.save_context(query, cleaned)
        yield ("done", cleaned)

    def process_pipeline(self, user_query: str, mode: str = "chat", user_id: str = "default", conversation_id: int = None, image_b64: str = None, model_mode: str = "instant", ai_model: str = "groq", custom_instructions: str = None, response_style: str = None) -> dict:
        # ─── CANVAS ROUTE ───
        if mode == "canvas":
            history = self._get_history(user_id, user_query, conversation_id)
            system_prompt = "You are VEYRONIS Canvas, an AI that helps users create visualizations on a whiteboard."
            return self._run_canvas(user_query, system_prompt, history, model_mode)

        # ─── VISION ROUTE ───
        if image_b64 and self.gemini_agent:
            vision_prompt = self._build_vision_prompt(user_query)
            try:
                result = self.gemini_agent.generate_vision_response(image_b64, vision_prompt)
                return {"response": result, "reasoning": None, "citations": []}
            except Exception as e:
                print(f"[VEYRONIS] Vision inference failed: {e}")
                traceback.print_exc()
                return {"response": f"⚠️ Vision analysis failed: {str(e)}", "reasoning": None, "citations": []}

        # If image present but no Gemini, warn regardless of text
        if image_b64 and not self.gemini_agent:
            return {"response": "⚠️ Image upload requires a Google API key (Gemini) to be configured in .env", "reasoning": None, "citations": []}

        # ─── AI MODEL ROUTING ───
        if ai_model == "gemini" and self.gemini_agent:
            return self._run_gemini_text(user_query, model_mode)

        history = self._get_history(user_id, user_query, conversation_id)

        system_prompt = (
            "You are VEYRONIS, a friendly, smart AI assistant for students. "
            "You talk like a knowledgeable friend — warm, natural, and never robotic.\n\n"
            "PERSONALITY:\n"
            "- Use emojis where they feel natural 😊\n"
            "- Use markdown: **bold** for emphasis, bullet points for lists, and clear spacing\n"
            "- Be conversational, not encyclopedic\n"
            "- Match the user's energy: casual for casual questions, detailed when they ask for depth\n\n"
            "ANTI-HALLUCINATION:\n"
            "- If you don't know something, say 'I'm not sure' or 'I don't have info on that'\n"
            "- NEVER invent statistics, names, dates, or sources\n"
            "- Use web context for facts, but write naturally. Cite sources using [1], [2], etc. when stating facts from search. Don't say 'According to sources'\n\n"
            "CHARTS:\n"
            "- ONLY include a chart if the user EXPLICITLY asks for one (e.g., 'show me a chart', 'visualize')\n"
            "- When you do, use ```chart with valid Chart.js JSON\n\n"
            "FLASHCARDS:\n"
            "- When generating flashcards, use ```flashcards with valid JSON array of {{q, a}} objects\n\n"
            "REASONING:\n"
            "- For complex questions, wrap step-by-step thinking in <think_reasoning> tags before answering"
        )
        system_prompt = self._inject_personality(system_prompt, custom_instructions, response_style)

        user_lower = user_query.lower().strip()
        casual_keywords = ["hello", "hi", "hey", "how are you", "what's up", "good morning", "good evening", "who are you", "what is your name", "thanks", "thank you", "bye"]
        is_casual = any(k in user_lower for k in casual_keywords) or len(user_query.split()) <= 3

        if ImageGenTool.is_image_request(user_query):
            result = self._run_image(user_query)
            self.memory.save_context(user_query, result["response"])
            return result

        if is_casual:
            config = self._get_model_config(model_mode)
            response = self.groq_agent.generate_response(
                user_query,
                system_context=system_prompt,
                history=history,
                temperature=config["temperature"],
                max_tokens=config["max_tokens"]
            )
            response = self._sanitize_chart_blocks(response)
            reasoning, cleaned = self._extract_reasoning(response)
            self.memory.save_context(user_query, cleaned)
            return {"response": cleaned, "reasoning": reasoning, "citations": []}

        if self.calculator.is_math_expression(user_query):
            result = self._run_math(user_query, system_prompt, history, model_mode)
            result["response"] = self._sanitize_chart_blocks(result["response"])
            self.memory.save_context(user_query, result["response"])
            return result

        route = self._classify_route(user_query)

        if mode == "research":
            result = self._run_research(user_query, system_prompt, history, model_mode, custom_instructions, response_style)
            result["response"] = self._sanitize_chart_blocks(result["response"])
            self.memory.save_context(user_query, result["response"])
            return result

        if route == "flashcards":
            result = self._run_flashcards(user_query, history, model_mode)
        elif route == "creative":
            result = self._run_creative(user_query, system_prompt, model_mode)
        else:
            result = self._run_standard(user_query, system_prompt, history, model_mode)

        result["response"] = self._sanitize_chart_blocks(result["response"])
        self.memory.save_context(user_query, result["response"])
        return result

    def _run_gemini_text(self, user_query: str, model_mode: str = "instant") -> dict:
        """Route text queries to Gemini when explicitly selected."""
        try:
            resp = self.gemini_agent.generate_response(user_query)
            return {"response": resp, "reasoning": None, "citations": []}
        except Exception as e:
            return {"response": f"Gemini failed: {str(e)}. Falling back to Groq.", "reasoning": None, "citations": []}

    def process_pipeline_stream(self, user_query: str, mode: str = "chat", user_id: str = "default", conversation_id: int = None, image_b64: str = None, model_mode: str = "instant", ai_model: str = "groq", custom_instructions: str = None, response_style: str = None):
        """Yield (event_type, content) tuples for real SSE streaming."""

        # ─── CANVAS ROUTE ───
        if mode == "canvas":
            history = self._get_history(user_id, user_query, conversation_id)
            system_prompt = "You are VEYRONIS Canvas, an AI that helps users create visualizations on a whiteboard."
            result = self._run_canvas(user_query, system_prompt, history, model_mode)
            yield ("reasoning", result.get("reasoning", "Generating canvas..."))
            response = result["response"]
            for i in range(0, len(response), 12):
                yield ("token", response[i:i+12])
            yield ("done", response)
            return

        # ─── VISION ROUTE ───
        if image_b64 and self.gemini_agent:
            vision_prompt = self._build_vision_prompt(user_query)
            try:
                yield ("reasoning", "🔍 Analyzing image...")
                result = self.gemini_agent.generate_vision_response(image_b64, vision_prompt)
                yield ("token", result)
                yield ("done", result)
                return
            except Exception as e:
                yield ("error", f"Vision analysis failed: {str(e)}")
                return

        if image_b64 and not self.gemini_agent:
            yield ("error", "Image upload requires a Google API key (Gemini) to be configured in .env")
            return

        # ─── AI MODEL ROUTING ───
        if ai_model == "gemini" and self.gemini_agent:
            yield ("reasoning", "Using Gemini...")
            result = self._run_gemini_text(user_query, model_mode)
            yield ("token", result["response"])
            yield ("done", result["response"])
            return

        history = self._get_history(user_id, user_query, conversation_id)

        system_prompt = (
            "You are VEYRONIS, a friendly, smart AI assistant for students. "
            "You talk like a knowledgeable friend — warm, natural, and never robotic.\n\n"
            "PERSONALITY:\n"
            "- Use emojis where they feel natural 😊\n"
            "- Use markdown: **bold** for emphasis, bullet points for lists, and clear spacing\n"
            "- Be conversational, not encyclopedic\n"
            "- Match the user's energy: casual for casual questions, detailed when they ask for depth\n\n"
            "ANTI-HALLUCINATION:\n"
            "- If you don't know something, say 'I'm not sure' or 'I don't have info on that'\n"
            "- NEVER invent statistics, names, dates, or sources\n"
            "- Use web context for facts, but write naturally. Cite sources using [1], [2], etc. when stating facts from search. Don't cite URLs or say 'According to sources'\n\n"
            "CHARTS:\n"
            "- ONLY include a chart if the user EXPLICITLY asks for one (e.g., 'show me a chart', 'visualize')\n"
            "- When you do, use ```chart with valid Chart.js JSON\n\n"
            "FLASHCARDS:\n"
            "- When generating flashcards, use ```flashcards with valid JSON array of {{q, a}} objects\n\n"
            "REASONING:\n"
            "- For complex questions, wrap step-by-step thinking in <think_reasoning> tags before answering"
        )
        system_prompt = self._inject_personality(system_prompt, custom_instructions, response_style)

        user_lower = user_query.lower().strip()
        casual_keywords = ["hello", "hi", "hey", "how are you", "what's up", "good morning", "good evening", "who are you", "what is your name", "thanks", "thank you", "bye"]
        is_casual = any(k in user_lower for k in casual_keywords) or len(user_query.split()) <= 3

        route = self._classify_route(user_query)

        # ─── RESEARCH MODE ───
        if mode == "research":
            yield from self._run_research_stream(user_query, system_prompt, history, model_mode, custom_instructions, response_style)
            return

        # ─── STREAMING ROUTES: standard + casual ───
        if route == "standard" or is_casual:
            config = self._get_model_config(model_mode)

            search_text = ""
            citations = []
            if route == "standard" and not is_casual:
                yield ("reasoning", "Searching the web for latest info...")
                search_result = self.search_tool.search(self._optimize_search_query(user_query))
                search_text = search_result["formatted"]
                citations = search_result.get("results", [])
                yield ("citations", citations)

            full_system = system_prompt
            if search_text:
                full_system += "\n\nWeb Context (use for facts only):\n" + search_text

            yield ("reasoning", "Thinking...")

            full_text = ""
            fallback_triggered = False
            for token in self.groq_agent.generate_response_stream(
                user_query,
                system_context=full_system,
                history=history,
                temperature=config["temperature"],
                max_tokens=config["max_tokens"]
            ):
                full_text += token
                yield ("token", token)
                if self._is_rate_limit_error(full_text):
                    fallback_triggered = True
                    break

            if fallback_triggered:
                yield ("reasoning", "Primary model unavailable. Switching to fallback...")
                if self.gemini_agent:
                    gemini_resp = self.gemini_agent.generate_response(user_query, system_context=full_system)
                    yield ("token", "\n\n_(Fallback: Gemini used)_\n\n" + gemini_resp)
                    yield ("done", gemini_resp)
                else:
                    yield ("error", "All AI models unavailable. Please try again later.")
                return

            # Post-process after stream completes
            reasoning, cleaned = self._extract_reasoning(full_text)
            if reasoning:
                yield ("reasoning", reasoning)

            cleaned = self._sanitize_chart_blocks(cleaned)
            self.memory.save_context(user_query, cleaned)
            yield ("done", cleaned)
            return

        # ─── NON-STREAMING ROUTES: math, flashcards, image, creative ───
        # Fall back to complete-then-chunk for complex routes
        result = self.process_pipeline(
            user_query, mode, user_id, conversation_id, image_b64, model_mode, ai_model,
            custom_instructions, response_style
        )

        yield ("reasoning", result.get("reasoning", "Processing..."))
        response = result["response"]
        for i in range(0, len(response), 12):
            yield ("token", response[i:i+12])
        yield ("done", response)