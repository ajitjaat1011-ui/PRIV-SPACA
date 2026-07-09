#!/usr/bin/env python3
"""Replace 'if (el) el.classList.add/remove('hidden')' with hide(el)/show(el)."""
import re

with open('/home/z/my-project/PRIV-SPACA/app.js', 'r') as f:
    src = f.read()

# Pattern: if (VAR) VAR.classList.add('hidden')  →  hide(VAR)
# VAR must be the same identifier in both places (backreference \1)
add_pattern = re.compile(r"if \((\w+)\) \1\.classList\.add\('hidden'\)")
add_count = len(add_pattern.findall(src))
src = add_pattern.sub(r'hide(\1)', src)

# Pattern: if (VAR) VAR.classList.remove('hidden')  →  show(VAR)
remove_pattern = re.compile(r"if \((\w+)\) \1\.classList\.remove\('hidden'\)")
remove_count = len(remove_pattern.findall(src))
src = remove_pattern.sub(r'show(\1)', src)

with open('/home/z/my-project/PRIV-SPACA/app.js', 'w') as f:
    f.write(src)

print(f"Replaced {add_count} hide() + {remove_count} show() = {add_count + remove_count} sites")
