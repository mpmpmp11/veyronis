"""Auto-patch api.py to fix bcrypt 72-byte password limit."""

with open("api.py", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Add import hashlib if missing
if "import hashlib" not in content:
    content = content.replace(
        "from passlib.context import CryptContext",
        "from passlib.context import CryptContext\nimport hashlib"
    )
    print("[+] Added: import hashlib")
else:
    print("[OK] import hashlib already present")

# 2. Replace verify_password
old_verify = """def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)"""

new_verify = """def verify_password(plain: str, hashed: str) -> bool:
    pwd_hash = hashlib.sha256(plain.encode()).hexdigest()
    return pwd_context.verify(pwd_hash, hashed)"""

if old_verify in content:
    content = content.replace(old_verify, new_verify)
    print("[+] Patched: verify_password")
else:
    print("[!] verify_password pattern not found")

# 3. Replace get_password_hash (with or without the if block)
old_hash_v1 = """def get_password_hash(password: str) -> str:
    if len(password) > 72:
        password = password[:72]
    return pwd_context.hash(password)"""

old_hash_v2 = """def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)"""

new_hash = """def get_password_hash(password: str) -> str:
    pwd_hash = hashlib.sha256(password.encode()).hexdigest()
    return pwd_context.hash(pwd_hash)"""

if old_hash_v1 in content:
    content = content.replace(old_hash_v1, new_hash)
    print("[+] Patched: get_password_hash (with truncation)")
elif old_hash_v2 in content:
    content = content.replace(old_hash_v2, new_hash)
    print("[+] Patched: get_password_hash (simple)")
else:
    print("[!] get_password_hash pattern not found")

with open("api.py", "w", encoding="utf-8") as f:
    f.write(content)

print("\n[OK] api.py patched. Restart with: python api.py")