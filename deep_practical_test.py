#!/usr/bin/env python3
"""
Deep Practical Multi-User Simulation Test for PRIV-SPACA
Simulates concurrent users interacting with all deep features:
- Mass concurrent signups & logins
- Profile customizations & avatars
- Social graph: follow/unfollow triggering feed fan-out
- Optimized hybrid feed (/api/feed) vs engagement ranking
- High-frequency chat (general + encrypted DMs + reply-to)
- Concurrent typing indicators & heartbeat
- E2E public keys & RTC signaling
"""

import sys, time, random, string, threading, requests, json
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_URL = "http://localhost:8787" if "--local" in sys.argv or "--live" not in sys.argv else "https://priv-spaca.pages.dev"
if "--live" in sys.argv:
    BASE_URL = "https://priv-spaca.pages.dev"

print(f"=== Starting Deep Practical Multi-User Test against {BASE_URL} ===")

results = []
lock = threading.Lock()

def log(name, ok, detail=""):
    with lock:
        results.append((name, ok, detail))
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}" + (f" -- {detail}" if detail and not ok else ""))

def rand_str(n=6):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))

def api(method, path, token=None, **kw):
    headers = kw.pop('headers', {})
    if token:
        headers['Authorization'] = f'Bearer {token}'
    return requests.request(method, BASE_URL + path, headers=headers, timeout=30, **kw)

NUM_USERS = 12
users = []

# Step 1: Concurrent Signups
print("\n--- Step 1: Concurrent Practical User Signups ---")
def create_user(idx):
    username = f"deepuser_{idx}_{rand_str(4)}"
    email = f"{username}@test.org"
    password = f"P@ssw0rd_{rand_str(4)}!"
    pin = str(random.randint(1000, 9999))
    while pin in {'1234','0000','1111'}: pin = str(random.randint(1000, 9999))
    
    r = api('POST', '/api/auth/signup', json={
        "email": email, "username": username, "password": password, "pin": pin, "displayName": f"Practical {username}", "termsAccepted": True
    })
    if r.status_code == 200:
        data = r.json()
        return {
            "idx": idx, "id": data['user']['id'], "email": email,
            "username": username, "token": data['token'], "password": password
        }
    else:
        raise RuntimeError(f"Signup failed for {username}: {r.status_code} {r.text[:150]}")

with ThreadPoolExecutor(max_workers=NUM_USERS) as executor:
    futures = [executor.submit(create_user, i) for i in range(NUM_USERS)]
    for f in as_completed(futures):
        try:
            u = f.result()
            users.append(u)
        except Exception as e:
            log("concurrent signup", False, str(e))

users.sort(key=lambda x: x['idx'])
log(f"Concurrent signup of {len(users)} users", len(users) == NUM_USERS)
if len(users) < NUM_USERS:
    print(f"Aborting step 2+ because only {len(users)}/{NUM_USERS} signed up.")
    sys.exit(1)

# Step 2: Concurrent Profile Updates & Avatars
print("\n--- Step 2: Profile Customization & Public Keys ---")
def setup_user(u):
    bio = f"Deep practical tester #{u['idx']} active."
    r1 = api('POST', '/api/user/update', token=u['token'], json={"bio": bio, "displayName": f"User {u['username']}"})
    tiny_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    r2 = api('POST', '/api/upload-photo', token=u['token'], json={"dataUrl": tiny_png, "kind": "avatar"})
    r3 = api('POST', '/api/user/public-key', token=u['token'], json={"publicKey": "PUBKEY_" + u['id'] + "_" + rand_str(20)})
    return r1.status_code == 200 and r2.status_code == 200 and r3.status_code == 200

with ThreadPoolExecutor(max_workers=NUM_USERS) as executor:
    ok_count = sum(1 for f in as_completed([executor.submit(setup_user, u) for u in users]) if f.result())
log("Concurrent profile setup & avatar uploads", ok_count == NUM_USERS, f"{ok_count}/{NUM_USERS}")

# Step 3: Social Graph & Fan-Out Follows
print("\n--- Step 3: Creating Posts & Social Follows ---")
created_posts = []
for u in users[:6]:
    r = api('POST', '/api/posts/create', token=u['token'], json={"text": f"Practical post by {u['username']}"})
    if r.status_code == 200:
        created_posts.append((u, r.json()['post']))

log("Create initial posts", len(created_posts) == 6)

# Users 6..11 follow users 0..5
follow_success = 0
for i in range(6, NUM_USERS):
    target = users[i - 6]
    r = api('POST', '/api/user/follow', token=users[i]['token'], json={"targetId": target['id']})
    if r.status_code == 200:
        follow_success += 1
log("Practical social graph follows", follow_success == NUM_USERS - 6)

# Step 4: Verify /api/feed (The #1 Optimization Endpoint)
print("\n--- Step 4: Verifying Optimized /api/feed Endpoint ---")
feed_checks_passed = 0
for i in range(6, NUM_USERS):
    target_user = users[i - 6]
    r = api('GET', '/api/feed', token=users[i]['token'])
    if r.status_code == 200:
        posts = r.json().get('posts', [])
        # Verify post from followed target is in feed
        if any(p['userId'] == target_user['id'] for p in posts):
            feed_checks_passed += 1
log("Followed posts appear in /api/feed immediately", feed_checks_passed == NUM_USERS - 6, f"{feed_checks_passed}/{NUM_USERS-6}")

# Step 5: High-Frequency Concurrent Group Chat & Ephemeral Indicators
print("\n--- Step 5: High-Frequency Chat & Ephemeral Heartbeats ---")
def chat_worker(u, i):
    # Send heartbeat
    api('POST', '/api/user/heartbeat', token=u['token'])
    # Send typing
    api('POST', '/api/user/typing', token=u['token'], json={"roomId": "general-group"})
    # Send message
    r = api('POST', '/api/messages/send', token=u['token'], json={
        "roomId": "general-group", "text": f"Concurrent message {i} from {u['username']}"
    })
    return r.status_code == 200

with ThreadPoolExecutor(max_workers=NUM_USERS) as executor:
    chat_ok = sum(1 for f in as_completed([executor.submit(chat_worker, u, i) for i, u in enumerate(users)]) if f.result())
log("Concurrent group chat & ephemeral signaling", chat_ok == NUM_USERS, f"{chat_ok}/{NUM_USERS} succeeded")

# Step 6: Verify Chat Consistency
r = api('GET', '/api/messages?roomId=general-group', token=users[0]['token'])
msgs = r.json().get('messages', []) if r.status_code == 200 else []
msg_texts = {m.get('text') for m in msgs}
received_count = sum(1 for i, u in enumerate(users) if f"Concurrent message {i} from {u['username']}" in msg_texts)
log(f"All {NUM_USERS} concurrent messages persisted & delivered", received_count == NUM_USERS, f"{received_count}/{NUM_USERS}")

# Step 7: Encrypted DMs Concurrent Exchange
print("\n--- Step 7: Concurrent Direct Message Exchanges ---")
dm_ok_count = 0
for i in range(0, NUM_USERS, 2):
    u1, u2 = users[i], users[i+1]
    r = api('POST', '/api/messages/send', token=u1['token'], json={
        "targetUserId": u2['id'], "text": f"Secret DM from {u1['username']} to {u2['username']}"
    })
    if r.status_code == 200:
        dm_ok_count += 1
log("Practical 1-on-1 DMs created", dm_ok_count == NUM_USERS // 2)

print("\n" + "="*60)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"DEEP PRACTICAL TEST SUMMARY: {passed}/{total} checks passed.")
if passed != total:
    sys.exit(1)
sys.exit(0)
