"""Diagnostic + Force Fix for api.py bcrypt issue."""
import os
import sys

print("=" * 50)
print("DIAGNOSTIC: Checking api.py hash functions")
print("=" * 50)

with open("api.py", "r", encoding="utf-8") as f:
    lines = f.readlines()

# Show lines 20-50 (where hash functions should be)
print("\n--- Lines 20-50 of api.py ---")
for i, line in enumerate(lines[19:50], start=20):
    marker = " <<<" if "verify_password" in line or "get_password_hash" in line or "pwd_context" in line else ""
    print(f"{i:3d}: {line.rstrip()}{marker}")

# Check what's actually there
has_old_verify = any("pwd_context.verify(plain, hashed)" in line for line in lines)
has_old_hash = any("password[:72]" in line for line in lines)
has_old_hash2 = any("pwd_context.hash(password)" in line for line in lines)
has_new_verify = any("hashlib.sha256(plain.encode())" in line for line in lines)
has_new_hash = any("hashlib.sha256(password.encode())" in line for line in lines)
has_hashlib_import = any("import hashlib" in line for line in lines)

print("\n--- DETECTION ---")
print(f"  import hashlib present: {has_hashlib_import}")
print(f"  OLD verify_password: {has_old_verify}")
print(f"  OLD get_password_hash (with [:72]): {has_old_hash}")
print(f"  OLD get_password_hash (simple): {has_old_hash2}")
print(f"  NEW verify_password: {has_new_verify}")
print(f"  NEW get_password_hash: {has_new_hash}")

# FORCE FIX: Replace line by line
print("\n--- APPLYING FIX ---")

fixed_lines = []
i = 0
while i < len(lines):
    line = lines[i]

    # Fix verify_password function
    if "def verify_password(plain: str, hashed: str) -> bool:" in line:
        fixed_lines.append(line)  # keep def line
        i += 1
        # Skip old body (1-2 lines)
        while i < len(lines) and (lines[i].strip().startswith("return") or lines[i].strip() == ""):
            i += 1
        fixed_lines.append("    pwd_hash = hashlib.sha256(plain.encode()).hexdigest()\n")
        fixed_lines.append("    return pwd_context.verify(pwd_hash, hashed)\n")
        print("  [FIXED] verify_password")
        continue

    # Fix get_password_hash function
    if "def get_password_hash(password: str) -> str:" in line:
        fixed_lines.append(line)  # keep def line
        i += 1
        # Skip old body (1-4 lines)
        skipped = 0
        while i < len(lines) and skipped < 5:
            stripped = lines[i].strip()
            if stripped == "" or stripped.startswith("return") or stripped.startswith("if len") or stripped.startswith("password ="):
                i += 1
                skipped += 1
            else:
                break
        fixed_lines.append("    pwd_hash = hashlib.sha256(password.encode()).hexdigest()\n")
        fixed_lines.append("    return pwd_context.hash(pwd_hash)\n")
        print("  [FIXED] get_password_hash")
        continue

    fixed_lines.append(line)
    i += 1

# Add import hashlib if missing
content = "".join(fixed_lines)
if "import hashlib" not in content:
    content = content.replace(
        "from passlib.context import CryptContext",
        "from passlib.context import CryptContext\nimport hashlib"
    )
    print("  [ADDED] import hashlib")

with open("api.py", "w", encoding="utf-8") as f:
    f.write(content)

print("\n--- CLEARING CACHE ---")
import shutil
for root, dirs, files in os.walk("."):
    for d in dirs:
        if d == "__pycache__":
            path = os.path.join(root, d)
            shutil.rmtree(path)
            print(f"  [DELETED] {path}")
    for f in files:
        if f.endswith(".pyc"):
            path = os.path.join(root, f)
            os.remove(path)
            print(f"  [DELETED] {path}")

print("\n" + "=" * 50)
print("DONE. Now run: python api.py")
print("=" * 50)