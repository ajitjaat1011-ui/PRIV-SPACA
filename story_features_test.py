#!/usr/bin/env python3
"""E2E test for new free Story features: view analytics + reply-in-chat.
Runs against dev-server on :8787 (in-memory)."""
import json, random, string, sys, urllib.request, urllib.error

BASE = "http://localhost:8787"

def req(path, method="GET", token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def signup():
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    u, e = f"st_{s}", f"st_{s}@ex.com"
    st, b = req("/api/auth/signup", "POST", body={"username": u, "email": e, "displayName": u,
                "password": "pw123456", "pin": "7391", "termsAccepted": True, "termsVersion": 1})
    assert st == 200, f"signup {st} {b}"
    return b["token"], b["user"]["id"], u

fails = []
def check(name, ok, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + name + (f" -- {detail}" if detail else ""))
    if not ok: fails.append(name)

# Author A, viewers B and C
tokA, idA, unA = signup()
tokB, idB, unB = signup()
tokC, idC, unC = signup()

# A posts a story
st, b = req("/api/posts/create", "POST", token=tokA, body={
    "text": "my story", "story": True, "audience": "all"})
check("A creates story", st == 200 and b.get("post"), f"{st} {b}")
storyId = b["post"]["id"]

# B records a view
st, b = req(f"/api/stories/{storyId}/view", "POST", token=tokB)
check("B view recorded", st == 200 and b.get("viewCount") == 1, f"{st} {b}")
# B views again (idempotent)
st, b = req(f"/api/stories/{storyId}/view", "POST", token=tokB)
check("B re-view stays 1 (idempotent)", b.get("viewCount") == 1, str(b.get("viewCount")))
# C records a view
st, b = req(f"/api/stories/{storyId}/view", "POST", token=tokC)
check("C view -> count 2", b.get("viewCount") == 2, str(b.get("viewCount")))
# Author self-view ignored
st, b = req(f"/api/stories/{storyId}/view", "POST", token=tokA)
check("author self-view ignored (stays 2)", b.get("viewCount") == 2, str(b.get("viewCount")))

# Owner viewer list
st, b = req(f"/api/stories/{storyId}/viewers", token=tokA)
viewers = b.get("viewers", [])
check("owner sees 2 viewers", st == 200 and len(viewers) == 2, f"{st} {len(viewers)}")
ids = {v["id"] for v in viewers}
check("viewer list has B and C", ids == {idB, idC}, str(ids))

# Non-owner forbidden from viewer list
st, b = req(f"/api/stories/{storyId}/viewers", token=tokB)
check("non-owner viewer list -> 403", st == 403, str(st))

# Owner's /api/posts includes viewCount; others don't
st, b = req("/api/posts", token=tokA)
mine = next((p for p in b["posts"] if p["id"] == storyId), None)
check("owner /posts shows viewCount=2", mine and mine.get("viewCount") == 2, str(mine and mine.get("viewCount")))
st, b = req("/api/posts", token=tokB)
theirs = next((p for p in b["posts"] if p["id"] == storyId), None)
check("non-owner /posts hides views", theirs is not None and "views" not in theirs, str(theirs and list(theirs.keys())))

# --- Reply-in-chat ---
st, b = req(f"/api/stories/{storyId}/reply", "POST", token=tokB, body={"emoji": "🔥"})
check("B emoji reply -> 200", st == 200 and b.get("message"), f"{st} {b}")
check("reply message has storyReply ref", b.get("message", {}).get("storyReply", {}).get("id") == storyId)
roomId = b["message"]["roomId"]

# Author cannot reply to own story
st, b = req(f"/api/stories/{storyId}/reply", "POST", token=tokA, body={"emoji": "🔥"})
check("author reply to own story -> 400", st == 400, str(st))

# Empty reply rejected
st, b = req(f"/api/stories/{storyId}/reply", "POST", token=tokB, body={})
check("empty reply -> 400", st == 400, str(st))

# The reply lands in the A<->B DM room
st, b = req(f"/api/messages?roomId={roomId}", token=tokA)
msgs = b.get("messages", [])
has = any(m.get("storyReply", {}).get("id") == storyId and "🔥" in (m.get("text") or "") for m in msgs)
check("reply delivered to DM room", has, f"{len(msgs)} msgs")

print("\n=== SUMMARY ===")
if fails: print("FAILURES:", fails); sys.exit(1)
print("All story-feature checks passed.")
