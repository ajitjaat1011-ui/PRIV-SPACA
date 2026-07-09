#!/usr/bin/env python3
"""
Build the real icon files for PRIV-SPACA from the same brand SVGs.

Generates:
  - favicon.ico           (16x16 + 32x32 + 48x48 multi-size ICO)
  - favicon-16x16.png      (16x16 PNG)
  - favicon-32x32.png      (32x32 PNG)
  - apple-touch-icon.png   (180x180 PNG, used by iOS)
  - icon-192.png           (192x192, PWA standard)
  - icon-512.png           (512x512, PWA standard, used for splash)
  - icon-maskable-512.png  (512x512 with safe zone for adaptive icons)

Brand: the existing favicon's blue-to-darker-blue gradient
  (00c6ff → 0072ff) with a white "PS" arrow shape.
"""
import os
import struct
from PIL import Image, ImageDraw

OUT_DIR = "/home/user/PRIV-SPACA"
os.makedirs(OUT_DIR, exist_ok=True)

# Brand colors
GRAD_START = (0x00, 0xc6, 0xff)  # #00c6ff
GRAD_END = (0x00, 0x72, 0xff)    # #0072ff
WHITE = (0xff, 0xff, 0xff, 0xff)

def make_gradient_bg(size, radius_ratio=0.25):
    """Create a rounded-square gradient background."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * radius_ratio)

    # Diagonal gradient (top-left to bottom-right)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            r = int(GRAD_START[0] * (1 - t) + GRAD_END[0] * t)
            g = int(GRAD_START[1] * (1 - t) + GRAD_END[1] * t)
            b = int(GRAD_START[2] * (1 - t) + GRAD_END[2] * t)
            draw.point((x, y), fill=(r, g, b, 0xff))

    # Apply rounded-corner mask
    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out

def draw_ps_arrow(img, size, scale=0.7, color=WHITE):
    """Draw the PS arrow on top of the gradient bg. Path data:
    M14 32 50 14 42 50 32 36 14 32z
    This is for viewBox 0 0 64 64, so we scale to img size."""
    draw = ImageDraw.Draw(img)
    # viewBox 0 0 64 64, so coords are 0-64
    # Scale to image size
    s = (size / 64.0) * scale
    # Center the arrow inside the image
    offset_x = (size - 64 * s) / 2
    offset_y = (size - 64 * s) / 2
    # Original path points (from the SVG)
    points = [
        (14, 32), (50, 14), (42, 50), (32, 36), (14, 32)
    ]
    # Build a polygon (closing the loop with a line back to start)
    scaled = [(offset_x + p[0] * s, offset_y + p[1] * s) for p in points]
    draw.polygon(scaled, fill=color)

def make_icon(size, maskable=False, radius_ratio=0.25):
    """Make an icon of the given size. If maskable, the arrow is shrunk
    so it stays inside the safe zone (66% center)."""
    bg = make_gradient_bg(size, radius_ratio=radius_ratio)
    arrow_scale = 0.7 if not maskable else 0.5  # smaller arrow for maskable
    draw_ps_arrow(bg, size, scale=arrow_scale)
    return bg

# 1. favicon-16x16.png
img16 = make_icon(16)
img16.save(os.path.join(OUT_DIR, "favicon-16x16.png"), "PNG")
print(f"  favicon-16x16.png  ({img16.size})")

# 2. favicon-32x32.png
img32 = make_icon(32)
img32.save(os.path.join(OUT_DIR, "favicon-32x32.png"), "PNG")
print(f"  favicon-32x32.png  ({img32.size})")

# 3. favicon.ico (multi-size: 16, 32, 48)
img48 = make_icon(48)
img48.save(os.path.join(OUT_DIR, "favicon.ico"), "ICO", sizes=[(16, 16), (32, 32), (48, 48)])
print(f"  favicon.ico        (16+32+48 multi-size)")

# 4. apple-touch-icon.png (180x180, with rounded corners like iOS)
img180 = make_icon(180, radius_ratio=0.22)  # iOS-style corner radius
img180.save(os.path.join(OUT_DIR, "apple-touch-icon.png"), "PNG")
print(f"  apple-touch-icon.png  ({img180.size})")

# 5. icon-192.png (PWA standard)
img192 = make_icon(192)
img192.save(os.path.join(OUT_DIR, "icon-192.png"), "PNG")
print(f"  icon-192.png       ({img192.size})")

# 6. icon-512.png (PWA splash)
img512 = make_icon(512)
img512.save(os.path.join(OUT_DIR, "icon-512.png"), "PNG")
print(f"  icon-512.png       ({img512.size})")

# 7. icon-maskable-512.png (for adaptive icons — arrow inside 66% safe zone)
img512m = make_icon(512, maskable=True, radius_ratio=0.0)  # full bleed, no radius
img512m.save(os.path.join(OUT_DIR, "icon-maskable-512.png"), "PNG")
print(f"  icon-maskable-512.png  ({img512m.size}, full-bleed)")

print("\nDone. All icons generated.")
