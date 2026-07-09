import random, string, sys
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8787"
errs = []
def log(n, ok, d=""):
    print(("[PASS] " if ok else "[FAIL] ") + n + (f" -- {d}" if d else ""))
    if not ok: errs.append(n)
def rnd():
    s = ''.join(random.choices(string.ascii_lowercase+string.digits, k=6))
    return f"nm_{s}", f"nm_{s}@ex.com"
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
    # Stub the iTunes search so the music picker is hermetic.
    pg.route("**/itunes.apple.com/search**", lambda route: route.fulfill(
        status=200, content_type="application/json",
        body='{"resultCount":1,"results":[{"trackName":"Test Song","artistName":"Test Artist","artworkUrl100":"https://example.com/a.jpg","previewUrl":"https://example.com/p.m4a"}]}'))
    u1 = signup(pg)
    log("signed up", pg.locator('#appShell').is_visible())

    # --- IG username header ---
    pg.locator('.bn-btn[data-tab="chat"]').click(); pg.wait_for_timeout(1200)
    log("brand wordmark hidden on chat tab", "hidden" in (pg.locator('#brandWordmark').get_attribute("class") or ""))
    log("IG username header visible", pg.locator('#igUsernameHeader').is_visible())
    un = (pg.evaluate("() => (document.getElementById('igUsernameText')?.textContent||'')") or '').strip()
    log("username text matches", un == u1, un)
    # back to feed -> brand returns
    pg.locator('.bn-btn[data-tab="feed"]').click(); pg.wait_for_timeout(700)
    log("brand wordmark returns on feed", pg.locator('#brandWordmark').is_visible())

    # --- Note editor: text + music picker ---
    pg.locator('.bn-btn[data-tab="chat"]').click(); pg.wait_for_timeout(1000)
    pg.locator('#notesRail .note-cell.mine').click(); pg.wait_for_timeout(700)
    log("note modal opens", pg.locator('#noteModal').is_visible())
    log("Add music row present", pg.locator('#noteMusicRow').is_visible())
    pg.locator('#noteInput').fill("vibing tonight")
    pg.wait_for_timeout(200)
    log("preview reflects text", "vibing tonight" in pg.evaluate("() => (document.getElementById('notePreviewText')?.textContent||'')"))

    # Open the music picker and pick a (stubbed) song through the real UI.
    pg.locator('#noteMusicRow').click(); pg.wait_for_timeout(400)
    pg.locator('#noteSongSearch').fill("test"); pg.wait_for_timeout(900)
    log("song result appears", pg.locator('#noteSongList .note-song-item').count() >= 1, str(pg.locator('#noteSongList .note-song-item').count()))
    pg.locator('#noteSongList .note-song-item').first.click(); pg.wait_for_timeout(500)
    log("music row shows selected song", "Test Song" in pg.evaluate("() => (document.getElementById('noteMusicTitle')?.textContent||'')"))
    log("preview shows song line", ("Test Song" in pg.evaluate("() => (document.getElementById('notePreviewSong')?.textContent||'')")))

    pg.locator('#noteShareBtn').click(); pg.wait_for_timeout(1200)
    log("modal closed after share", not pg.locator('#noteModal').is_visible())
    myBubTxt = pg.evaluate("() => { var e=document.querySelector('#notesRail .note-cell.mine .note-bubble'); return e?e.textContent:''; }")
    log("my note bubble shows song", "Test Song" in (myBubTxt or ""), myBubTxt)
    log("my note avatar has music ring", pg.locator('#notesRail .note-cell.mine .note-avatar.has-music').count() == 1)

    # --- Friend sees my music note ---
    ctx2 = b.new_context(viewport={"width":390,"height":844})
    pg2 = ctx2.new_page(); u2 = signup(pg2)
    pg2.locator('.bn-btn[data-tab="chat"]').click(); pg2.wait_for_timeout(1800)
    fn = pg2.locator('#notesRail .note-cell:not(.mine)')
    log("friend sees my note", fn.count() >= 1, str(fn.count()))
    if fn.count() >= 1:
        log("friend note shows song title", "Test Song" in (pg2.evaluate("() => { var e=document.querySelector('#notesRail .note-cell:not(.mine) .note-bubble'); return e?e.textContent:''; }") or ""))
        log("friend note has music ring", fn.first.locator('.note-avatar.has-music').count() == 1)

    log("no uncaught JS errors", len([e for e in cerr if 'pageerror' in e or 'Uncaught' in e])==0, str(cerr[:3]))
    b.close()
print("\n=== SUMMARY ===")
if errs: print("FAILURES:", errs); sys.exit(1)
print("All notes-music + header checks passed.")
