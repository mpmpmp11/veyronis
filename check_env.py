"""VEYRONIS Environment Diagnostic"""
import os
from pathlib import Path

base = Path(__file__).resolve().parent
env_path = base / ".env"

print("=" * 50)
print("VEYRONIS ENVIRONMENT CHECK")
print("=" * 50)
print(f"\nLooking for .env at: {env_path}")
print(f"File exists: {env_path.exists()}")

if env_path.exists():
    raw = env_path.read_bytes()
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    print(f"Has UTF-8 BOM: {has_bom}")
    if has_bom:
        print("  ^^^ FIX THIS: Open .env in Notepad, Save As -> UTF-8 (no BOM)")

    print("\n--- .env contents (masked) ---")
    for line in env_path.read_text(encoding='utf-8', errors='ignore').strip().split('\n'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            key, val = line.split('=', 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val:
                print(f"  {key}: {'SET (' + val[:8] + '...)' if len(val) > 8 else 'SET (' + val + ')'}")
            else:
                print(f"  {key}: EMPTY")
        else:
            print(f"  {line}: (no = sign)")

print("\n--- Loaded via python-dotenv ---")
from dotenv import load_dotenv
load_dotenv(dotenv_path=env_path)

for key in ["GROQ_API_KEY", "TAVILY_API_KEY", "GOOGLE_API_KEY", "JWT_SECRET_KEY"]:
    val = os.getenv(key, "")
    status = "SET" if val else "NOT SET"
    print(f"  {key}: {status}")

print("\n" + "=" * 50)
print("If GOOGLE_API_KEY shows NOT SET but it's in .env,")
print("your .env file likely has a UTF-8 BOM. Fix it with")
print("Notepad: Save As -> UTF-8 (the one WITHOUT 'BOM' label)")
print("=" * 50)