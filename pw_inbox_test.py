import random, string, sys
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8787"
errs = []
def log(n, ok, d=""):
    print(("[PASS] " if ok else "[FAIL] ") + n + (f" -- {d}" if d else ""))
    if not ok: errs.append(n)
def rnd():
    s = ''.join(random.choices(string.ascii_lowercase+string.digits, k=6))
    return f"ib_{s}", f"ib_{s}@ex.com"
def signup(page):
    u,e = rnd()
    page.goto(BASE, wait_until="networkidle", timeout=30000); page.wait_for_timeout(500)
    page.locator('[data-auth-tab="signup"]').first.click(); page.wait_for_timeout(300)
    f = page.locator('#signupForm')
    f.locator('input[name="displayName"]').fill(u)
    f.locator('input[name="username"]').fill(u)
    f.locator('input[name="email"]').fill(e)
    f.locator('input[name="password"]').fill("TestPass123!")
    for i,d in enumerate("7392"): f.locator('[data-pin-cell]').nth(i).fill(d)
    t = f.locator('input[type="checkbox"]')
    if t.count():
        try: t.first.check()
        except: pass
    f.locator('button[type="submit"]').click(); page.wait_for_timeout(2500)
    return u

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width":390,"height":844})
    cerr = []
    pg.on("console", lambda m: cerr.append(m.text) if m.type=="error" else None)
    pg.on("pageerror", lambda e: cerr.append("pageerror: "+str(e)))
    u1 = signup(pg)
    log("signed up + app shell", pg.locator('#appShell').is_visible())

    # Second user first (fresh context) so u1 has a 'request' to see
    ctx2 = b.new_context(viewport={"width":390,"height":844})
    pg2 = ctx2.new_page(); u2 = signup(pg2)

    # u1: open Groups tab -> rooms pane shows on mobile
    pg.locator('.bn-btn[data-tab="groups"]').click(); pg.wait_for_timeout(900)
    log("groups pane visible", pg.locator('#groupsPaneSection').is_visible())
    log("Groups seg active", "active" in (pg.locator('#inboxSegment .inbox-seg-btn[data-seg=\"groups\"]').get_attribute("class") or ""))
    log("general-group shows", pg.locator('#roomsList .room-item[data-room="general-group"]').count() == 1)
    gbadge = pg.locator('#segGroupsBadge').inner_text()
    log("Groups badge >=1", gbadge not in ("0",""), gbadge)

    # Switch to Primary segment (within the visible rooms pane)
    pg.locator('#inboxSegment .inbox-seg-btn[data-seg="primary"]').click(); pg.wait_for_timeout(1200)
    log("Primary seg active", "active" in (pg.locator('#inboxSegment .inbox-seg-btn[data-seg=\"primary\"]').get_attribute("class") or ""))
    log("dms pane visible", pg.locator('#dmsPaneSection').is_visible())
    log("groups pane hidden", not pg.locator('#groupsPaneSection').is_visible())

    # u2 not connected -> should appear as a Request for u1
    banner_visible = pg.locator('#requestsBanner').is_visible()
    log("requests banner appears", banner_visible)
    if banner_visible:
        pg.locator('#requestsBanner').click(); pg.wait_for_timeout(800)
        log("requests sub-view opens", pg.locator('#requestsView').is_visible())
        cnt = pg.locator('#requestsList .member-item').count()
        log("requests list has other user", cnt >= 1, str(cnt))
        pg.locator('#requestsList .member-item').first.click(); pg.wait_for_timeout(1200)
        title = (pg.locator('#chatTitle').inner_text() or "").strip()
        log("opening request starts a DM", title != "#general-group" and title != "", title)

    log("no uncaught JS errors", len([e for e in cerr if 'pageerror' in e or 'Uncaught' in e]) == 0, str(cerr[:3]))
    b.close()

print("\n=== SUMMARY ===")
if errs: print("FAILURES:", errs); sys.exit(1)
print("All inbox redesign checks passed.")
