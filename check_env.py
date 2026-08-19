from pathlib import Path
import os

base = Path(__file__).resolve().parent
env_path = base / ".env"

print(f"Looking for .env at: {env_path}")
print(f"File exists: {env_path.exists()}")
print(f"Is file: {env_path.is_file()}")

if env_path.exists():
    print("\n--- Raw file contents (first 200 chars) ---")
    with open(env_path, 'rb') as f:
        raw = f.read(200)
        print(raw)
    print("\n--- Decoded ---")
    with open(env_path, 'r', encoding='utf-8') as f:
        print(f.read())
else:
    print("\nFiles in this folder:")
    for f in base.iterdir():
        if f.name.startswith('.env') or f.name.startswith('env'):
            print(f"  {f.name}")

print(f"\nGOOGLE_API_KEY from os.environ: {os.getenv('GOOGLE_API_KEY', 'NOT SET')}")