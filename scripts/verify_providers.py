"""Phase 0 — Verify which AI providers are live with current credentials.

Run:  python scripts/verify_providers.py
Output: table of provider status + cost per test call
"""
import os
import sys
import time
from pathlib import Path

# Add parent dir to sys.path so we can import settings
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from settings import Config


def banner(name: str):
    print(f"\n{'=' * 60}\n{name}\n{'=' * 60}")


def check_configured(label: str, key: str, value: str):
    status = "✅ SET" if value else "❌ MISSING"
    print(f"  {label:<20} {status}")
    return bool(value)


def test_qwen():
    banner("QWEN (via Groq)")
    if not check_configured("GROQ_API_KEY", "GROQ_API_KEY", Config.GROQ_API_KEY):
        return ("SKIP", "No API key")

    try:
        from groq import Groq
        client = Groq(api_key=Config.GROQ_API_KEY)

        # List available models
        models = client.models.list()
        qwen_models = [m.id for m in models.data if "qwen" in m.id.lower()]
        print(f"  Available Qwen models on Groq: {qwen_models}")

        if not qwen_models:
            return ("FAIL", "No Qwen model available on this account")

        # Try the primary model first, fall back to whatever's listed
        target = "qwen/qwen3.8-27b" if "qwen/qwen3.8-27b" in qwen_models else qwen_models[0]
        print(f"  Testing: {target}")

        start = time.time()
        resp = client.chat.completions.create(
            model=target,
            messages=[{"role": "user", "content": "Reply with just: OK"}],
            max_tokens=10,
            temperature=0,
        )
        elapsed = time.time() - start
        content = resp.choices[0].message.content.strip()
        print(f"  Response: {content[:60]}")
        print(f"  Latency: {elapsed:.2f}s")
        print(f"  Tokens: in={resp.usage.prompt_tokens}, out={resp.usage.completion_tokens}")

        return ("PASS", f"{target} works")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_deepseek():
    banner("DEEPSEEK")
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not check_configured("DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY", api_key):
        return ("SKIP", "No API key — get one at platform.deepseek.com")

    try:
        import requests
        start = time.time()
        resp = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",  # or "deepseek-flash" if available
                "messages": [{"role": "user", "content": "Reply with just: OK"}],
                "max_tokens": 10,
                "temperature": 0,
            },
            timeout=30,
        )
        elapsed = time.time() - start

        if resp.status_code != 200:
            return ("FAIL", f"HTTP {resp.status_code}: {resp.text[:100]}")

        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()
        usage = data.get("usage", {})
        print(f"  Response: {content[:60]}")
        print(f"  Latency: {elapsed:.2f}s")
        print(f"  Tokens: in={usage.get('prompt_tokens')}, out={usage.get('completion_tokens')}")

        return ("PASS", "deepseek-chat works")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_openai():
    banner("OPENAI")
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not check_configured("OPENAI_API_KEY", "OPENAI_API_KEY", api_key):
        return ("SKIP", "No API key — get one at platform.openai.com")

    try:
        import requests
        # Try current models endpoint
        models_resp = requests.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=15,
        )
        if models_resp.status_code != 200:
            return ("FAIL", f"HTTP {models_resp.status_code}")

        model_ids = [m["id"] for m in models_resp.json().get("data", [])]
        gpt_models = [m for m in model_ids if "gpt" in m.lower()]
        print(f"  Available GPT models: {gpt_models[:10]}")

        return ("PASS", "API key valid")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_gemini():
    banner("GEMINI")
    if not check_configured("GOOGLE_API_KEY", "GOOGLE_API_KEY", Config.GOOGLE_API_KEY):
        return ("SKIP", "No API key")

    try:
        from google import genai
        client = genai.Client(api_key=Config.GOOGLE_API_KEY)

        # List available models
        models = list(client.models.list())
        gemini_models = [m.name for m in models if "gemini" in m.name.lower()]
        print(f"  Available Gemini models ({len(gemini_models)} total):")
        for m in gemini_models[:5]:
            print(f"    - {m}")

        # Test with current stable model
        for candidate in ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"]:
            try:
                start = time.time()
                resp = client.models.generate_content(
                    model=candidate,
                    contents="Reply with just: OK",
                )
                elapsed = time.time() - start
                print(f"  ✅ {candidate}: {resp.text.strip()[:40]} ({elapsed:.2f}s)")
                return ("PASS", f"{candidate} works")
            except Exception:
                continue

        return ("FAIL", "No tested Gemini model succeeded")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_elevenlabs():
    banner("ELEVENLABS")
    if not check_configured("ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY", Config.ELEVENLABS_API_KEY):
        return ("SKIP", "No API key")

    try:
        import requests
        # Check account info — doesn't burn credits
        resp = requests.get(
            "https://api.elevenlabs.io/v1/user",
            headers={"xi-api-key": Config.ELEVENLABS_API_KEY},
            timeout=10,
        )
        if resp.status_code != 200:
            return ("FAIL", f"HTTP {resp.status_code}: {resp.text[:100]}")

        data = resp.json()
        sub = data.get("subscription", {})
        print(f"  Tier: {sub.get('tier')}")
        print(f"  Character limit: {sub.get('character_limit', 'unknown')}")
        print(f"  Characters used: {sub.get('character_count', 'unknown')}")

        return ("PASS", "API key valid")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_tavily():
    banner("TAVILY (search)")
    if not check_configured("TAVILY_API_KEY", "TAVILY_API_KEY", Config.TAVILY_API_KEY):
        return ("SKIP", "No API key")

    try:
        from tavily import TavilyClient
        client = TavilyClient(api_key=Config.TAVILY_API_KEY)
        result = client.search("Veyronis", max_results=1)
        results = result.get("results", [])
        print(f"  Results: {len(results)}")
        if results:
            print(f"  Sample: {results[0].get('title', '')[:60]}")
        return ("PASS", "Search works")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def test_cloudinary():
    banner("CLOUDINARY (storage)")
    if not Config.cloudinary_ready():
        return ("SKIP", "Not configured")

    try:
        import cloudinary
        import cloudinary.api
        cloudinary.config(
            cloud_name=Config.CLOUDINARY_CLOUD_NAME,
            api_key=Config.CLOUDINARY_API_KEY,
            api_secret=Config.CLOUDINARY_API_SECRET,
        )
        result = cloudinary.api.ping()
        print(f"  Ping: {result}")
        return ("PASS", "Connected")
    except Exception as e:
        print(f"  Error: {type(e).__name__}: {e}")
        return ("FAIL", str(e)[:100])


def main():
    print("=" * 60)
    print("VEYRONIS — PROVIDER VERIFICATION")
    print("=" * 60)
    print("Purpose: determine which providers are live with current credentials.")
    print("Cost: each text test burns ~$0.001. Voice/image not tested (expensive).")
    print()

    results = {}
    for name, fn in [
        ("Qwen (Groq)", test_qwen),
        ("DeepSeek", test_deepseek),
        ("OpenAI", test_openai),
        ("Gemini", test_gemini),
        ("ElevenLabs", test_elevenlabs),
        ("Tavily", test_tavily),
        ("Cloudinary", test_cloudinary),
    ]:
        try:
            status, detail = fn()
        except Exception as e:
            status, detail = "CRASH", f"{type(e).__name__}: {e}"
            print(f"  Crashed: {detail}")
        results[name] = (status, detail)

    # Summary table
    banner("SUMMARY")
    print(f"{'Provider':<20} {'Status':<8} {'Notes'}")
    print(f"{'-' * 20} {'-' * 8} {'-' * 40}")
    for name, (status, detail) in results.items():
        print(f"{name:<20} {status:<8} {detail}")

    # Exit code based on result
    fails = sum(1 for s, _ in results.values() if s == "FAIL")
    if fails:
        print(f"\n⚠️  {fails} provider(s) failed")
        sys.exit(1)
    else:
        print(f"\n✅ No failures")
        sys.exit(0)


if __name__ == "__main__":
    main()