"""Quick diagnostic for Gemini setup."""
from settings import Config

print(f"GOOGLE_API_KEY loaded: {'YES (' + Config.GOOGLE_API_KEY[:10] + '...)' if Config.GOOGLE_API_KEY else 'NO — key is empty'}")
print(f"gemini_ready(): {Config.gemini_ready()}")

if Config.gemini_ready():
    try:
        from agents.gemini_agent import GeminiAgent
        agent = GeminiAgent()
        print("GeminiAgent initialized: OK")

        # List available models
        print("\n--- Trying to list available models ---")
        for api_ver in ["v1beta", "v1"]:
            try:
                from google import genai
                client = genai.Client(api_key=Config.GOOGLE_API_KEY, http_options={"api_version": api_ver})
                models = client.models.list()
                gemini_models = [m.name for m in models if "gemini" in m.name.lower()]
                print(f"  API {api_ver}: Found {len(gemini_models)} Gemini models")
                for m in gemini_models[:5]:
                    print(f"    - {m}")
            except Exception as e:
                print(f"  API {api_ver}: Failed to list — {e}")

        # Quick text test
        print("\n--- Quick text test ---")
        r = agent.generate_response("Say 'Gemini is online' and nothing else.")
        print(f"Test response: {r}")
        if r.startswith("[ERROR]"):
            print("\nTIP: Your key works but the model names may need updating.")
            print("Check the 'Available models' list above for valid names.")
    except Exception as e:
        print(f"GeminiAgent FAILED: {e}")
        import traceback
        traceback.print_exc()
else:
    print("Skipping agent test — key not loaded.")