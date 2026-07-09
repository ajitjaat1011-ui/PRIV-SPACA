#!/usr/bin/env python3
"""Replace duplicated sheet-open motionAnimate calls with slideSheetUp()."""
import re

with open('/home/z/my-project/PRIV-SPACA/app.js', 'r') as f:
    src = f.read()

# Exact pattern from the file:
#   if (card) motionAnimate(card,\n
#       { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },\n
#       { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }\n
#     );\n
pattern = re.compile(
    r"if \(card\) motionAnimate\(card,\n"
    r"    \{ transform: \['translateY\(100%\)', 'translateY\(0\)'\], opacity: \[0\.6, 1\] \},\n"
    r"    \{ duration: 0\.36, easing: \[0\.2, 0\.85, 0\.15, 1\] \}\n"
    r"  \);"
)
count = len(pattern.findall(src))
src = pattern.sub('if (card) slideSheetUp(card);', src)

with open('/home/z/my-project/PRIV-SPACA/app.js', 'w') as f:
    f.write(src)

print(f"Replaced {count} sites")
