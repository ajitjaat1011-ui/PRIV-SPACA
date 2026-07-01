#!/usr/bin/env python3
"""
End-to-end feature test suite for PRIV-SPACA (https://priv-spaca.pages.dev)
Tests: mass signup/login, messaging (group+DM), posts, likes, comments,
follow/block, notifications, typing/heartbeat, scheduled messages,
photo upload, PIN reset, RTC signaling, edge cases / error handling.
"""
import requests, time, random, string, json, sys

BASE = "https://priv-spaca.pages.dev"
results = []

def log(name, ok, detail=""):
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not ok else ""))

def rand_str(n=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))

def api(method, path, token=None, **kw):
    headers = kw.pop('headers', {})
    if token:
        headers['Authorization'] = f'Bearer {token}'
    last_exc = None
    for attempt in range(6):
        try:
            r = requests.request(method, BASE + path, headers=headers, timeout=40, **kw)
            return r
        except requests.exceptions.RequestException as e:
            last_exc = e
            time.sleep(2 * (attempt + 1))
    raise last_exc

# ---------------- 1. Mass signup ----------------
NUM_USERS = 6
users = []  # list of dicts: email, username, password, pin, token, id

for i in range(NUM_USERS):
    suffix = rand_str(6)
    email = f"tester_{suffix}@example.com"
    username = f"tester_{suffix}"
    password = "TestPass123!"
    pin = str(random.randint(1000, 9999))
    while pin in {'0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','0123','2580','1212','1313','1010','0101','1122','1221','2024','2025','2026','2027','0007','1357','2468','9876','6789'}:
        pin = str(random.randint(1000, 9999))
    r = api('POST', '/api/auth/signup', json={
        "email": email, "username": username, "displayName": f"Tester {i}",
        "password": password, "pin": pin, "termsAccepted": True
    })
    ok = r.status_code == 200 and 'token' in r.json()
    log(f"signup user {i} ({username})", ok, r.text[:200])
    if ok:
        data = r.json()
        users.append({"email": email, "username": username, "password": password,
                       "pin": pin, "token": data['token'], "id": data['user']['id']})

log("mass signup overall", len(users) == NUM_USERS, f"{len(users)}/{NUM_USERS} succeeded")

if len(users) < 2:
    print("Not enough users created, aborting further tests.")
    sys.exit(1)

# ---------------- 2. Duplicate signup rejection ----------------
r = api('POST', '/api/auth/signup', json={
    "email": users[0]['email'], "username": "someoneelse_" + rand_str(4),
    "displayName": "Dup", "password": "TestPass123!", "pin": "6031", "termsAccepted": True
})
log("duplicate email rejected", r.status_code == 409, r.text[:200])

r = api('POST', '/api/auth/signup', json={
    "email": "someoneelse_" + rand_str(4) + "@example.com", "username": users[0]['username'],
    "displayName": "Dup", "password": "TestPass123!", "pin": "6031", "termsAccepted": True
})
log("duplicate username rejected", r.status_code == 409, r.text[:200])

# ---------------- 3. Mass login (each user logs back in) ----------------
login_ok_count = 0
for u in users:
    r = api('POST', '/api/auth/login', json={"identifier": u['username'], "password": u['password']})
    ok = r.status_code == 200 and 'token' in r.json()
    if ok:
        u['token'] = r.json()['token']  # refresh token
        login_ok_count += 1
    else:
        log(f"login {u['username']}", ok, r.text[:200])
log("mass login overall", login_ok_count == len(users), f"{login_ok_count}/{len(users)}")

# Login with email instead of username
r = api('POST', '/api/auth/login', json={"identifier": users[0]['email'], "password": users[0]['password']})
log("login via email identifier", r.status_code == 200, r.text[:200])

# Wrong password
r = api('POST', '/api/auth/login', json={"identifier": users[0]['username'], "password": "wrongpass"})
log("wrong password rejected", r.status_code == 401, r.text[:200])

# Nonexistent user
r = api('POST', '/api/auth/login', json={"identifier": "doesnotexist_" + rand_str(5), "password": "whatever"})
log("nonexistent user login rejected", r.status_code == 404, r.text[:200])

# ---------------- 4. /api/auth/me ----------------
r = api('GET', '/api/auth/me', token=users[0]['token'])
log("GET /api/auth/me", r.status_code == 200 and r.json().get('user', {}).get('username') == users[0]['username'], r.text[:200])

# No token
r = api('GET', '/api/auth/me')
log("auth/me without token rejected", r.status_code in (401, 403), r.text[:200])

# ---------------- 5. Users list ----------------
r = api('GET', '/api/users', token=users[0]['token'])
log("GET /api/users", r.status_code == 200 and len(r.json().get('users', [])) >= len(users), r.text[:300])

# ---------------- 6. Profile update ----------------
r = api('POST', '/api/user/update', token=users[0]['token'], json={"bio": "Hello from test suite!", "displayName": "Tester Zero Updated"})
log("profile update", r.status_code == 200 and r.json()['user']['bio'] == "Hello from test suite!", r.text[:200])

# ---------------- 7. Group chat messaging ----------------
sent_ids = []
for i, u in enumerate(users[:3]):
    r = api('POST', '/api/messages/send', token=u['token'], json={"roomId": "general-group", "text": f"Hello group from {u['username']} #{i}"})
    ok = r.status_code == 200 and 'message' in r.json()
    if ok:
        sent_ids.append(r.json()['message']['id'])
    log(f"group message send ({u['username']})", ok, r.text[:200])

time.sleep(1)
r = api('GET', '/api/messages?roomId=general-group', token=users[0]['token'])
msgs = r.json().get('messages', []) if r.status_code == 200 else []
log("group message retrieval", r.status_code == 200 and len(msgs) >= len(sent_ids), f"got {len(msgs)} msgs")

# Empty message rejected
r = api('POST', '/api/messages/send', token=users[0]['token'], json={"roomId": "general-group", "text": ""})
log("empty group message rejected", r.status_code == 400, r.text[:200])

# ---------------- 8. Direct messages (DM) ----------------
r = api('POST', '/api/messages/send', token=users[0]['token'], json={"targetUserId": users[1]['id'], "text": "Hey, this is a DM test"})
dm_ok = r.status_code == 200
log("send DM", dm_ok, r.text[:200])
if dm_ok:
    dm_room = r.json()['message']['roomId']
    time.sleep(1)
    r = api('GET', f'/api/messages?roomId={dm_room}', token=users[1]['token'])
    dm_msgs = r.json().get('messages', []) if r.status_code == 200 else []
    log("recipient can read DM", any('DM test' in (m.get('text') or '') for m in dm_msgs), r.text[:300])

    # Forbidden: user2 tries to read a DM room they're not part of
    if len(users) >= 3:
        r = api('GET', f'/api/messages?roomId={dm_room}', token=users[2]['token'])
        log("DM forbidden to 3rd party", r.status_code == 403, r.text[:200])

# ---------------- 9. Delete + restore message ----------------
if sent_ids:
    mid = sent_ids[0]  # belongs to users[0]
    # Try delete someone else's message FIRST (users[1] attempting to delete users[0]'s message)
    r2 = api('POST', '/api/messages/delete', token=users[1]['token'], json={"messageId": mid})
    log("delete others' message forbidden", r2.status_code == 403, r2.text[:200])
    # Now the rightful owner deletes it
    r = api('POST', '/api/messages/delete', token=users[0]['token'], json={"messageId": mid})
    log("delete own message", r.status_code == 200, r.text[:200])
    r = api('POST', '/api/messages/restore', token=users[0]['token'], json={"messageId": mid})
    log("restore own message", r.status_code == 200, r.text[:200])

# ---------------- 10. Scheduled messages ----------------
future_ts = int((time.time() + 60) * 1000)  # generous buffer to survive slow/retried requests
r = api('POST', '/api/messages/schedule', token=users[0]['token'], json={"roomId": "general-group", "text": "Scheduled hello", "deliverAt": future_ts})
log("schedule message", r.status_code == 200, r.text[:200])

r = api('GET', '/api/messages/scheduled', token=users[0]['token'])
sched_list = r.json().get('scheduled', []) if r.status_code == 200 else []
log("list scheduled messages", r.status_code == 200 and len(sched_list) >= 1, r.text[:200])

# invalid deliverAt (too soon)
r = api('POST', '/api/messages/schedule', token=users[0]['token'], json={"roomId": "general-group", "text": "too soon", "deliverAt": int(time.time()*1000) + 100})
log("schedule reject deliverAt too soon", r.status_code == 400, r.text[:200])

if sched_list:
    sid = sched_list[0]['id']
    r = api('POST', '/api/messages/scheduled/cancel', token=users[0]['token'], json={"id": sid})
    log("cancel scheduled message", r.status_code == 200, r.text[:200])

# ---------------- 11. Typing indicator & heartbeat ----------------
r = api('POST', '/api/user/heartbeat', token=users[0]['token'])
log("heartbeat", r.status_code == 200, r.text[:200])

# Typing indicators expire after 4s server-side; retry the send+read pair a
# few times to tolerate slow/retried network round trips in this sandbox.
typing_seen = False
typing_last_resp = ""
for _ in range(4):
    r = api('POST', '/api/user/typing', token=users[0]['token'], json={"roomId": "general-group"})
    send_ok = r.status_code == 200
    r2 = api('GET', '/api/user/typing?roomId=general-group', token=users[1]['token'])
    typing_last_resp = r2.text[:300]
    typing_list = r2.json().get('typing', []) if r2.status_code == 200 else []
    if send_ok and any(t['id'] == users[0]['id'] for t in typing_list):
        typing_seen = True
        break
log("send typing indicator", send_ok, r.text[:200])
log("read typing indicator (other user sees it)", typing_seen, typing_last_resp)

# ---------------- 12. Follow / Unfollow / Block / Unblock ----------------
r = api('POST', '/api/user/follow', token=users[0]['token'], json={"targetId": users[1]['id']})
log("follow user", r.status_code == 200, r.text[:200])

r = api('GET', f"/api/user/{users[1]['id']}/profile", token=users[0]['token'])
log("profile shows relationship iFollow=True", r.status_code == 200 and r.json()['relationship']['iFollow'] is True, r.text[:300])

r = api('POST', '/api/user/unfollow', token=users[0]['token'], json={"targetId": users[1]['id']})
log("unfollow user", r.status_code == 200, r.text[:200])

r = api('POST', '/api/user/block', token=users[0]['token'], json={"targetId": users[2]['id'] if len(users) > 2 else users[1]['id']})
blocked_id = users[2]['id'] if len(users) > 2 else users[1]['id']
log("block user", r.status_code == 200, r.text[:200])

# blocked user shouldn't see user0 in /api/users (mutual hide)
r = api('GET', '/api/users', token=users[0]['token'])
visible_ids = [u['id'] for u in r.json().get('users', [])] if r.status_code == 200 else []
log("blocked user hidden from list", blocked_id not in visible_ids, f"visible={visible_ids}")

r = api('POST', '/api/user/unblock', token=users[0]['token'], json={"targetId": blocked_id})
log("unblock user", r.status_code == 200, r.text[:200])

# ---------------- 13. Posts: create/list/like/comment/delete/restore ----------------
r = api('POST', '/api/posts/create', token=users[0]['token'], json={"text": "My first test post!"})
post_ok = r.status_code == 200
log("create post", post_ok, r.text[:300])
post_id = r.json().get('post', {}).get('id') if post_ok else None
if not post_id and post_ok:
    # maybe different response shape
    print("DEBUG create post response:", r.text[:500])

r = api('GET', '/api/posts', token=users[0]['token'])
posts_list = r.json().get('posts', []) if r.status_code == 200 else []
log("list posts", r.status_code == 200, f"{len(posts_list)} posts, resp={r.text[:200]}")
if not post_id and posts_list:
    post_id = posts_list[0]['id']

if post_id:
    r = api('POST', '/api/posts/like', token=users[1]['token'], json={"postId": post_id})
    log("like post", r.status_code == 200 and r.json().get('liked') is True, r.text[:200])

    r = api('POST', '/api/posts/like', token=users[1]['token'], json={"postId": post_id})
    log("unlike post (toggle)", r.status_code == 200 and r.json().get('liked') is False, r.text[:200])

    r = api('POST', '/api/posts/comment', token=users[1]['token'], json={"postId": post_id, "text": "Nice post!"})
    log("comment on post", r.status_code == 200, r.text[:200])

    r = api('POST', '/api/posts/delete', token=users[1]['token'], json={"postId": post_id})
    log("delete others' post forbidden", r.status_code == 403, r.text[:200])

    r = api('POST', '/api/posts/delete', token=users[0]['token'], json={"postId": post_id})
    log("delete own post", r.status_code == 200, r.text[:200])

    r = api('POST', '/api/posts/restore', token=users[0]['token'], json={"postId": post_id})
    log("restore own post", r.status_code == 200, r.text[:200])
else:
    log("posts feature testable", False, "no post_id obtained")

# ---------------- 14. Notifications ----------------
r = api('GET', '/api/notifications', token=users[1]['token'])
log("get notifications", r.status_code == 200, r.text[:300])

r = api('POST', '/api/notifications/seen', token=users[1]['token'])
log("mark notifications seen", r.status_code == 200, r.text[:200])

r = api('POST', '/api/notifications/clear', token=users[1]['token'])
log("clear notifications", r.status_code == 200, r.text[:200])

# ---------------- 15. Public key (E2E) ----------------
fake_pubkey = 'A' * 88  # base64url-ish dummy of correct-ish length
r = api('POST', '/api/user/public-key', token=users[0]['token'], json={"publicKey": fake_pubkey})
log("upload public key", r.status_code == 200, r.text[:200])

r = api('GET', f"/api/user/public-key?userId={users[0]['id']}", token=users[1]['token'])
log("fetch public key", r.status_code == 200 and r.json().get('publicKey') == fake_pubkey, r.text[:200])

# ---------------- 16. Photo upload ----------------
tiny_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
r = api('POST', '/api/upload-photo', token=users[0]['token'], json={"dataUrl": tiny_png, "kind": "avatar"})
log("upload avatar photo", r.status_code == 200, r.text[:300])

# invalid data url
r = api('POST', '/api/upload-photo', token=users[0]['token'], json={"dataUrl": "not-a-data-url", "kind": "avatar"})
log("reject invalid photo dataUrl", r.status_code == 400, r.text[:200])

# ---------------- 17. RTC signaling ----------------
r = api('POST', '/api/rtc/signal', token=users[0]['token'], json={"targetId": users[1]['id'], "signal": {"type": "offer", "sdp": "fake-sdp"}})
log("send rtc signal", r.status_code == 200, r.text[:200])

r = api('GET', '/api/rtc/signals?since=0', token=users[1]['token'])
sig_list = r.json().get('signals', []) if r.status_code == 200 else []
log("receive rtc signal", r.status_code == 200 and any(s.get('signal', {}).get('sdp') == 'fake-sdp' for s in sig_list), r.text[:300])

# ---------------- 18. PIN reset flow ----------------
u = users[3] if len(users) > 3 else users[0]
new_password = "NewPass456!"
r = api('POST', '/api/auth/reset-by-pin', json={"identifier": u['username'], "pin": u['pin'], "newPassword": new_password})
reset_ok = r.status_code == 200
log("reset password via PIN", reset_ok, r.text[:300])
if reset_ok:
    r = api('POST', '/api/auth/login', json={"identifier": u['username'], "password": new_password})
    log("login with new password after reset", r.status_code == 200, r.text[:200])
    u['password'] = new_password

# wrong PIN
r = api('POST', '/api/auth/reset-by-pin', json={"identifier": u['username'], "pin": "0000", "newPassword": "Whatever123"})
log("reset with wrong PIN rejected", r.status_code in (400, 401), r.text[:200])

# ---------------- 19. Push notification endpoints ----------------
r = api('GET', '/api/push/vapid-public')
log("get vapid public key", r.status_code == 200, r.text[:200])

r = api('POST', '/api/push/subscribe', token=users[0]['token'], json={"subscription": {"endpoint": "https://example.com/push/1", "keys": {"p256dh": "x", "auth": "y"}}})
log("push subscribe", r.status_code == 200, r.text[:200])

r = api('POST', '/api/push/unsubscribe', token=users[0]['token'], json={"endpoint": "https://example.com/push/1"})
log("push unsubscribe", r.status_code == 200, r.text[:200])

# ---------------- 20. Health / diag / unknown route / static ----------------
r = api('GET', '/api/health')
log("health endpoint", r.status_code == 200 and r.json().get('ok') is True, r.text[:200])

r = api('GET', '/api/nonexistent-route-xyz')
log("unknown API route -> 404", r.status_code == 404, r.text[:200])

r = requests.get(BASE + "/")
log("static homepage loads", r.status_code == 200 and '<html' in r.text.lower(), f"status={r.status_code}")

r = api('GET', '/api/admin/anything')
log("admin panel removed / disabled", r.status_code == 404, r.text[:200])

# ---------------- Summary ----------------
print("\n" + "="*60)
total = len(results)
passed = sum(1 for _, ok, _ in results if ok)
print(f"TOTAL: {passed}/{total} passed")
failed = [(n, d) for n, ok, d in results if not ok]
if failed:
    print("\nFAILED TESTS:")
    for n, d in failed:
        print(f" - {n}: {d}")
else:
    print("ALL TESTS PASSED")

with open('test_results.json', 'w') as f:
    json.dump([{"name": n, "ok": ok, "detail": d} for n, ok, d in results], f, indent=2)
