#!/usr/bin/env python3
"""End-to-end check for GET/POST /api/rtc/signals parity (index.js).
Two users register; A sends a WebRTC offer targeted at B; B polls
/api/rtc/signals and must receive it. Then A sends 'end' and B must
see the pending signals cleared. Run against dev-server on :8787."""
import json, random, string, sys, urllib.request

BASE = "http://localhost:8787"

def req(path, method="GET", token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def rnd():
    s = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"rtc_{s}", f"rtc_{s}@ex.com"

def signup():
    u, e = rnd()
    st, body = req("/api/auth/signup", "POST",
                   body={"username": u, "email": e, "displayName": u,
                         "password": "pw123456", "pin": "7391",
                         "termsAccepted": True, "termsVersion": 1})
    assert st == 200, f"signup failed {st} {body}"
    return body["token"], body["user"]["id"]

fails = []
def check(name, ok, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + name + (f" -- {detail}" if detail else ""))
    if not ok: fails.append(name)

tokA, idA = signup()
tokB, idB = signup()

# B polls first (baseline empty)
st, body = req(f"/api/rtc/signals?since=0", token=tokB)
check("GET /api/rtc/signals returns 200", st == 200, str(st))
check("baseline signals empty", body.get("signals") == [], str(body.get("signals")))
server_now = body.get("now", 0)
check("response includes server 'now'", isinstance(server_now, int) and server_now > 0)

# A sends an offer to B
st, body = req("/api/rtc/signal", "POST", token=tokA,
               body={"targetId": idB, "signal": {"type": "offer", "sdp": "v=0-fake"}})
check("POST offer accepted", st == 200 and body.get("ok") is True, f"{st} {body}")

# B polls and should get the offer
st, body = req("/api/rtc/signals?since=0", token=tokB)
sigs = body.get("signals", [])
check("B receives 1 signal", len(sigs) == 1, str(len(sigs)))
if sigs:
    s0 = sigs[0]
    check("signal fromId == A", s0.get("fromId") == idA, str(s0.get("fromId")))
    check("signal type == offer", s0.get("signal", {}).get("type") == "offer")
    check("author snapshot present", bool(s0.get("author")))

# A does NOT receive their own signal
st, body = req("/api/rtc/signals?since=0", token=tokA)
check("A does not receive own signal", body.get("signals") == [], str(body.get("signals")))

# A sends 'end' -> clears pending pair signals
st, body = req("/api/rtc/signal", "POST", token=tokA,
               body={"targetId": idB, "signal": {"type": "end"}})
check("POST end accepted", st == 200)
# B polls since=0: the offer should be gone, only the 'end' remains (end targets B)
st, body = req("/api/rtc/signals?since=0", token=tokB)
sigs = body.get("signals", [])
types = [s.get("signal", {}).get("type") for s in sigs]
check("offer cleared after end", "offer" not in types, str(types))

print("\n=== SUMMARY ===")
if fails:
    print("FAILURES:", fails); sys.exit(1)
print("All RTC parity checks passed.")
