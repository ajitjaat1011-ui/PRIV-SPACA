/**
 * PRIV SPACA — React auth UI (Glass One UI).
 * Bundled to /auth.react.min.js by: npm run build:auth
 * (esbuild --bundle --minify). Mounted by app.js when the auth shell shows;
 * hands a successful session back via window.__psAcceptSession (app.js).
 *
 * Wordmark-only by design: no logo mark on the auth screens.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const APP_VERSION = (typeof window !== 'undefined' && window.__PS_APP_VERSION) || '';

/* ============================== tiny API client (mirrors app.js api()) ============================== */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (APP_VERSION) headers['X-App-Version'] = APP_VERSION;
  const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || 'Something went wrong. Please try again.';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}
function acceptSessionHook(data) {
  if (window.__psAcceptSession) { window.__psAcceptSession(data); return true; }
  // Fallback if app.js hook missing (edge): persist + reload so vanilla boot takes over.
  try {
    localStorage.setItem('ps_token', data.token || '');
    localStorage.setItem('ps_user', JSON.stringify(data.user || {}));
  } catch (_) {}
  location.reload();
  return true;
}
function openTermsModal() {
  const m = document.getElementById('termsModal');
  if (m) { m.classList.remove('hidden'); try { window.scrollTo({ top: 0 }); } catch (_) {} }
}

/* ============================== icons (inline, no deps) ============================== */
const I = {
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c1.4-3.4 4.2-5 7.5-5s6.1 1.6 7.5 5" /></svg>,
  at: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3.2" /><path d="M15.6 12v-2.4a1.7 1.7 0 0 1 3.1.9V12a6.7 6.7 0 1 1-2.4-5.2" /></svg>,
  mail: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="3" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="3" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" /></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.6" /></svg>,
  pin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 3 8.5 21M15.5 3 14 21M4 8.5h17M3 15.5h17" /></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18 9 12l6-6" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="10" width="16" height="10" rx="3" /><path d="M8 10V7.8a4 4 0 0 1 8 0V10" /></svg>,
};
const WORDMARK = 'PRIV SPACA';

/* ============================== small primitives ============================== */
function Row({ icon, cap, children, right }) {
  return (
    <div className="psa-row">
      <span className="psa-ric">{icon}</span>
      <div className="psa-fcol">
        {cap ? <span className="psa-cap">{cap}</span> : null}
        {children}
      </div>
      {right || null}
    </div>
  );
}
function EyeToggle({ on, set }) {
  return (
    <button type="button" className="psa-gact" aria-label={on ? 'Hide password' : 'Show password'}
      onMouseDown={(e) => e.preventDefault()} onClick={() => set(!on)}>{I.eye}</button>
  );
}
function strengthOf(pw) {
  if (!pw) return { w: 0, label: '' };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  s = Math.min(5, Math.round((s / 5) * 5));
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  return { w: Math.max(s, pw.length ? 1 : 0) * 20, label: labels[s] };
}
function PinField({ value, onChange }) {
  const refs = [useRef(null), useRef(null), useRef(null), useRef(null)];
  const setDigit = (i, ch) => {
    if (!/^\d$/.test(ch)) return;
    const next = value.slice(0, i) + ch + value.slice(i + 1);
    onChange(next.slice(0, 4));
    if (i < 3 && ch) refs[i + 1].current && refs[i + 1].current.focus();
  };
  const onKey = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value[i]) onChange(value.slice(0, i) + value.slice(i + 1));
      else if (i > 0) { refs[i - 1].current && refs[i - 1].current.focus(); onChange(value.slice(0, i - 1)); }
    }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setDigit(i, e.key); }
  };
  const onPaste = (e) => {
    e.preventDefault();
    const txt = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
    if (txt) onChange(txt);
    refs[Math.min(txt.length, 3)].current && refs[Math.min(txt.length, 3)].current.focus();
  };
  return (
    <div className="psa-pinrow" onPaste={onPaste}>
      {[0, 1, 2, 3].map((i) => (
        <input key={i} ref={refs[i]} className="psa-pin" inputMode="numeric" autoComplete="off" maxLength={1}
          value={value[i] || ''} aria-label={'PIN digit ' + (i + 1)}
          onChange={(e) => setDigit(i, e.target.value.replace(/\D/g, '').slice(-1))}
          onKeyDown={(e) => onKey(i, e)} onFocus={(e) => e.target.select()} />
      ))}
    </div>
  );
}
function ErrorBox({ msg, tone }) {
  if (!msg) return null;
  return <div className={'psa-err' + (tone === 'ok' ? ' ok' : '')} role="alert">{msg}</div>;
}
function SubmitBtn({ busy, children }) {
  return (
    <button type="submit" className="psa-cta" disabled={busy}>
      {busy ? <><span className="psa-spin" aria-hidden="true"></span> {children}</> : children}
    </button>
  );
}
/* Generic labelled input row */
function TextRow({ icon, cap, type = 'text', placeholder, value, onChange, autoFocus, name }) {
  const [show, setShow] = useState(false);
  const isPw = type === 'password';
  return (
    <Row icon={icon} cap={cap}
      right={isPw ? <EyeToggle on={show} set={setShow} /> : null}>
      <input name={name} className="psa-gin" type={isPw ? (show ? 'text' : 'password') : type}
        placeholder={placeholder} value={value} autoFocus={autoFocus}
        autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </Row>
  );
}

/* ============================== panels ============================== */
function LoginPanel({ onSwitch, identifier, setIdentifier, password, setPassword }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (!identifier.trim() || !password) { setErr('Enter your username / email and password.'); return; }
    setBusy(true);
    try {
      const data = await api('/auth/login', { method: 'POST', body: { identifier: identifier.trim(), password } });
      acceptSessionHook(data);
    } catch (ex) { setErr(ex.message || 'Login failed. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextRow icon={I.user} cap="Username · Email · Mobile" placeholder="e.g. @you or you@mail.com"
        value={identifier} onChange={setIdentifier} autoFocus name="identifier" />
      <div className="psa-sep" />
      <TextRow icon={I.lock} cap="Password" type="password" placeholder="••••••••" value={password} onChange={setPassword} name="password" />
      <div className="psa-rowx">
        <button type="button" className="psa-link" onClick={() => onSwitch('reset')}>Forgot password?</button>
      </div>
      <ErrorBox msg={err} />
      <SubmitBtn busy={busy}>Log in</SubmitBtn>
      <p className="psa-trust"><span className="psa-shield">{I.shield}</span>End-to-end encrypted · private by design</p>
    </form>
  );
}

function SignupPanel({ onSwitch, onDone }) {
  const [f, setF] = useState({ displayName: '', username: '', email: '', password: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [terms, setTerms] = useState(true);
  const meter = strengthOf(f.password);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (!f.displayName.trim() || !f.username.trim() || !f.email.trim() || !f.password) {
      setErr('Please fill in every field to create your account.'); return;
    }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(f.username.trim())) {
      setErr('Username must be 3–24 characters (letters, numbers, underscore).'); return;
    }
    if (!/^\d{4}$/.test(f.pin)) { setErr('Set your 4-digit recovery PIN.'); return; }
    if (!terms) { setErr('You must accept the Terms & Community Guidelines to create an account.'); return; }
    setBusy(true);
    try {
      const data = await api('/auth/signup', { method: 'POST', body: {
        email: f.email.trim(), username: f.username.trim(), displayName: f.displayName.trim(),
        password: f.password, pin: f.pin, termsAccepted: true, termsVersion: '1.0',
      } });
      acceptSessionHook(data); // auto sign-in (same as current app behaviour)
      if (onDone) onDone();
    } catch (ex) { setErr(ex.message || 'Signup failed. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <div className="psa-twocol">
        <Row icon={I.user} cap="Display name"><input className="psa-gin" placeholder="Your name" value={f.displayName} onChange={(e) => set('displayName')(e.target.value)} name="displayName" /></Row>
        <Row icon={I.at} cap="Username"><input className="psa-gin" placeholder="@you" value={f.username} onChange={(e) => set('username')(e.target.value)} name="username" /></Row>
      </div>
      <div className="psa-sep" />
      <TextRow icon={I.mail} cap="Email" type="email" placeholder="you@mail.com" value={f.email} onChange={set('email')} name="email" />
      <div className="psa-sep" />
      <TextRow icon={I.lock} cap="Password" type="password" placeholder="••••••••" value={f.password} onChange={set('password')} name="password" />
      <div className="psa-mtr"><span className={'psa-mbar' + (f.password ? '' : ' empty')} style={{ width: meter.w + '%' }}></span><span className="psa-mlabel">{meter.label || ''}</span></div>
      <div className="psa-sep" />
      <Row icon={I.pin} cap="Recovery PIN · 4 digits"
        right={null}><span className="psa-pinhint">Needed to recover your account</span></Row>
      <PinField value={f.pin} onChange={set('pin')} />
      <label className="psa-terms"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /><span>I agree to the <button type="button" className="psa-link-inline" onClick={openTermsModal}>Terms &amp; Community Guidelines</button>.</span></label>
      <ErrorBox msg={err} />
      <SubmitBtn busy={busy}>Create my account</SubmitBtn>
      <p className="psa-trust"><span className="psa-shield">{I.shield}</span>Your PIN is hashed — never stored in plain text</p>
    </form>
  );
}

function ResetPanel({ onSwitch }) {
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setMsg('');
    if (!identifier.trim()) { setErr('Enter your username, email or mobile number.'); return; }
    if (!/^\d{4}$/.test(pin)) { setErr('Enter your 4-digit security PIN.'); return; }
    if (pw.length < 6) { setErr('New password must be at least 6 characters.'); return; }
    setBusy(true);
    try {
      const data = await api('/auth/reset-by-pin', { method: 'POST', body: { identifier: identifier.trim(), pin, newPassword: pw } });
      if (data && data.token && data.user) { acceptSessionHook(data); }
      else {
        setMsg('Password reset! Please sign in.');
        setTimeout(() => onSwitch('login', identifier.trim()), 1100);
      }
    } catch (ex) { setErr(ex.message || 'Reset failed. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextRow icon={I.user} cap="Username · Email · Mobile" placeholder="e.g. @you or you@mail.com"
        value={identifier} onChange={setIdentifier} autoFocus name="identifier" />
      <div className="psa-sep" />
      <Row icon={I.pin} cap="4-digit security PIN" />
      <PinField value={pin} onChange={setPin} />
      <div className="psa-sep" />
      <TextRow icon={I.lock} cap="New password" type="password" placeholder="••••••••" value={pw} onChange={setPw} name="newPassword" />
      <ErrorBox msg={err} tone="bad" />
      <ErrorBox msg={msg} tone="ok" />
      <SubmitBtn busy={busy}>Reset password</SubmitBtn>
      <button type="button" className="psa-link" style={{ width: '100%', textAlign: 'center', marginTop: -4 }} onClick={() => onSwitch('login')}>Back to log in</button>
    </form>
  );
}

/* ============================== page ============================== */
const META = {
  login: { title: 'Welcome back.', sub: <>Your circle missed you.</>, word: 'PRIV SPACA' },
  signup: { title: 'Create your space.', sub: <>Stories, notes &amp; chats — for the people you choose.</>, word: 'PRIV SPACA' },
  reset: { title: 'Trouble logging in?', sub: <>Enter your details + your 4-digit PIN.</>, word: 'PRIV SPACA' },
};
function AuthApp() {
  const [mode, setMode] = useState('login');
  const [loginId, setLoginId] = useState('');
  const [pw, setPw] = useState('');
  const showBack = mode !== 'login';
  const meta = META[mode];
  const switchMode = (m, prefillId) => {
    setMode(m);
    if (prefillId) setLoginId(prefillId);
    try { window.scrollTo({ top: 0 }); } catch (_) {}
  };
  useEffect(() => {
    // restore draft identifier when user lands back on login
    try {
      const saved = sessionStorage.getItem('psa_identifier');
      if (saved) { setLoginId(saved); sessionStorage.removeItem('psa_identifier'); }
    } catch (_) {}
  }, [mode]);
  return (
    <div className="psa">
      <div className="psa-bg" aria-hidden="true">
        <i className="psa-b p1"></i><i className="psa-b p2"></i><i className="psa-b p3"></i><i className="psa-b p4"></i>
      </div>
      <div className="psa-fcol">
        {showBack ? (
          <div className="psa-top">
            <button type="button" className="psa-back" aria-label="Go back" onClick={() => switchMode('login')}>{I.back}</button>
          </div>
        ) : <div className="psa-top psa-top-empty" />}
        <header className="psa-brand">
          <div className="psa-word">{meta.word}</div>
          <h1 className="psa-title">{meta.title}</h1>
          <p className="psa-sub">{meta.sub}</p>
        </header>
        <div className="psa-card">
          {mode === 'login' && (
            <LoginPanel onSwitch={(m) => switchMode(m)} identifier={loginId} setIdentifier={setLoginId}
              password={pw} setPassword={setPw} />
          )}
          {mode === 'signup' && <SignupPanel onSwitch={(m) => switchMode(m)} />}
          {mode === 'reset' && <ResetPanel onSwitch={(m, id) => switchMode(m, id)} />}
        </div>
        <div className="psa-dock">
          {mode === 'login' && (<span className="psa-dock-txt">New here?<button type="button" className="psa-dock-btn" onClick={() => switchMode('signup')}>Create new account</button></span>)}
          {mode === 'signup' && (<span className="psa-dock-txt">Already a member?<button type="button" className="psa-dock-btn" onClick={() => switchMode('login')}>Log in</button></span>)}
          {mode === 'reset' && (<button type="button" className="psa-dock-btn" onClick={() => switchMode('login')}>Back to log in</button>)}
        </div>
        <p className="psa-foot">© {new Date().getFullYear()} PRIV SPACA</p>
      </div>
    </div>
  );
}

/* ============================== mount/unmount API for app.js ============================== */
let _root = null;
let _mountEl = null;
export function mount(el) {
  if (!el) return;
  if (_root && _mountEl === el) return; // already mounted here
  unmount();
  _mountEl = el;
  _root = createRoot(el);
  _root.render(<AuthApp />);
}
export function unmount() {
  if (_root) { try { _root.unmount(); } catch (_) {} _root = null; _mountEl = null; }
}
if (typeof window !== 'undefined') {
  window.__PSAuthReact = { mount, unmount, version: '1.0' };
}
