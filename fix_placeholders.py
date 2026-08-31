# fix_placeholders.py
import re

with open("api.py", "r", encoding="utf-8") as f:
    content = f.read()

# Replace ? inside SQL strings (cursor.execute, conn.execute, etc.)
# This regex replaces ? that appear inside parenthesis after execute
# We do a more thorough approach:
new_content = re.sub(r'execute\(([^)]*?)\?', r'execute(\1%s', content)
# Also fix standalone ? in SQL if any
new_content = re.sub(r'\(\?\)', '(%s)', new_content)
new_content = re.sub(r'\(\?', '(%s', new_content)
new_content = re.sub(r',\?', ',%s', new_content)
new_content = re.sub(r'\?\)', '%s)', new_content)

with open("api.py", "w", encoding="utf-8") as f:
    f.write(new_content)

print("✅ Updated api.py placeholders from ? to %s")