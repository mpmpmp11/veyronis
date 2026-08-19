"""VEYRONIS System Check."""
import sys, os

print("=" * 45)
print("VEYRONIS SYSTEM CHECK")
print("=" * 45)

checks = []
checks.append(f"Python: {sys.version.split()[0]}")

modules = [
    ("dotenv", "python-dotenv"),
    ("groq", "groq"),
    ("tavily", "tavily"),
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("pydantic", "pydantic"),
]

for mod_name, pip_name in modules:
    try:
        __import__(mod_name)
        checks.append(f"{pip_name}: OK")
    except ImportError:
        checks.append(f"{pip_name}: MISSING")

files = ["settings.py", ".env", "orchestrator.py", "api.py", 
         "agents/groq_agent.py", "agents/judge_agent.py",
         "tools/calculator.py", "tools/search.py",
         "memory/memory.py", "frontend/index.html"]

for f in files:
    checks.append(f"{f}: {'FOUND' if os.path.exists(f) else 'MISSING'}")

try:
    from settings import Config
    checks.append(f"GROQ_KEY: {'SET' if Config.GROQ_API_KEY else 'EMPTY'}")
    checks.append(f"TAVILY_KEY: {'SET' if Config.TAVILY_API_KEY else 'EMPTY'}")
except Exception as e:
    checks.append(f"Config Error: {e}")

print("\n".join(checks))
print("=" * 45)

if any("MISSING" in c or "EMPTY" in c or "Error" in c for c in checks):
    print("FIX RED ITEMS ABOVE")
else:
    print("ALL GREEN. Ready to run: python api.py")