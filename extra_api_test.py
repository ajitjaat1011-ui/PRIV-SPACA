#!/usr/bin/env python3
import json, random, string, threading, time
from queue import Queue, Empty
import requests

BASE = "https://priv-spaca.pages.dev"
results = []
created_users = []


def log(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail and not ok else ""))


def rand_str(n=6):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def api(method, path, token=None, **kw):
    headers = kw.pop('headers', {})
    if token:
        headers['Authorization'] = f'Bearer {token}'
    return requests.request(method, BASE + path, headers=headers, timeout=45, **kw)


def signup(prefix="arena"):
    suffix = rand_str(6)
    username = f"{prefix}_{suffix}"
    email = f"{username}@example.com"
    pin = str(random.randint(1000, 9999))
    weak = {
        '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
        '1234','4321','0123','2580','1212','1313','1010','0101','1122','1221',
        '2024','2025','2026','2027','0007','1357','2468','9876','6789'
    }
    while pin in weak:
        pin = str(random.randint(1000, 9999))
    r = api('POST', '/api/auth/signup', json={
        'email': email,
        'username': username,
        'displayName': f'API {prefix} {suffix}',
        'password': 'TestPass123!',
        'pin': pin,
        'termsAccepted': True,
    })
    if r.status_code != 200:
        raise RuntimeError(f"signup failed for {username}: {r.status_code} {r.text[:300]}")
    data = r.json()
    u = {
        'id': data['user']['id'],
        'username': username,
        'email': email,
        'pin': pin,
        'password': 'TestPass123!',
        'token': data['token'],
    }
    created_users.append(u)
    return u


class StreamListener(threading.Thread):
    def __init__(self, token):
        super().__init__(daemon=True)
        self.token = token
        self.events = Queue()
        self.errors = Queue()
        self._stop = threading.Event()

    def run(self):
        try:
            with requests.get(BASE + '/api/stream', params={'token': self.token}, stream=True, timeout=35) as r:
                if r.status_code != 200:
                    self.errors.put((r.status_code, r.text[:300]))
                    return
                current_event = None
                current_data = []
                for raw in r.iter_lines(decode_unicode=True):
                    if self._stop.is_set():
                        return
                    if raw is None:
                        continue
                    line = raw.strip('\r')
                    if line.startswith(':'):
                        continue
                    if line == '':
                        if current_event or current_data:
                            data = '\n'.join(current_data) if current_data else ''
                            try:
                                parsed = json.loads(data) if data else {}
                            except Exception:
                                parsed = {'raw': data}
                            self.events.put({'event': current_event or 'message', 'data': parsed})
                        current_event = None
                        current_data = []
                        continue
                    if line.startswith('event:'):
                        current_event = line.split(':', 1)[1].strip()
                    elif line.startswith('data:'):
                        current_data.append(line.split(':', 1)[1].strip())
        except Exception as e:
            self.errors.put(('exception', str(e)))

    def stop(self):
        self._stop.set()

    def wait_for(self, event_name, predicate=None, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                err = self.errors.get_nowait()
                raise RuntimeError(f"stream error: {err}")
            except Empty:
                pass
            try:
                evt = self.events.get(timeout=0.5)
            except Empty:
                continue
            if evt['event'] != event_name:
                continue
            if predicate is None or predicate(evt['data']):
                return evt
        return None


def main():
    # create 2 fresh accounts for extra feature coverage
    u1 = signup('arena')
    u2 = signup('arena')
    log('extra signup user 1', True, u1['username'])
    log('extra signup user 2', True, u2['username'])

    # 1) Reply-to in group chat
    base_token = 'reply-base-' + rand_str(5)
    reply_token = 'reply-child-' + rand_str(5)
    r = api('POST', '/api/messages/send', token=u1['token'], json={
        'roomId': 'general-group', 'text': base_token
    })
    ok = r.status_code == 200
    log('send base group message for reply', ok, r.text[:200])
    if not ok:
        raise RuntimeError('base message failed')
    base_msg = r.json()['message']
    r = api('POST', '/api/messages/send', token=u2['token'], json={
        'roomId': 'general-group',
        'text': reply_token,
        'replyTo': {
            'id': base_msg['id'],
            'text': base_msg['text'],
            'username': u1['username'],
            'imageUrl': None,
        }
    })
    ok = r.status_code == 200
    log('send reply message', ok, r.text[:200])
    r = api('GET', '/api/messages?roomId=general-group', token=u1['token'])
    msgs = r.json().get('messages', []) if r.status_code == 200 else []
    reply_found = None
    for m in reversed(msgs):
        if m.get('text') == reply_token:
            reply_found = m
            break
    ok = bool(reply_found and reply_found.get('replyTo', {}).get('id') == base_msg['id'])
    log('reply reference preserved on fetch', ok, json.dumps(reply_found or {})[:300])

    # 2) Disappearing message
    disappear_token = 'vanish-' + rand_str(5)
    r = api('POST', '/api/messages/send', token=u1['token'], json={
        'roomId': 'general-group', 'text': disappear_token, 'disappearAfterMs': 10000
    })
    ok = r.status_code == 200
    log('send disappearing message', ok, r.text[:200])
    r = api('GET', '/api/messages?roomId=general-group', token=u1['token'])
    immediate = any(m.get('text') == disappear_token for m in r.json().get('messages', [])) if r.status_code == 200 else False
    log('disappearing message visible immediately', immediate, r.text[:200])
    time.sleep(12)
    r = api('GET', '/api/messages?roomId=general-group', token=u1['token'])
    gone = not any(m.get('text') == disappear_token for m in r.json().get('messages', [])) if r.status_code == 200 else False
    log('disappearing message hidden after TTL', gone, r.text[:200])

    # 3) Encrypted DMs
    enc_cipher = 'cipher-' + rand_str(12)
    enc_iv = 'iv-' + rand_str(8)
    r = api('POST', '/api/messages/send', token=u1['token'], json={
        'targetUserId': u2['id'],
        'encrypted': True,
        'cipher': enc_cipher,
        'iv': enc_iv,
    })
    ok = r.status_code == 200
    log('send encrypted DM', ok, r.text[:200])
    dm_room = r.json()['message']['roomId'] if ok else None
    r = api('GET', f'/api/messages?roomId={dm_room}', token=u2['token'])
    dm_msgs = r.json().get('messages', []) if r.status_code == 200 else []
    enc_msg = None
    for m in reversed(dm_msgs):
        if m.get('encrypted') and m.get('cipher') == enc_cipher:
            enc_msg = m
            break
    log('recipient fetch sees encrypted payload', bool(enc_msg and enc_msg.get('iv') == enc_iv and (enc_msg.get('text') or '') == ''), json.dumps(enc_msg or {})[:300])

    r = api('POST', '/api/messages/send', token=u1['token'], json={
        'roomId': 'general-group',
        'encrypted': True,
        'cipher': 'x',
        'iv': 'y',
    })
    log('reject encrypted group message', r.status_code == 400, r.text[:200])

    # 4) Scheduled message auto-delivery
    sched_token = 'scheduled-' + rand_str(5)
    deliver_at = int((time.time() + 7) * 1000)
    r = api('POST', '/api/messages/schedule', token=u1['token'], json={
        'roomId': 'general-group', 'text': sched_token, 'deliverAt': deliver_at
    })
    ok = r.status_code == 200
    log('schedule near-future message', ok, r.text[:200])
    time.sleep(9)
    r = api('GET', '/api/messages?roomId=general-group', token=u1['token'])
    msgs = r.json().get('messages', []) if r.status_code == 200 else []
    delivered = any(m.get('text') == sched_token and m.get('scheduledOriginally') for m in msgs)
    log('scheduled message auto-delivered', delivered, r.text[:200])

    # 5) SSE stream for new DMs
    listener = StreamListener(u2['token'])
    listener.start()
    time.sleep(1.5)
    sse_token = 'sse-dm-' + rand_str(6)
    r = api('POST', '/api/messages/send', token=u1['token'], json={
        'targetUserId': u2['id'], 'text': sse_token
    })
    ok = r.status_code == 200
    log('send DM while SSE connected', ok, r.text[:200])
    evt = listener.wait_for('new_message', predicate=lambda d: d.get('data', {}).get('message', {}).get('text') == sse_token or d.get('message', {}).get('text') == sse_token, timeout=18)
    # server wraps payload differently depending on runtime; normalize for both
    if evt and 'data' in evt and isinstance(evt['data'], dict) and 'message' not in evt['data'] and 'data' in evt['data']:
        payload = evt['data']['data']
    else:
        payload = evt['data'] if evt else None
    got_sse = bool(payload and payload.get('message', {}).get('text') == sse_token)
    log('SSE delivers new_message event to DM recipient', got_sse, json.dumps(payload or {})[:300])
    listener.stop()
    time.sleep(0.5)

    # persist created usernames for cleanup tooling/reporting
    with open('extra_created_users.json', 'w') as f:
        json.dump(created_users, f, indent=2)

    print('\n' + '='*60)
    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f'TOTAL: {passed}/{total} passed')
    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print('FAILED TESTS:')
        for n, d in failed:
            print(' -', n, d)


if __name__ == '__main__':
    main()
