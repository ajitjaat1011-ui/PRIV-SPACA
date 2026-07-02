#!/usr/bin/env python3
"""Backend test for video story support: upload accepts data:video/,
and a story created with videoUrl round-trips through /api/posts."""
import base64, json, random, string, sys, urllib.request, urllib.error

BASE = "http://localhost:8787"

def req(path, method="GET", token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def signup():
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    u, e = f"vs_{s}", f"vs_{s}@ex.com"
    st, b = req("/api/auth/signup", "POST", body={"username": u, "email": e, "displayName": u,
                "password": "pw123456", "pin": "7391", "termsAccepted": True, "termsVersion": 1})
    assert st == 200, f"signup {st} {b}"
    return b["token"], b["user"]["id"]

fails = []
def check(name, ok, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + name + (f" -- {detail}" if detail else ""))
    if not ok: fails.append(name)

tok, uid = signup()

# A tiny fake webm payload (content doesn't need to be a real video for the
# API contract test — we only verify the data:video/ path is accepted).
fake = base64.b64encode(b"\x1aE\xdf\xa3fakewebmdata" * 20).decode()
video_data_url = "data:video/webm;base64," + fake

st, b = req("/api/upload-photo", "POST", token=tok, body={"dataUrl": video_data_url, "kind": "post"})
check("upload accepts data:video/webm", st == 200 and b.get("url"), f"{st} {b}")
video_url = b.get("url")

# Reject an oversize video (> 10MB).
big = "data:video/mp4;base64," + base64.b64encode(b"x" * (11 * 1024 * 1024)).decode()
st, b = req("/api/upload-photo", "POST", token=tok, body={"dataUrl": big, "kind": "post"})
check("oversize video rejected (413)", st == 413, str(st))

# Reject an unknown video subtype.
st, b = req("/api/upload-photo", "POST", token=tok, body={"dataUrl": "data:video/avi;base64," + fake, "kind": "post"})
check("unknown video subtype rejected (400)", st == 400, str(st))

# Create a video story.
st, b = req("/api/posts/create", "POST", token=tok, body={"videoUrl": video_url, "story": True, "audience": "all"})
check("video story created", st == 200 and b.get("post"), f"{st} {b}")
check("post has videoUrl", b.get("post", {}).get("videoUrl") == video_url, str(b.get("post", {}).get("videoUrl")))
pid = b["post"]["id"]

# It shows up in /api/posts with videoUrl.
st, b = req("/api/posts", token=tok)
p = next((x for x in b["posts"] if x["id"] == pid), None)
check("video story in feed with videoUrl", p and p.get("videoUrl") == video_url, str(p and p.get("videoUrl")))

# A non-URL videoUrl is rejected/stripped (empty post if only that).
st, b = req("/api/posts/create", "POST", token=tok, body={"videoUrl": "javascript:alert(1)", "story": True})
check("malicious videoUrl -> empty post rejected", st == 400, str(st))

print("\n=== SUMMARY ===")
if fails: print("FAILURES:", fails); sys.exit(1)
print("All video-story API checks passed.")
