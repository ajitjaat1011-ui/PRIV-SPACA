import random, string, sys
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8787"
errs = []
def log(n, ok, d=""):
    print(("[PASS] " if ok else "[FAIL] ") + n + (f" -- {d}" if d else ""))
    if not ok: errs.append(n)
def rnd():
    s = ''.join(random.choices(string.ascii_lowercase+string.digits, k=6))
    return f"nt_{s}", f"nt_{s}@ex.com"
def signup(page):
    u,e = rnd()
    page.goto(BASE, wait_until="networkidle", timeout=30000); page.wait_for_timeout(500)
    page.locator('[data-auth-tab="signup"]').first.click(); page.wait_for_timeout(300)
    f = page.locator('#signupForm')
    f.locator('input[name="displayName"]').fill(u); f.locator('input[name="username"]').fill(u)
    f.locator('input[name="email"]').fill(e); f.locator('input[name="password"]').fill("TestPass123!")
    for i,d in enumerate("7392"): f.locator('[data-pin-cell]').nth(i).fill(d)
    t=f.locator('input[type="checkbox"]')
    if t.count():
        try: t.first.check()
        except: pass
    f.locator('button[type="submit"]').click(); page.wait_for_timeout(2500)
    return u

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width":390,"height":844})
    cerr=[]
    pg.on("pageerror", lambda e: cerr.append(str(e)))
    pg.on("console", lambda m: cerr.append(m.text) if m.type=="error" else None)
    u1 = signup(pg)
    log("signed up", pg.locator('#appShell').is_visible())

    # Go to Primary (chat) tab -> notes rail should render with "Your note" cell
    pg.locator('.bn-btn[data-tab="chat"]').click(); pg.wait_for_timeout(1500)
    log("notes rail present", pg.locator('#notesRail').count() == 1)
    log("'Your note' cell visible", pg.locator('#notesRail .note-cell.mine').count() == 1)
    log("shows add badge when no note", pg.locator('#notesRail .note-cell.mine .note-add-badge').count() == 1)

    # Open note modal, type a note, share
    pg.locator('#notesRail .note-cell.mine').click(); pg.wait_for_timeout(700)
    log("note modal opens", pg.locator('#noteModal').is_visible())
    pg.locator('#noteInput').fill("Working on PRIV SPACA 🚀")
    pg.wait_for_timeout(200)
    log("preview updates live", "PRIV SPACA" in pg.locator('#notePreviewBubble').inner_text())
    pg.locator('#noteShareBtn').click(); pg.wait_for_timeout(1200)
    log("modal closed after share", not pg.locator('#noteModal').is_visible())
    log("my bubble now shows note text", "PRIV SPACA" in (pg.locator('#notesRail .note-cell.mine .note-bubble').inner_text() or ""))
    log("add badge gone after setting note", pg.locator('#notesRail .note-cell.mine .note-add-badge').count() == 0)

    # Second user should SEE u1's note on their rail
    ctx2 = b.new_context(viewport={"width":390,"height":844})
    pg2 = ctx2.new_page(); u2 = signup(pg2)
    pg2.locator('.bn-btn[data-tab="chat"]').click(); pg2.wait_for_timeout(1800)
    friend_notes = pg2.locator('#notesRail .note-cell:not(.mine)')
    log("friend note visible to other user", friend_notes.count() >= 1, str(friend_notes.count()))
    if friend_notes.count() >= 1:
        log("friend note text matches", "PRIV SPACA" in (friend_notes.first.locator('.note-bubble').inner_text() or ""))
        # tapping friend note opens a DM
        friend_notes.first.click(); pg2.wait_for_timeout(1000)
        title = (pg2.locator('#chatTitle').inner_text() or "").strip()
        log("tapping friend note opens DM", title not in ("", "#general-group"), title)

    # Clear note back on u1
    pg.locator('.bn-btn[data-tab="chat"]').click(); pg.wait_for_timeout(800)
    pg.locator('#notesRail .note-cell.mine').click(); pg.wait_for_timeout(600)
    pg.locator('#noteClearBtn').click(); pg.wait_for_timeout(1000)
    log("note cleared -> add badge back", pg.locator('#notesRail .note-cell.mine .note-add-badge').count() == 1)

    log("no uncaught JS errors", len([e for e in cerr if 'pageerror' in e or 'Uncaught' in e])==0, str(cerr[:3]))
    b.close()
print("\n=== SUMMARY ===")
if errs: print("FAILURES:", errs); sys.exit(1)
print("All notes-feature checks passed.")
