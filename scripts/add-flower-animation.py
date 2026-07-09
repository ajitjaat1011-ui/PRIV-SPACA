#!/usr/bin/env python3
"""
Replace the paper-plane SVG with a sakura flower SVG in splash + auth logo,
and add floating petal particles around the brand name.
"""
import re

with open('/home/z/my-project/PRIV-SPACA/index.html', 'r') as f:
    html = f.read()

# === Flower SVG templates (unique gradient IDs per instance) ===
# Splash flower (smaller, fills the 78px splash-logo)
splash_flower = '''<svg viewBox="0 0 100 100" class="flower-logo" width="52" height="52" aria-hidden="true"><defs><radialGradient id="petalGS" cx="50%" cy="35%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.98"/><stop offset="55%" stop-color="#ffb3d9"/><stop offset="100%" stop-color="#ff5e9c"/></radialGradient><radialGradient id="centerGS"><stop offset="0%" stop-color="#fff5b3"/><stop offset="100%" stop-color="#ffc233"/></radialGradient></defs><g class="flower-petals"><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGS)" transform="rotate(0 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGS)" transform="rotate(72 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGS)" transform="rotate(144 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGS)" transform="rotate(216 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGS)" transform="rotate(288 50 50)"/></g><circle class="flower-center" cx="50" cy="50" r="7" fill="url(#centerGS)"/><circle class="flower-center" cx="50" cy="50" r="3" fill="#ff8c00" opacity="0.55"/></svg>'''

# Auth flower (larger, fills the 96px logo-badge)
auth_flower = '''<svg viewBox="0 0 100 100" width="60" height="60" aria-hidden="true"><defs><radialGradient id="petalGA" cx="50%" cy="35%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.98"/><stop offset="55%" stop-color="#ffb3d9"/><stop offset="100%" stop-color="#ff5e9c"/></radialGradient><radialGradient id="centerGA"><stop offset="0%" stop-color="#fff5b3"/><stop offset="100%" stop-color="#ffc233"/></radialGradient></defs><g class="flower-petals"><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGA)" transform="rotate(0 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGA)" transform="rotate(72 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGA)" transform="rotate(144 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGA)" transform="rotate(216 50 50)"/><ellipse class="petal" cx="50" cy="22" rx="11" ry="18" fill="url(#petalGA)" transform="rotate(288 50 50)"/></g><circle class="flower-center" cx="50" cy="50" r="7" fill="url(#centerGA)"/><circle class="flower-center" cx="50" cy="50" r="3" fill="#ff8c00" opacity="0.55"/></svg>'''

# Petal particles container (6 floating petals)
petal_particles = '<div class="petal-particles"><div class="petal-particle"></div><div class="petal-particle"></div><div class="petal-particle"></div><div class="petal-particle"></div><div class="petal-particle"></div><div class="petal-particle"></div></div>'

# === 1. Replace splash paper plane with flower ===
old_splash_svg = '<svg viewBox="0 0 64 64" width="44" height="44" class="plane-anim"><path fill="#fff" d="M14 32 50 14 42 50 32 36 14 32z"/></svg>'
assert old_splash_svg in html, "splash SVG not found!"
html = html.replace(old_splash_svg, splash_flower)
print("✓ Replaced splash paper plane with flower")

# === 2. Replace auth logo paper plane with flower ===
old_auth_svg = '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><path fill="#fff" d="M14 32 50 14 42 50 32 36 14 32z"/></svg>'
assert old_auth_svg in html, "auth SVG not found!"
html = html.replace(old_auth_svg, auth_flower)
print("✓ Replaced auth logo paper plane with flower")

# === 3. Add petal particles around the auth brand name ===
# The auth brand name: <h1 class="brand-name text-anim">PRIV SPACA</h1>
# Wrap it in a relative container with petal particles
old_brand = '<h1 class="brand-name text-anim">PRIV SPACA</h1>'
assert old_brand in html, "auth brand name not found!"
new_brand = '<div style="position:relative">' + petal_particles + '<h1 class="brand-name text-anim" style="position:relative;z-index:1">PRIV SPACA</h1></div>'
html = html.replace(old_brand, new_brand)
print("✓ Added petal particles around auth brand name")

# === 4. Add petal particles around the splash name ===
old_splash_name = '<div class="splash-name">PRIV SPACA</div>'
assert old_splash_name in html, "splash name not found!"
new_splash_name = '<div style="position:relative">' + petal_particles + '<div class="splash-name" style="position:relative;z-index:1">PRIV SPACA</div></div>'
html = html.replace(old_splash_name, new_splash_name)
print("✓ Added petal particles around splash name")

with open('/home/z/my-project/PRIV-SPACA/index.html', 'w') as f:
    f.write(html)

print("\n✅ All flower animation changes applied!")
