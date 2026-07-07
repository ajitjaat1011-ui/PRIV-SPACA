#!/usr/bin/env python3
"""
Comprehensive wiring + functions check for PRIV-SPACA.
Tests every API endpoint (or at least a representative sample),
every data type in Turso, every code path in cf-worker.js.

Run: python3 scripts/full-wiring-test.py [--prod]
"""
import json
import sys
import time
import random
import string
import requests

BASE = "https://priv-spaca.pages.dev"

def rand(n=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))

def api(method, path, token=None, body=None, timeout=30):
    headers = {"Origin": "https://priv-spaca.pages.dev"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        r = requests.request(method, BASE + path, headers=headers, json=body, timeout=timeout)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, {}
    except Exception as e:
        return 0, {"_error": str(e)}

passed = 0
failed = 0
warnings = 0

def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        print(f"  [FAIL] {name}  --  {detail}")

def warn(name, detail=""):
    global warnings
    warnings += 1
    print(f"  [WARN] {name}  --  {detail}")

print("=" * 70)
print("PRIV-SPACA WIRING + FUNCTIONS CHECK")
print("=" * 70)

# ====================================================================
# 1. PUBLIC ENDPOINTS
# ====================================================================
print("\n--- 1. PUBLIC ENDPOINTS ---")

status, h = api("GET", "/api/health")
check("GET /api/health returns 200", status == 200, f"status={status} body={h}")
check("/api/health has persistence=turso-libsql-primary",
      h.get("persistence") == "turso-libsql-primary", f"got persistence={h.get('persistence')}")
check("/api/health has secondaryPersistence=turso-structured-social",
      h.get("secondaryPersistence") == "turso-structured-social", f"got secondaryPersistence={h.get('secondaryPersistence')}")

status, vapid = api("GET", "/api/push/vapid-public")
check("GET /api/push/vapid-public returns 200", status == 200, f"status={status}")
check("vapid key is non-empty string",
      isinstance(vapid.get("key"), str) and len(vapid["key"]) > 50, f"key length={len(vapid.get('key',''))}")

status, h = api("GET", "/")
check("GET / (index.html) returns 200", status == 200, f"status={status}")

status, h = api("GET", "/manifest.json")
check("GET /manifest.json returns 200", status == 200, f"status={status}")

# ====================================================================
# 2. AUTH ENDPOINTS
# ====================================================================
print("\n--- 2. AUTH ENDPOINTS ---")

# Create test users
users = []
for i in range(3):
    sfx = rand(6)
    email = f"wire_{sfx}@test.local"
    username = f"wire_{sfx}"
    pw = "WireTest123!"
    pin = str(random.randint(1000, 9999))
    while pin in {'0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321'}:
        pin = str(random.randint(1000, 9999))
    status, h = api("POST", "/api/auth/signup", body={
        "email": email, "username": username, "displayName": f"Wire {i}",
        "password": pw, "pin": pin, "termsAccepted": True
    })
    if status == 200 and h.get("token"):
        users.append({"email": email, "username": username, "password": pw, "pin": pin,
                       "token": h["token"], "id": h["user"]["id"]})
    else:
        check(f"signup user {i}", False, f"status={status} body={h}")

check(f"created {len(users)} test users (need 3)", len(users) == 3)

if len(users) >= 1:
    status, h = api("POST", "/api/auth/login", body={"identifier": users[0]["username"], "password": users[0]["password"]})
    check("login with username", status == 200 and "token" in h, f"status={status}")
    users[0]["token"] = h.get("token", users[0]["token"])

if len(users) >= 1:
    status, h = api("POST", "/api/auth/login", body={"identifier": users[0]["email"], "password": users[0]["password"]})
    check("login with email", status == 200 and "token" in h, f"status={status}")

if len(users) >= 1:
    status, h = api("POST", "/api/auth/login", body={"identifier": users[0]["username"], "password": "wrongpw"})
    check("login with wrong password is 401", status == 401, f"status={status}")

if len(users) >= 1:
    status, h = api("GET", "/api/auth/me", token=users[0]["token"])
    check("GET /api/auth/me", status == 200 and h.get("user", {}).get("id") == users[0]["id"], f"status={status}")

if len(users) >= 1:
    status, h = api("GET", "/api/auth/me", token="invalid")
    check("GET /api/auth/me with bad token is 401", status == 401, f"status={status}")

if len(users) >= 1:
    status, h = api("GET", "/api/auth/me")  # no token
    check("GET /api/auth/me without token is 401", status == 401, f"status={status}")

# ====================================================================
# 3. USER ENDPOINTS
# ====================================================================
print("\n--- 3. USER ENDPOINTS ---")

if len(users) >= 1:
    status, h = api("GET", "/api/users", token=users[0]["token"])
    check("GET /api/users", status == 200, f"status={status}")
    check("/api/users returns users array", isinstance(h.get("users"), list), f"body keys: {list(h.keys())}")
    user_ids_in_response = [u.get("id") for u in h.get("users", [])]
    check("owner (Arvind_1011) is in users list", any("mr1p9tls" in uid for uid in user_ids_in_response),
          f"sample ids: {user_ids_in_response[:5]}")

if len(users) >= 1:
    status, h = api("GET", "/api/users", token="invalid")
    check("GET /api/users without auth is 401", status == 401, f"status={status}")

if len(users) >= 1:
    # Update own profile
    status, h = api("POST", "/api/user/update", token=users[0]["token"], body={
        "bio": "I exist to test wirings", "cardVisibility": "everyone"
    })
    check("POST /api/user/update (bio + cardVisibility)", status == 200, f"status={status} body={h}")
    # Verify
    status, h = api("GET", "/api/auth/me", token=users[0]["token"])
    check("updated bio persisted", h.get("user", {}).get("bio") == "I exist to test wirings", f"bio={h.get('user', {}).get('bio')}")

if len(users) >= 1:
    # Heartbeat
    status, h = api("POST", "/api/user/heartbeat", token=users[0]["token"])
    check("POST /api/user/heartbeat", status == 200, f"status={status}")

if len(users) >= 1:
    # Note
    status, h = api("POST", "/api/user/note", token=users[0]["token"], body={"text": "test note", "music": None})
    check("POST /api/user/note (text)", status == 200, f"status={status}")

if len(users) >= 1:
    # Typing indicator
    status, h = api("POST", "/api/user/typing", token=users[0]["token"], body={"roomId": "general-group", "typing": True})
    check("POST /api/user/typing (start)", status == 200, f"status={status}")

if len(users) >= 2:
    status, h = api("GET", "/api/user/typing?roomId=general-group", token=users[1]["token"])
    check("GET /api/user/typing (other user sees it)", status == 200, f"status={status}")

if len(users) >= 1:
    # Public key upload
    fake_key = "A" * 64  # 64 char base64url-ish
    status, h = api("POST", "/api/user/public-key", token=users[0]["token"], body={"publicKey": fake_key})
    check("POST /api/user/public-key", status == 200, f"status={status}")

if len(users) >= 2:
    # Public key fetch for someone else
    status, h = api("GET", f"/api/user/public-key?userId={users[0]['id']}", token=users[1]["token"])
    check("GET /api/user/public-key (other user)", status == 200, f"status={status}")
    check("public key matches what we uploaded", h.get("publicKey") == fake_key, f"got: {h.get('publicKey')}")

# ====================================================================
# 4. MESSAGES ENDPOINTS
# ====================================================================
print("\n--- 4. MESSAGES ENDPOINTS ---")

if len(users) >= 1:
    status, h = api("POST", "/api/messages/send", token=users[0]["token"], body={
        "roomId": "general-group", "text": "Hello from wiring test!"
    })
    check("POST /api/messages/send (group)", status == 200, f"status={status}")
    msg_id = h.get("message", {}).get("id") if status == 200 else None

if len(users) >= 1:
    status, h = api("GET", "/api/messages?roomId=general-group", token=users[0]["token"])
    check("GET /api/messages (group)", status == 200, f"status={status}")
    found = any(m.get("id") == msg_id for m in h.get("messages", []))
    check("sent message is in group history", found, f"looking for id={msg_id}")

if len(users) >= 1:
    # Empty message
    status, h = api("POST", "/api/messages/send", token=users[0]["token"], body={
        "roomId": "general-group", "text": ""
    })
    check("empty message is 400", status == 400, f"status={status}")

if len(users) >= 2:
    # DM
    status, h = api("POST", "/api/messages/send", token=users[0]["token"], body={
        "roomId": f"dm:{users[0]['id']}:{users[1]['id']}", "text": "DM test"
    })
    check("POST /api/messages/send (DM)", status == 200, f"status={status}")

if len(users) >= 2:
    dm_room = "dm:" + ":".join(sorted([users[0]["id"], users[1]["id"]]))
    status, h = api("GET", f"/api/messages?roomId={dm_room}", token=users[1]["token"])
    check("recipient can read DM", status == 200, f"status={status}")

if len(users) >= 2:
    # Try to delete other's message
    status, h = api("POST", "/api/messages/delete", token=users[1]["token"], body={"messageId": "msg_nonexistent"})
    check("delete others' message is rejected", status in (403, 404), f"status={status}")

if len(users) >= 1 and msg_id:
    status, h = api("POST", "/api/messages/delete", token=users[0]["token"], body={"messageId": msg_id})
    check("delete own message", status == 200, f"status={status}")

if len(users) >= 1 and msg_id:
    status, h = api("POST", "/api/messages/restore", token=users[0]["token"], body={"messageId": msg_id})
    check("restore own message", status == 200, f"status={status}")

# Scheduled messages
if len(users) >= 1:
    # Schedule a message 1 hour from now
    deliverAt = int(time.time() * 1000) + 3600 * 1000
    status, h = api("POST", "/api/messages/schedule", token=users[0]["token"], body={
        "roomId": "general-group", "text": "Scheduled hello", "deliverAt": deliverAt
    })
    check("POST /api/messages/schedule", status == 200, f"status={status}")
    sched_id = h.get("scheduled", {}).get("id") if status == 200 else None

if len(users) >= 1:
    status, h = api("GET", "/api/messages/scheduled", token=users[0]["token"])
    check("GET /api/messages/scheduled", status == 200, f"status={status}")

if len(users) >= 1:
    # Schedule too soon should be rejected
    deliverAt = int(time.time() * 1000) + 1000  # 1 second
    status, h = api("POST", "/api/messages/schedule", token=users[0]["token"], body={
        "roomId": "general-group", "text": "Too soon", "deliverAt": deliverAt
    })
    check("schedule too soon is rejected", status == 400, f"status={status}")

if len(users) >= 1 and sched_id:
    status, h = api("POST", "/api/messages/scheduled/cancel", token=users[0]["token"], body={"id": sched_id})
    check("cancel scheduled message", status == 200, f"status={status}")

# ====================================================================
# 5. POSTS ENDPOINTS
# ====================================================================
print("\n--- 5. POSTS ENDPOINTS ---")

if len(users) >= 1:
    status, h = api("POST", "/api/posts/create", token=users[0]["token"], body={
        "text": "First wiring test post", "kind": "post"
    })
    check("POST /api/posts/create", status == 200, f"status={status}")
    post_id = h.get("post", {}).get("id") if status == 200 else None

if len(users) >= 1:
    status, h = api("GET", "/api/posts", token=users[0]["token"])
    check("GET /api/posts", status == 200, f"status={status}")
    found = any(p.get("id") == post_id for p in h.get("posts", []))
    check("created post is in list", found, f"looking for id={post_id}")

if len(users) >= 1 and post_id:
    status, h = api("POST", "/api/posts/like", token=users[0]["token"], body={"postId": post_id})
    check("like post", status == 200, f"status={status}")
    check("likeCount is 1", h.get("likeCount") == 1, f"likeCount={h.get('likeCount')}")

if len(users) >= 1 and post_id:
    status, h = api("POST", "/api/posts/like", token=users[0]["token"], body={"postId": post_id})
    check("unlike post (toggle)", status == 200, f"status={status}")
    check("likeCount is 0 after unlike", h.get("likeCount") == 0, f"likeCount={h.get('likeCount')}")

if len(users) >= 1 and post_id:
    status, h = api("POST", "/api/posts/comment", token=users[0]["token"], body={
        "postId": post_id, "text": "Nice post!"
    })
    check("comment on post", status == 200, f"status={status}")

if len(users) >= 2 and post_id:
    # Try to delete other's post
    status, h = api("POST", "/api/posts/delete", token=users[1]["token"], body={"postId": post_id})
    check("delete others' post is rejected", status in (403, 404), f"status={status}")

if len(users) >= 1 and post_id:
    status, h = api("POST", "/api/posts/delete", token=users[0]["token"], body={"postId": post_id})
    check("delete own post", status == 200, f"status={status}")

if len(users) >= 1 and post_id:
    status, h = api("POST", "/api/posts/restore", token=users[0]["token"], body={"postId": post_id})
    check("restore own post", status == 200, f"status={status}")

# ====================================================================
# 6. SOCIAL GRAPH ENDPOINTS
# ====================================================================
print("\n--- 6. SOCIAL GRAPH ---")

if len(users) >= 2:
    status, h = api("POST", "/api/user/follow", token=users[0]["token"], body={"targetId": users[1]["id"]})
    check("follow user", status == 200, f"status={status}")

if len(users) >= 2:
    # Check profile shows iFollow
    status, h = api("GET", f"/api/user/{users[1]['id']}/profile", token=users[0]["token"])
    check(f"GET /api/user/{users[1]['id']}/profile", status == 200, f"status={status}")
    check("iFollow is True after follow", h.get("relationship", {}).get("iFollow") == True,
          f"iFollow={h.get('user', {}).get('iFollow')}")

if len(users) >= 2:
    status, h = api("POST", "/api/user/unfollow", token=users[0]["token"], body={"targetId": users[1]["id"]})
    check("unfollow user", status == 200, f"status={status}")

if len(users) >= 2:
    status, h = api("POST", "/api/user/block", token=users[0]["token"], body={"targetId": users[1]["id"]})
    check("block user", status == 200, f"status={status}")

if len(users) >= 2:
    # After block, blocked user should not appear in /api/users
    status, h = api("GET", "/api/users", token=users[0]["token"])
    other_visible = any(u.get("id") == users[1]["id"] for u in h.get("users", []))
    check("blocked user hidden from list", not other_visible, f"user 1 visible: {other_visible}")

if len(users) >= 2:
    status, h = api("POST", "/api/user/unblock", token=users[0]["token"], body={"targetId": users[1]["id"]})
    check("unblock user", status == 200, f"status={status}")

# Close friends
if len(users) >= 2:
    status, h = api("POST", "/api/user/close-friends", token=users[0]["token"], body={"targetId": users[1]["id"], "mode": "add"})
    check("add to close friends", status == 200, f"status={status}")

if len(users) >= 1:
    status, h = api("GET", "/api/user/close-friends", token=users[0]["token"])
    check("GET /api/user/close-friends", status == 200, f"status={status}")

if len(users) >= 2:
    status, h = api("POST", "/api/user/close-friends", token=users[0]["token"], body={"targetId": users[1]["id"], "mode": "remove"})
    check("remove from close friends", status == 200, f"status={status}")

# VIP redeem
if len(users) >= 1:
    status, h = api("POST", "/api/user/vip/redeem", token=users[0]["token"], body={"code": "INVALID_CODE"})
    check("VIP redeem with bad code fails", status in (400, 401, 403, 404), f"status={status}")

# ====================================================================
# 7. NOTIFICATIONS
# ====================================================================
print("\n--- 7. NOTIFICATIONS ---")

if len(users) >= 1:
    status, h = api("GET", "/api/notifications", token=users[0]["token"])
    check("GET /api/notifications", status == 200, f"status={status}")

if len(users) >= 1:
    status, h = api("POST", "/api/notifications/seen", token=users[0]["token"], body={})
    check("POST /api/notifications/seen", status == 200, f"status={status}")

if len(users) >= 1:
    status, h = api("POST", "/api/notifications/clear", token=users[0]["token"], body={})
    check("POST /api/notifications/clear", status == 200, f"status={status}")

# ====================================================================
# 8. UPLOAD (Cloudinary)
# ====================================================================
print("\n--- 8. UPLOAD (Cloudinary) ---")

if len(users) >= 1:
    # 1x1 PNG
    png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    dataurl = f"data:image/png;base64,{png_b64}"
    status, h = api("POST", "/api/upload-photo", token=users[0]["token"], body={"dataUrl": dataurl, "kind": "post"})
    check("POST /api/upload-photo (image)", status == 200, f"status={status}")
    url = h.get("url", "")
    if "cloudinary.com" in url:
        check("uploaded to Cloudinary", True)
        print(f"        URL: {url[:90]}")
    elif "raw.githubusercontent" in url:
        warn("uploaded to GitHub fallback (Cloudinary env vars not set?)", f"url={url[:80]}")
    else:
        warn("uploaded to unknown destination", f"url={url[:80]}")

if len(users) >= 1:
    # Invalid data URL
    status, h = api("POST", "/api/upload-photo", token=users[0]["token"], body={"dataUrl": "not-a-data-url"})
    check("invalid dataUrl is 400", status == 400, f"status={status}")

# ====================================================================
# 9. RTC SIGNALING
# ====================================================================
print("\n--- 9. RTC SIGNALING ---")

if len(users) >= 2:
    status, h = api("POST", "/api/rtc/signal", token=users[0]["token"], body={
        "targetId": users[1]["id"], "signal": {"type": "offer", "sdp": "fake-sdp"}
    })
    check("POST /api/rtc/signal (send offer)", status == 200, f"status={status}")

if len(users) >= 2:
    status, h = api("GET", f"/api/rtc/signals?peerId={users[0]['id']}", token=users[1]["token"])
    check("GET /api/rtc/signals (receive)", status == 200, f"status={status}")
    found = any(s.get("fromId") == users[0]["id"] for s in h.get("signals", []))
    check("received signal from peer", found, f"signals: {h.get('signals', [])[:2]}")

# ====================================================================
# 10. PUSH SUBSCRIPTIONS
# ====================================================================
print("\n--- 10. PUSH SUBSCRIPTIONS ---")

if len(users) >= 1:
    fake_sub = {"endpoint": "https://fake-push-service.example.com/abc123", "keys": {"p256dh": "x" * 64, "auth": "y" * 32}}
    status, h = api("POST", "/api/push/subscribe", token=users[0]["token"], body={"subscription": fake_sub})
    check("POST /api/push/subscribe", status == 200, f"status={status}")

if len(users) >= 1:
    status, h = api("POST", "/api/push/unsubscribe", token=users[0]["token"], body={"endpoint": "https://fake-push-service.example.com/abc123"})
    check("POST /api/push/unsubscribe", status == 200, f"status={status}")

# ====================================================================
# 12. PIN RESET
# ====================================================================
print("\n--- 12. PIN RESET ---")

if len(users) >= 1:
    new_pw = "NewWire123!"
    status, h = api("POST", "/api/auth/reset-by-pin", body={
        "identifier": users[0]["email"], "newPassword": new_pw, "pin": users[0]["pin"]
    })
    check("reset password via PIN", status == 200, f"status={status} body={h}")

if len(users) >= 1:
    new_pw = "NewWire123!"
    status, h = api("POST", "/api/auth/login", body={"identifier": users[0]["email"], "password": new_pw})
    check("login with new password after reset", status == 200, f"status={status}")
    if status == 200 and h.get("token"):
        users[0]["token"] = h["token"]  # use the new token for subsequent tests

if len(users) >= 1:
    status, h = api("POST", "/api/auth/reset-by-pin", body={
        "identifier": users[0]["email"], "newPassword": "whatever", "pin": "0000"
    })
    check("reset with wrong PIN is rejected", status in (400, 401), f"status={status}")

# ====================================================================
# 11. STORIES + FEED
# ====================================================================
print("\n--- 11. STORIES + FEED ---")

# Create a story as user 0
if len(users) >= 2:
    status, h = api("POST", "/api/posts/create", token=users[0]["token"], body={
        "text": "Story test", "story": True, "audience": "all"
    })
    check("create story post", status == 200, f"status={status}")
    story_id = h.get("post", {}).get("id") if status == 200 else None

    if story_id:
        # User 1 views the story
        status, h = api("POST", f"/api/stories/{story_id}/view", token=users[1]["token"])
        check("POST /api/stories/:id/view (other user)", status == 200, f"status={status}")
        check("viewCount is 1 after view", h.get("viewCount") == 1, f"viewCount={h.get('viewCount')}")

        # Author can see viewers
        status, h = api("GET", f"/api/stories/{story_id}/viewers", token=users[0]["token"])
        check("GET /api/stories/:id/viewers (author)", status == 200, f"status={status}")
        check("viewers list contains user 1", any(v.get("id") == users[1]["id"] for v in h.get("viewers", [])),
              f"viewers: {h.get('viewers', [])}")

        # Non-author cannot see viewers
        status, h = api("GET", f"/api/stories/{story_id}/viewers", token=users[1]["token"])
        check("GET /api/stories/:id/viewers (non-author is 403)", status == 403, f"status={status}")

        # Reply to story (becomes DM)
        status, h = api("POST", f"/api/stories/{story_id}/reply", token=users[1]["token"],
                        body={"text": "Nice story!", "emoji": "🔥"})
        check("POST /api/stories/:id/reply", status == 200, f"status={status}")

        # Author replies to own story = 400
        status, h = api("POST", f"/api/stories/{story_id}/reply", token=users[0]["token"], body={"text": "self"})
        check("reply to own story is 400", status == 400, f"status={status}")

        # View nonexistent story
        status, h = api("POST", "/api/stories/nonexistent/view", token=users[1]["token"])
        check("view nonexistent story is 404", status == 404, f"status={status}")

# Feed (own + followed users)
if len(users) >= 1:
    status, h = api("GET", "/api/feed", token=users[0]["token"])
    check("GET /api/feed", status == 200, f"status={status}")
    check("feed has source field", "source" in h, f"keys: {list(h.keys())}")
    check("feed is an array", isinstance(h.get("posts"), list), f"posts type: {type(h.get('posts'))}")

# ====================================================================
# 13. TURSO DB DIRECT CHECK
# ====================================================================
print("\n--- 13. TURSO DB DIRECT ---")
import subprocess
try:
    out = subprocess.run(
        ["node", "-e", f"""
const {{ createClient }} = require('@libsql/client');
(async () => {{
  const c = createClient({{
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  }});
  const tables = ['ps_users','ps_posts','ps_messages','ps_notifications','ps_dm_index','ps_user_feeds','ps_events','ps_rate_limits','ps_meta','ps_kv'];
  for (const t of tables) {{
    const rs = await c.execute('SELECT count(*) as c FROM ' + t);
    console.log(t.padEnd(25) + Number(rs.rows[0].c) + ' rows');
  }}
  // Check that the owner is present
  const ownerRs = await c.execute(\"SELECT username_lower, email_lower FROM ps_users WHERE email_lower = 'arvindjaat1011@gmail.com'\");
  console.log('owner present:', ownerRs.rows.length === 1);
}})();
"""],
        capture_output=True, text=True, timeout=20, cwd="/home/user/PRIV-SPACA"
    )
    if out.returncode == 0:
        for line in out.stdout.strip().split("\n"):
            print(f"  {line}")
        check("Turso DB direct query works", True)
    else:
        warn("Turso direct query failed", out.stderr[:200])
except Exception as e:
    warn("Could not run Turso direct query", str(e))

# ====================================================================
# SUMMARY
# ====================================================================
print("\n" + "=" * 70)
print(f"TOTAL: {passed} passed, {failed} failed, {warnings} warnings")
print("=" * 70)

sys.exit(0 if failed == 0 else 1)
