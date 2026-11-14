"""Read-only audit of frontend/style.css. Changes nothing."""
import re
from pathlib import Path
from collections import Counter

css_path = Path("frontend/style.css")
if not css_path.exists():
    css_path = Path("static/style.css")
if not css_path.exists():
    print("style.css not found — check the path")
    raise SystemExit(1)

text = css_path.read_text(encoding="utf-8", errors="ignore")
lines = text.splitlines()

# 1. Basic size
print(f"Total lines: {len(lines)}")
print(f"Total bytes: {len(text):,}")

# 2. Selector extraction (rough — handles most cases)
selectors = re.findall(r"([^{}]+)\{", text)
clean = []
for s in selectors:
    s = s.strip()
    if not s or s.startswith("@") or s.startswith("/*"):
        continue
    for part in s.split(","):
        p = part.strip()
        if p:
            clean.append(p)

counts = Counter(clean)
duplicates = {sel: n for sel, n in counts.items() if n > 1}
print(f"\nUnique selectors: {len(counts)}")
print(f"Selectors defined more than once: {len(duplicates)}")
print(f"Total redundant definitions: {sum(n - 1 for n in duplicates.values())}")

# 3. Top 10 worst duplicates
print("\nTop 10 most-redefined selectors:")
for sel, n in sorted(duplicates.items(), key=lambda x: -x[1])[:10]:
    print(f"  {n:3d}x  {sel}")

# 4. !important count
important = text.count("!important")
print(f"\n!important declarations: {important}")

# 5. Media query count
print(f"@media blocks: {text.count('@media')}")
print(f"@keyframes blocks: {text.count('@keyframes')}")

# 6. Blank lines + comments
blank = sum(1 for l in lines if not l.strip())
comments = len(re.findall(r"/\*.*?\*/", text, re.DOTALL))
print(f"\nBlank lines: {blank} ({blank*100//len(lines)}%)")
print(f"Comment blocks: {comments}")

# 7. Classes actually used in the HTML/JS
used_classes = set()
for pattern in ["frontend/*.html", "frontend/*.js", "static/*.html", "static/*.js"]:
    for f in Path(".").glob(pattern):
        src = f.read_text(encoding="utf-8", errors="ignore")
        for m in re.findall(r'class="([^"]+)"', src):
            for c in m.split():
                used_classes.add(c)
        for m in re.findall(r'classList\.(?:add|remove|toggle)\([\'"]([^\'"]+)', src):
            used_classes.add(m)
        for m in re.findall(r'classList\.(?:add|remove|toggle)\(\s*[\'"]([^\'"]+)', src):
            used_classes.add(m)

# 8. Which selectors reference classes that appear unused
css_classes = set()
for sel in counts:
    for m in re.findall(r"\.([a-zA-Z_][\w-]*)", sel):
        css_classes.add(m)

possibly_dead = css_classes - used_classes
print(f"\nCSS classes found: {len(css_classes)}")
print(f"Classes referenced in HTML/JS: {len(used_classes & css_classes)}")
print(f"CSS classes with NO reference found: {len(possibly_dead)} "
      f"({len(possibly_dead)*100//max(1,len(css_classes))}%)")
print("(Some of these are legit — dynamically added, or referenced only in modals.)")
print(f"\nSample of possibly-unused: {sorted(list(possibly_dead))[:15]}")