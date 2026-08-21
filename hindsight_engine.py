"""VEYRONIS HINDSIGHT -- Simulation Engine
Production-ready scenario simulation with Pydantic validation,
prompt chaining, and server-side SQLite rate limiting.
"""
import json
import sqlite3
import traceback
from datetime import date
from typing import List, Optional, Tuple
from pydantic import BaseModel, Field, validator
from settings import get_groq_client, Config


# =============================================================================
# PYDANTIC DATA CONTRACTS
# =============================================================================

class SimulationStep(BaseModel):
    step_number: int
    title: str = Field(description="Short chronological anchor, e.g., 'Day 3' or 'Phase 1'.")
    state: str = Field(description="The current operational or situational environment at this step.")
    consequences: List[str] = Field(description="Direct secondary and compounding impacts triggered by this state.")
    assumptions: List[str] = Field(description="Underlying logical premises or operational data this step relies on.")
    confidence: float = Field(description="The factual probability score ranging strictly from 0.0 to 1.0.")

    @validator("confidence")
    def clamp_confidence(cls, v):
        return max(0.0, min(1.0, float(v)))


class HindsightResponse(BaseModel):
    initial_scenario: str = Field(description="The original user-provided input plan or action.")
    timeline: List[SimulationStep] = Field(description="Chronological step-by-step impact sequence.")
    butterfly_effect: str = Field(description="The specific critical turning point where small deviations created major shifts.")
    hindsight_advice: str = Field(description="Actionable strategic synthesis advising the user what to modify in the present day.")


# =============================================================================
# SQLITE RATE LIMITING
# =============================================================================

class SimulationLimiter:
    DB_PATH = "veyronis.db"

    @classmethod
    def _get_db(cls):
        conn = sqlite3.connect(cls.DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn

    @classmethod
    def ensure_table(cls):
        conn = cls._get_db()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS simulation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sim_date TEXT NOT NULL,
                count INTEGER DEFAULT 0,
                UNIQUE(user_id, sim_date)
            )
        """)
        conn.commit()
        conn.close()

    @classmethod
    def get_count(cls, user_id: str, sim_date: str) -> int:
        conn = cls._get_db()
        row = conn.execute(
            "SELECT count FROM simulation_logs WHERE user_id = ? AND sim_date = ?",
            (user_id, sim_date)
        ).fetchone()
        conn.close()
        return row["count"] if row else 0

    @classmethod
    def increment(cls, user_id: str, sim_date: str):
        conn = cls._get_db()
        conn.execute("""
            INSERT INTO simulation_logs (user_id, sim_date, count)
            VALUES (?, ?, 1)
            ON CONFLICT(user_id, sim_date) DO UPDATE SET count = count + 1
        """, (user_id, sim_date))
        conn.commit()
        conn.close()


# Init table on module load
SimulationLimiter.ensure_table()


# =============================================================================
# HINDSIGHT ENGINE
# =============================================================================

class HindsightEngine:
    """Scenario simulation engine with iterative prompt chaining."""

    SYSTEM_PROMPT = (
        "You are VEYRONIS HINDSIGHT, a scenario simulation engine. "
        "Your job is to simulate the chronological consequences of a user-provided plan or scenario. "
        "Think step-by-step. Each step builds on the previous. "
        "Be realistic, specific, and grounded. Use the user's context (student life, academics, projects). "
        "Output ONLY valid JSON matching the requested schema. No markdown, no explanations outside JSON."
    )

    def __init__(self):
        self.client = get_groq_client()
        self.model = Config.GROQ_MODEL

    # ─── Rate Limit Check ───
    def check_simulation_limit(self, user_id: str, is_pro: bool) -> Tuple[bool, str]:
        today = str(date.today())
        count = SimulationLimiter.get_count(user_id, today)
        limit = 20 if is_pro else 1
        if count >= limit:
            msg = (
                "PRO daily limit reached (20/day)." if is_pro
                else "Free tier: 1 simulation/day. Upgrade to PRO for 20/day!"
            )
            return False, msg
        return True, ""

    # ─── Core Simulation ───
    def simulate(self, scenario: str, max_steps: int = 3) -> HindsightResponse:
        """Run the full simulation pipeline."""
        timeline = self._build_timeline(scenario, max_steps)
        butterfly = self._extract_butterfly(timeline)
        advice = self._generate_advice(scenario, timeline)

        return HindsightResponse(
            initial_scenario=scenario,
            timeline=timeline,
            butterfly_effect=butterfly,
            hindsight_advice=advice
        )

    def _build_timeline(self, scenario: str, max_steps: int) -> List[SimulationStep]:
        """Iterative prompt-chained timeline generation."""
        timeline: List[SimulationStep] = []
        context_so_far = ""

        for step_num in range(1, max_steps + 1):
            step = self._generate_step(scenario, step_num, context_so_far)
            timeline.append(step)
            # Carry forward context for next iteration
            context_so_far += (
                f"\n--- Step {step_num}: {step.title} ---\n"
                f"State: {step.state}\n"
                f"Consequences: {', '.join(step.consequences)}\n"
                f"Assumptions: {', '.join(step.assumptions)}\n"
                f"Confidence: {step.confidence}\n"
            )

        return timeline

    def _generate_step(self, scenario: str, step_num: int, previous_context: str) -> SimulationStep:
        """Generate a single simulation step via Groq with JSON mode."""

        prompt = self._build_step_prompt(scenario, step_num, previous_context)

        try:
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.4,
                max_tokens=2048,
                response_format={"type": "json_object"}
            )

            raw_json = completion.choices[0].message.content.strip()
            data = json.loads(raw_json)

            return SimulationStep(
                step_number=step_num,
                title=data.get("title", f"Step {step_num}"),
                state=data.get("state", ""),
                consequences=data.get("consequences", []),
                assumptions=data.get("assumptions", []),
                confidence=data.get("confidence", 0.5)
            )

        except Exception as e:
            print(f"[HINDSIGHT STEP ERROR] step={step_num}: {e}")
            traceback.print_exc()
            # Return a graceful fallback step
            return SimulationStep(
                step_number=step_num,
                title=f"Phase {step_num}",
                state="Unable to simulate this phase due to a processing error.",
                consequences=["Simulation interrupted"],
                assumptions=["System encountered an error"],
                confidence=0.0
            )

    def _build_step_prompt(self, scenario: str, step_num: int, previous_context: str) -> str:
        """Construct the prompt for a single step with context carry-forward."""

        if step_num == 1:
            return f"""Simulate STEP 1 of the following scenario.

SCENARIO: {scenario}

Return ONLY a JSON object with these exact keys:
- "title": a short label like "Day 1" or "Phase 1" or "Week 1"
- "state": describe the current situation/environment at this step
- "consequences": array of 2-4 direct impacts triggered by this state
- "assumptions": array of 2-3 logical premises this step relies on
- "confidence": a float from 0.0 to 1.0 representing how likely this outcome is

Be specific, realistic, and grounded in student/academic context."""

        else:
            return f"""Simulate STEP {step_num} of the following scenario.

ORIGINAL SCENARIO: {scenario}

PREVIOUS CONTEXT:
{previous_context}

Build directly on the previous step. Show how the consequences from Step {step_num - 1} evolve into the new state. Maintain consistency with previous assumptions.

Return ONLY a JSON object with these exact keys:
- "title": a short chronological label
- "state": the new situation after previous consequences unfolded
- "consequences": array of 2-4 new direct impacts
- "assumptions": array of 2-3 updated logical premises
- "confidence": a float from 0.0 to 1.0

Make sure this step logically follows from the previous state."""

    def _extract_butterfly(self, timeline: List[SimulationStep]) -> str:
        """Identify the critical turning point across the timeline."""
        if not timeline:
            return "No timeline data available."

        # Build a summary of the timeline for the LLM
        summary = "\n".join([
            f"Step {s.step_number} ({s.title}): {s.state} | Consequences: {', '.join(s.consequences)}"
            for s in timeline
        ])

        prompt = f"""Analyze this simulation timeline and identify the SINGLE most critical turning point -- the "butterfly effect" moment where a small early decision or event created disproportionately large downstream consequences.

TIMELINE:
{summary}

Return ONLY a concise paragraph (2-4 sentences) describing this turning point and why it mattered. Be specific and insightful."""

        try:
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5,
                max_tokens=512
            )
            return completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"[BUTTERFLY ERROR] {e}")
            return "A critical turning point occurred early in the timeline, where small deviations compounded into significant downstream effects."

    def _generate_advice(self, scenario: str, timeline: List[SimulationStep]) -> str:
        """Generate actionable hindsight advice."""
        summary = "\n".join([
            f"Step {s.step_number} ({s.title}): {s.state}"
            for s in timeline
        ])

        prompt = f"""Based on this simulated timeline, provide actionable strategic advice to the user about what they should do DIFFERENTLY in the present day to avoid negative outcomes or amplify positive ones.

ORIGINAL SCENARIO: {scenario}

SIMULATED TIMELINE:
{summary}

Return ONLY a concise, actionable paragraph (3-5 sentences). Be direct, practical, and encouraging. Focus on what the user can control right now."""

        try:
            completion = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.4,
                max_tokens=512
            )
            return completion.choices[0].message.content.strip()
        except Exception as e:
            print(f"[ADVICE ERROR] {e}")
            return "Review the simulated timeline carefully. The earliest decisions often have the largest impact on final outcomes. Consider adjusting your approach at the initial stages."

    # ─── Public: Run with limit tracking ───
    def run(self, user_id: str, scenario: str, is_pro: bool = False) -> Tuple[HindsightResponse, str]:
        """Run simulation with rate limit enforcement."""
        can_run, msg = self.check_simulation_limit(user_id, is_pro)
        if not can_run:
            raise RuntimeError(msg)

        max_steps = 5 if is_pro else 3
        result = self.simulate(scenario, max_steps=max_steps)

        # Log usage
        today = str(date.today())
        SimulationLimiter.increment(user_id, today)

        return result, "success"