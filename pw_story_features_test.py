#!/usr/bin/env python3
"""Playwright UI test for new Story features (analytics footer + reply bar),
driven purely through real DOM interactions against the dev harness on :8787."""
import random, string, sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8787"
errors = []
def log(name, ok, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + name + (f" -- {detail}" if detail else ""))
    if not ok: errors.append(name)

def rnd():
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"sf_{s}", f"sf_{s}@ex.com"

def signup(page):
    username, email = rnd()
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(600)
    page.locator('[data-auth-tab="signup"]').first.click()
    page.wait_for_timeout(300)
    form = page.locator('#signupForm')
    form.locator('input[name="displayName"]').fill(username)
    form.locator('input[name="username"]').fill(username)
    form.locator('input[name="email"]').fill(email)
    form.locator('input[name="password"]').fill("TestPass123!")
    pins = form.locator('[data-pin-cell]')
    for i, d in enumerate("7392"):
        pins.nth(i).fill(d)
    terms = form.locator('input[type="checkbox"]')
    if terms.count() > 0:
        try: terms.first.check()
        except Exception: pass
    form.locator('button[type="submit"]').click()
    page.wait_for_timeout(2500)
    return username

def publish_text_story(page, caption):
    # Open own-story editor via the rail "me" cell, add text, publish to all.
    page.locator('#storiesRail .story-cell.me').first.click()
    page.wait_for_timeout(600)
    page.locator('.story-tool-item >> text=Text').click()
    page.wait_for_timeout(400)
    page.locator('#storyTextOverlayInput').fill(caption)
    page.locator('#storyTextEditorScreen .story-text-done').click()
    page.wait_for_timeout(400)
    page.locator('#storyPubBtnAll').click()
    page.wait_for_timeout(2600)

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---- User A: create a story ----
    ctxA = browser.new_context(viewport={"width": 390, "height": 844})
    pageA = ctxA.new_page()
    unA = signup(pageA)
    log("A signed up", pageA.locator('#appShell').is_visible())
    publish_text_story(pageA, "seen-by test story")
    log("A story published (rail shows own active story)",
        pageA.locator('#storiesRail .story-cell.me .story-ring.is-me').count() >= 1)

    # A opens own story -> "Seen by" pill visible, reply bar hidden.
    pageA.locator('#storiesRail .story-cell.me').first.click()
    pageA.wait_for_timeout(1200)
    log("owner sees 'Seen by' pill", pageA.locator('#storySeenBy').is_visible())
    log("owner does NOT see reply bar", not pageA.locator('#storyReplyBar').is_visible())
    seen0 = pageA.locator('#storySeenByCount').inner_text().strip()
    log("seen-by count starts at 0", seen0 == "0", seen0)
    pageA.locator('#storyClose').click()
    pageA.wait_for_timeout(400)

    # ---- User B: view A's story + reply ----
    ctxB = browser.new_context(viewport={"width": 390, "height": 844})
    pageB = ctxB.new_page()
    console_errB = []
    pageB.on("console", lambda m: console_errB.append(m.text) if m.type == "error" else None)
    pageB.on("pageerror", lambda e: console_errB.append("pageerror: " + str(e)))
    unB = signup(pageB)
    pageB.wait_for_timeout(2000)  # allow members/posts to load

    # Find A's story cell in B's rail by label text and click it.
    authorCell = pageB.locator('#storiesRail .story-cell', has_text=unA).first
    log("B sees author's story in rail", authorCell.count() >= 1)
    authorCell.click()
    pageB.wait_for_timeout(1400)
    replyVisible = pageB.locator('#storyReplyBar').is_visible()
    log("viewer sees reply bar", replyVisible)
    log("viewer does NOT see 'Seen by' pill", not pageB.locator('#storySeenBy').is_visible())
    log("5 quick-react emojis present",
        pageB.locator('#storyQuickReacts .story-react-emoji').count() == 5,
        str(pageB.locator('#storyQuickReacts .story-react-emoji').count()))

    if replyVisible:
        pageB.locator('#storyQuickReacts .story-react-emoji[data-emoji="❤️"]').click()
        pageB.wait_for_timeout(1200)
        pageB.locator('#storyReplyInput').fill("nice story!")
        pageB.locator('#storyReplySend').click()
        pageB.wait_for_timeout(1300)
    log("no JS errors during B reply flow",
        len([e for e in console_errB if 'pageerror' in e or 'Uncaught' in e]) == 0,
        str(console_errB[:3]))
    if pageB.locator('#storyClose').is_visible():
        pageB.locator('#storyClose').click()
    pageB.wait_for_timeout(400)

    # ---- A re-opens story -> seen-by >= 1, viewers sheet lists B ----
    pageA.reload(wait_until="networkidle")
    pageA.wait_for_timeout(2000)
    pageA.locator('#storiesRail .story-cell.me').first.click()
    pageA.wait_for_timeout(1400)
    newCount = pageA.locator('#storySeenByCount').inner_text().strip()
    log("owner seen-by count increased to >=1", newCount not in ("0", "?", ""), newCount)
    pageA.locator('#storySeenBy').click()
    pageA.wait_for_timeout(1300)
    log("viewers sheet opens", pageA.locator('#storyViewersSheet').is_visible())
    rows = pageA.locator('#storyViewersList .story-viewer-row').count()
    log("viewers sheet lists >=1 viewer", rows >= 1, str(rows))
    listText = pageA.locator('#storyViewersList').inner_text()
    log("viewer B appears in list", unB in listText, listText[:80])

    browser.close()

print("\n=== SUMMARY ===")
if errors:
    print("FAILURES:", errors); sys.exit(1)
print("All story-feature UI checks passed.")
