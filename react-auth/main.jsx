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

function correlationId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/* ============================== tiny API client (mirrors app.js api()) ============================== */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Correlation-ID': correlationId() };
  // app.js publishes its version before lazy-loading this bundle; read it per
  // request so retries and future mount paths always use the active version.
  const appVersion = (typeof window !== 'undefined' && window.__PS_APP_VERSION) || '';
  if (appVersion) headers['X-App-Version'] = appVersion;
  const res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
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
  // Fallback if app.js hook is not ready: persist only a non-secret session
  // hint. The actual credential remains in the Secure HttpOnly cookie.
  try {
    localStorage.removeItem('ps_token');
    localStorage.setItem('ps_session_hint', '1');
    const user = { ...(data.user || {}) }; delete user.email; delete user.dateOfBirth;
    localStorage.setItem('ps_user', JSON.stringify(user));
  } catch (_) {}
  location.reload();
  return true;
}
function webAuthnDecode(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(text + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
function webAuthnEncode(value) {
  let binary = '';
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function assertionJSON(credential) {
  return {
    id: credential.id, rawId: webAuthnEncode(credential.rawId), type: credential.type,
    response: {
      clientDataJSON: webAuthnEncode(credential.response.clientDataJSON),
      authenticatorData: webAuthnEncode(credential.response.authenticatorData),
      signature: webAuthnEncode(credential.response.signature),
      userHandle: credential.response.userHandle ? webAuthnEncode(credential.response.userHandle) : null,
    },
  };
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
      <span className="psa-ric" aria-hidden="true">{icon}</span>
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
    <button type="submit" className="psa-cta" disabled={busy} aria-busy={busy}>
      {busy ? <><span className="psa-spin" aria-hidden="true"></span> {children}</> : children}
    </button>
  );
}
/* Generic labelled input row */
function TextRow({ icon, cap, type = 'text', placeholder, value, onChange, autoFocus, name, autoComplete = 'off' }) {
  const [show, setShow] = useState(false);
  const isPw = type === 'password';
  return (
    <Row icon={icon} cap={cap}
      right={isPw ? <EyeToggle on={show} set={setShow} /> : null}>
      <input name={name} className="psa-gin" type={isPw ? (show ? 'text' : 'password') : type}
        aria-label={cap} placeholder={placeholder} value={value} autoFocus={autoFocus}
        autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />
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
      // Check if server requires passkey/biometric verification (2FA)
      if (data && data.challenge) {
        setErr('Verifying biometric…');
        try {
          if (!window.PublicKeyCredential) throw new Error('Biometric not supported');
          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge: webAuthnDecode(data.challenge),
              timeout: data.timeout || 120000, rpId: data.rpId || location.hostname,
              allowCredentials: [{ id: webAuthnDecode(data.credentialId), type: 'public-key', transports: ['internal'] }],
              userVerification: 'required'
            }
          });
          if (!assertion) throw new Error('Biometric scan cancelled');
          const verified = await api('/auth/passkey/verify', {
            method: 'POST', body: { userId: data.userId, challengeId: data.challengeId, credential: assertionJSON(assertion) }
          });
          acceptSessionHook(verified);
        } catch (bioErr) {
          setErr(bioErr.message || 'Biometric verification failed');
          setBusy(false);
        }
        return;
      }
      acceptSessionHook(data);
    } catch (ex) { setErr(ex.message || 'Login failed. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextRow icon={I.user} cap="Username or email" placeholder="you@example.com"
        value={identifier} onChange={setIdentifier} autoFocus name="identifier" autoComplete="username" />
      <div className="psa-sep" />
      <TextRow icon={I.lock} cap="Password" type="password" placeholder="••••••••" value={password} onChange={setPassword} name="password" autoComplete="current-password" />
      <div className="psa-rowx">
        <button type="button" className="psa-link" onClick={() => onSwitch('reset')}>Forgot password?</button>
      </div>
      <ErrorBox msg={err} />
      <SubmitBtn busy={busy}>Log in</SubmitBtn>
      <p className="psa-trust"><span className="psa-shield">{I.shield}</span>Secure session · passkey protected when enabled</p>
    </form>
  );
}

function SignupPanel() {
  const [f, setF] = useState({ displayName: '', username: '', email: '', password: '', pin: '' });
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [terms, setTerms] = useState(false);
  const meter = strengthOf(f.password);
  const set = (key) => (value) => setF((current) => ({ ...current, [key]: value }));
  const nextStep = () => {
    setErr('');
    if (!f.displayName.trim() || !f.username.trim() || !f.email.trim()) {
      setErr('Complete all identity fields.'); return;
    }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(f.username.trim())) {
      setErr('Username must be 3–24 letters, numbers or underscores.'); return;
    }
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) { setErr('Enter a valid email.'); return; }
    setStep(2);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (step === 1) { nextStep(); return; }
    if (busy) return;
    setErr('');
    if (f.password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (!/^\d{4}$/.test(f.pin)) { setErr('Set your 4-digit recovery PIN.'); return; }
    if (!terms) { setErr('Accept the Terms & Community Guidelines to continue.'); return; }
    setBusy(true);
    try {
      const data = await api('/auth/signup', { method: 'POST', body: {
        email: f.email.trim(), username: f.username.trim(), displayName: f.displayName.trim(),
        password: f.password, pin: f.pin, termsAccepted: true, termsVersion: '1.0',
      } });
      acceptSessionHook(data);
    } catch (ex) { setErr(ex.message || 'Signup failed. Please try again.'); setBusy(false); }
  };
  return (
    <form className={'psa-signup-form step-' + step} onSubmit={submit} noValidate>
      <div className="psa-stepbar" aria-label={'Signup step ' + step + ' of 2'}>
        <i className={step === 1 ? 'on' : ''}></i><i className={step === 2 ? 'on' : ''}></i><span>{step} / 2</span>
      </div>
      {step === 1 ? <div className="psa-step-panel" key="identity">
        <TextRow icon={I.user} cap="Display name" placeholder="Your name" value={f.displayName} onChange={set('displayName')} autoFocus name="displayName" autoComplete="name" />
        <div className="psa-sep" />
        <TextRow icon={I.at} cap="Username" placeholder="yourname" value={f.username} onChange={set('username')} name="username" autoComplete="username" />
        <div className="psa-sep" />
        <TextRow icon={I.mail} cap="Email" type="email" placeholder="you@example.com" value={f.email} onChange={set('email')} name="email" autoComplete="email" />
      </div> : <div className="psa-step-panel" key="security">
        <TextRow icon={I.lock} cap="Password" type="password" placeholder="At least 8 characters" value={f.password} onChange={set('password')} autoFocus name="password" autoComplete="new-password" />
        <div className="psa-mtr"><span className={'psa-mbar' + (f.password ? '' : ' empty')} style={{ width: meter.w + '%' }}></span><span className="psa-mlabel">{meter.label || ''}</span></div>
        <div className="psa-sep" />
        <Row icon={I.pin} cap="Recovery PIN · 4 digits" />
        <PinField value={f.pin} onChange={set('pin')} />
        <label className="psa-terms"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /><span>I agree to the <button type="button" className="psa-link-inline" onClick={openTermsModal}>Terms &amp; Community Guidelines</button>.</span></label>
      </div>}
      <ErrorBox msg={err} />
      <div className="psa-signup-actions">
        {step === 2 && <button type="button" className="psa-link psa-step-back" onClick={() => { setErr(''); setStep(1); }}>{I.back} Back</button>}
        <SubmitBtn busy={busy}>{step === 1 ? 'Continue' : 'Create account'}</SubmitBtn>
      </div>
      {step === 2 && <p className="psa-trust"><span className="psa-shield">{I.shield}</span>Recovery codes are shown once after signup</p>}
    </form>
  );
}
function ResetPanel({ onSwitch }) {
  const [identifier, setIdentifier] = useState('');
  const [pin, setPin] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setErr(''); setMsg('');
    if (!identifier.trim()) { setErr('Enter your username or email.'); return; }
    if (!/^\d{4}$/.test(pin)) { setErr('Enter your 4-digit security PIN.'); return; }
    if (!/^[A-Za-z0-9-]{10,32}$/.test(recoveryCode.trim())) { setErr('Enter one of your one-time recovery codes.'); return; }
    if (pw.length < 8) { setErr('New password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      const data = await api('/auth/reset-by-pin', { method: 'POST', body: { identifier: identifier.trim(), pin, recoveryCode: recoveryCode.trim(), newPassword: pw } });
      if (data && data.user) { acceptSessionHook(data); }
      else {
        setMsg('Password reset! Please sign in.');
        setTimeout(() => onSwitch('login', identifier.trim()), 1100);
      }
    } catch (ex) { setErr(ex.message || 'Reset failed. Please try again.'); setBusy(false); }
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextRow icon={I.user} cap="Username or email" placeholder="you@example.com"
        value={identifier} onChange={setIdentifier} autoFocus name="identifier" autoComplete="username" />
      <div className="psa-sep" />
      <Row icon={I.pin} cap="4-digit security PIN" />
      <PinField value={pin} onChange={setPin} />
      <div className="psa-sep" />
      <TextRow icon={I.shield} cap="One-time recovery code" placeholder="ABC123-XYZ789" value={recoveryCode} onChange={setRecoveryCode} name="recoveryCode" autoComplete="one-time-code" />
      <div className="psa-sep" />
      <TextRow icon={I.lock} cap="New password" type="password" placeholder="••••••••" value={pw} onChange={setPw} name="newPassword" autoComplete="new-password" />
      <ErrorBox msg={err} tone="bad" />
      <ErrorBox msg={msg} tone="ok" />
      <SubmitBtn busy={busy}>Reset password</SubmitBtn>
      <button type="button" className="psa-link" style={{ width: '100%', textAlign: 'center', marginTop: -4 }} onClick={() => onSwitch('login')}>Back to log in</button>
    </form>
  );
}

/* ============================== page ============================== */
function AuthApp() {
  const [mode, setMode] = useState('login');
  const [loginId, setLoginId] = useState('');
  const [pw, setPw] = useState('');
  const shellRef = useRef(null);
  const switchMode = (next, prefillId) => {
    setMode(next);
    if (prefillId) setLoginId(prefillId);
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  };
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('psa_identifier');
      if (saved) { setLoginId(saved); sessionStorage.removeItem('psa_identifier'); }
    } catch (_) {}
  }, [mode]);
  const reactToPointer = useCallback((event) => {
    const el = shellRef.current;
    if (!el || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    el.style.setProperty('--psa-x', (x * 100).toFixed(1) + '%');
    el.style.setProperty('--psa-y', (y * 100).toFixed(1) + '%');
    el.style.setProperty('--psa-rx', ((0.5 - y) * 4).toFixed(2) + 'deg');
    el.style.setProperty('--psa-ry', ((x - 0.5) * 5).toFixed(2) + 'deg');
  }, []);
  const resetDepth = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    el.style.setProperty('--psa-rx', '0deg');
    el.style.setProperty('--psa-ry', '0deg');
  }, []);
  const tabKeys = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    switchMode(mode === 'login' ? 'signup' : 'login');
    requestAnimationFrame(() => {
      const selected = shellRef.current && shellRef.current.querySelector('[role="tab"][aria-selected="true"]');
      if (selected) selected.focus();
    });
  };
  return (
    <div ref={shellRef} className={'psa psa-split-auth psa-mode-' + mode} onPointerMove={reactToPointer} onPointerLeave={resetDepth}>
      <div className="psa-split-bg" aria-hidden="true"><i className="psa-grain"></i><i className="psa-orb psa-orb-1"></i><i className="psa-orb psa-orb-2"></i><i className="psa-orb psa-orb-3"></i></div>
      <div className="psa-split-col">
        <section className="psa-word-stage" aria-label="PRIV SPACA">
          <div className="psa-micro-word">PRIV SPACA</div>
          <div className="psa-split-word" aria-hidden="true">
            <span className="psa-priv">PRIV</span><i className="psa-glass-slash"></i><span className="psa-spaca">SPACA</span>
            <i className="psa-float-dot dot-1"></i><i className="psa-float-dot dot-2"></i><i className="psa-float-dot dot-3"></i>
          </div>
        </section>
        <main className="psa-auth-card">
          {mode === 'reset' ? (
            <button type="button" className="psa-reset-back" onClick={() => switchMode('login')}>{I.back}<span>Log in</span></button>
          ) : (
            <div className="psa-auth-tabs" role="tablist" aria-label="Authentication" onKeyDown={tabKeys}>
              <button id="psa-login-tab" type="button" role="tab" aria-controls="psa-auth-panel" aria-selected={mode === 'login'} tabIndex={mode === 'login' ? 0 : -1} className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Log in</button>
              <button id="psa-signup-tab" type="button" role="tab" aria-controls="psa-auth-panel" aria-selected={mode === 'signup'} tabIndex={mode === 'signup' ? 0 : -1} className={mode === 'signup' ? 'active' : ''} onClick={() => switchMode('signup')}>Create account</button>
            </div>
          )}
          <header className="psa-panel-head">
            <h1 id="psa-panel-title">{mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset password'}</h1>
          </header>
          <div id="psa-auth-panel" className="psa-panel-body" key={mode}
            role={mode === 'reset' ? 'region' : 'tabpanel'}
            aria-labelledby={mode === 'reset' ? 'psa-panel-title' : (mode === 'login' ? 'psa-login-tab' : 'psa-signup-tab')}>
            {mode === 'login' && <LoginPanel onSwitch={switchMode} identifier={loginId} setIdentifier={setLoginId} password={pw} setPassword={setPw} />}
            {mode === 'signup' && <SignupPanel />}
            {mode === 'reset' && <ResetPanel onSwitch={switchMode} />}
          </div>
        </main>
        <p className="psa-minimal-foot">© {new Date().getFullYear()} PRIV SPACA</p>
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
