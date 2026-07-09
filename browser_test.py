#!/usr/bin/env python3
"""
Real-browser (Playwright/Chromium) sanity check for PRIV-SPACA fixes:
  1. No JS console errors on load (esp. no "openPostComposer is not defined")
  2. Sign up a fresh user -> lands on app
  3. Reload the page -> session should PERSIST (was auto-logging-out before fix)
  4. Click the "+" (new post) button -> composer should open, not be dead
  5. Click the profile settings hamburger -> settings sheet should open
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "https://priv-spaca.pages.dev"
errors = []
console_errors = []

def log(name, ok, detail=""):
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""))
    if not ok:
        errors.append(name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: console_errors.append(str(exc)))

    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    real_errors = [e for e in console_errors if 'Failed to load resource' not in e and 'favicon' not in e]
    log("no JS console/page errors on load", len(real_errors) == 0, "; ".join(real_errors[:5]))

    # Sign up a fresh user through the real UI
    import random, string
    suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    username = f"btest_{suffix}"
    email = f"btest_{suffix}@example.com"

    # Switch to signup tab
    try:
        page.locator('[data-auth-tab="signup"]').first.click()
        page.wait_for_timeout(300)
    except Exception as e:
        print("signup tab click issue:", e)

    page.screenshot(path="/tmp/bt_1_authscreen.png")

    signup_form = page.locator('#signupForm')

    def fill_scoped(selector, value):
        loc = signup_form.locator(selector)
        if loc.count() > 0:
            loc.first.fill(value)
            return True
        return False

    filled_email = fill_scoped('input[name="email"]', email)
    filled_username = fill_scoped('input[name="username"]', username)
    filled_display = fill_scoped('input[name="displayName"]', "Browser Test")
    filled_password = fill_scoped('input[name="password"]', "TestPass123!")

    log("signup form fields located & filled", filled_email and filled_username and filled_password,
        f"email={filled_email} username={filled_username} display={filled_display} password={filled_password}")

    # PIN inputs (4 separate boxes inside signup form)
    pin_inputs = signup_form.locator('[data-pin-cell]')
    pin_digits = "5827"
    if pin_inputs.count() >= 4:
        for i in range(4):
            pin_inputs.nth(i).fill(pin_digits[i])
    else:
        log("PIN inputs found", False, f"count={pin_inputs.count()}")

    # Terms checkbox (pre-checked already per markup, but ensure it's checked)
    terms_cb = signup_form.locator('#termsCheckbox')
    if terms_cb.count() > 0:
        if not terms_cb.first.is_checked():
            terms_cb.first.check(force=True)

    page.screenshot(path="/tmp/bt_2_filled_signup.png")

    submit_btn = signup_form.locator('button[type="submit"]')
    if submit_btn.count() > 0:
        submit_btn.first.click()
    else:
        log("found signup submit button", False)

    try:
        page.locator('#appShell:not(.hidden)').wait_for(state="visible", timeout=10000)
    except Exception:
        pass
    page.wait_for_timeout(500)
    page.screenshot(path="/tmp/bt_3_after_signup.png")

    app_shell_visible = page.locator('#appShell:not(.hidden)').count() > 0
    log("app shown after signup", app_shell_visible)

    # ---- Test the circular floating "+" new post button ----
    top_add = page.locator('#floatingAddBtn')
    if top_add.count() > 0:
        top_add.first.click()
        page.wait_for_timeout(800)
        composer_visible = page.locator('#inlineComposerCard:not(.hidden)').count() > 0
        log("new-post (+) button opens composer", composer_visible)
        page.screenshot(path="/tmp/bt_4_composer.png")
    else:
        log("new-post (+) button exists", False)

    # ---- Test hamburger/settings button on profile tab ----
    profile_tab_btn = page.locator('.bn-btn[data-tab="profile"]')
    if profile_tab_btn.count() > 0:
        profile_tab_btn.first.click()
        page.wait_for_timeout(800)
    settings_btn = page.locator('#profileSettingsBtn')
    if settings_btn.count() > 0:
        settings_btn.first.click()
        page.wait_for_timeout(800)
        settings_visible = page.locator('#settingsSheet:not(.hidden)').count() > 0
        log("profile hamburger opens settings sheet", settings_visible)
        page.screenshot(path="/tmp/bt_5_settings.png")
        # close it back (use Escape to avoid overlapping-element click issues)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        close_x = page.locator('button[data-close-settings]')
        if close_x.count() > 0:
            try:
                close_x.first.click(timeout=3000)
            except Exception:
                pass
    else:
        log("profile settings button exists", False)

    # ---- Reload and confirm session persists (the main bug report) ----
    console_errors.clear()
    page.reload(wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    page.screenshot(path="/tmp/bt_6_after_reload.png")

    still_logged_in = page.locator('#appShell:not(.hidden)').count() > 0
    back_on_login = page.locator('#authShell:not(.hidden)').count() > 0
    log("session persists after page reload (not auto-logged-out)", still_logged_in and not back_on_login,
        f"appShellVisible={still_logged_in} authShellVisible={back_on_login}")
    real_errors = [e for e in console_errors if 'Failed to load resource' not in e and 'favicon' not in e]
    log("no JS console/page errors after reload", len(real_errors) == 0, "; ".join(real_errors[:5]))

    browser.close()

print("\n" + "="*50)
if errors:
    print(f"{len(errors)} FAILURES:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
else:
    print("ALL BROWSER TESTS PASSED")
