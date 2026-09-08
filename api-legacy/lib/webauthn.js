/** Minimal standards-based WebAuthn verification for ES256 platform credentials. */

const enc = new TextEncoder();

export function b64urlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64urlDecode(value, maxBytes = 64 * 1024) {
  const input = String(value || '');
  if (!input || input.length > Math.ceil(maxBytes * 4 / 3) + 8 || !/^[A-Za-z0-9_-]+={0,2}$/.test(input)) {
    throw new Error('Invalid base64url value');
  }
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/g, '');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  if (binary.length > maxBytes) throw new Error('Decoded value is too large');
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

export function randomChallenge(bytes = 32) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function concatBytes(...items) {
  const size = items.reduce((n, item) => n + item.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const item of items) { out.set(item, offset); offset += item.length; }
  return out;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

function readLength(bytes, state, info) {
  if (info < 24) return info;
  const read = (count) => {
    if (state.offset + count > bytes.length) throw new Error('Truncated CBOR');
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + bytes[state.offset++];
    return value;
  };
  if (info === 24) return read(1);
  if (info === 25) return read(2);
  if (info === 26) return read(4);
  throw new Error('Unsupported CBOR length');
}

function decodeCborValue(bytes, state, depth = 0) {
  if (depth > 32) throw new Error('CBOR nesting is too deep');
  if (state.offset >= bytes.length) throw new Error('Truncated CBOR');
  const first = bytes[state.offset++];
  const major = first >> 5;
  const info = first & 31;
  if (major === 0) return readLength(bytes, state, info);
  if (major === 1) return -1 - readLength(bytes, state, info);
  if (major === 2 || major === 3) {
    const length = readLength(bytes, state, info);
    if (state.offset + length > bytes.length) throw new Error('Truncated CBOR value');
    const value = bytes.slice(state.offset, state.offset + length);
    state.offset += length;
    return major === 2 ? value : new TextDecoder().decode(value);
  }
  if (major === 4) {
    const length = readLength(bytes, state, info);
    if (length > 1024) throw new Error('CBOR collection is too large');
    const out = [];
    for (let i = 0; i < length; i++) out.push(decodeCborValue(bytes, state, depth + 1));
    return out;
  }
  if (major === 5) {
    const length = readLength(bytes, state, info);
    if (length > 1024) throw new Error('CBOR collection is too large');
    const out = new Map();
    for (let i = 0; i < length; i++) out.set(decodeCborValue(bytes, state, depth + 1), decodeCborValue(bytes, state, depth + 1));
    return out;
  }
  if (major === 6) {
    readLength(bytes, state, info);
    return decodeCborValue(bytes, state, depth + 1);
  }
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22 || info === 23) return null;
  }
  throw new Error('Unsupported CBOR value');
}

export function decodeCbor(bytes, offset = 0) {
  const state = { offset };
  const value = decodeCborValue(bytes, state);
  return { value, offset: state.offset };
}

function decodeClientData(encoded, expectedType, expectedChallenge, expectedOrigin) {
  const raw = b64urlDecode(encoded, 8192);
  let data;
  try { data = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { throw new Error('Invalid clientDataJSON'); }
  if (!data || data.type !== expectedType || data.challenge !== expectedChallenge || data.origin !== expectedOrigin || data.crossOrigin === true) {
    throw new Error('WebAuthn client data mismatch');
  }
  return { raw, data };
}

async function parseAuthenticatorData(raw, rpId, { requireAttestedCredential = false } = {}) {
  if (!(raw instanceof Uint8Array) || raw.length < 37) throw new Error('Invalid authenticator data');
  const expectedRpHash = await sha256(enc.encode(rpId));
  if (!equalBytes(raw.slice(0, 32), expectedRpHash)) throw new Error('RP ID hash mismatch');
  const flags = raw[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('User presence and verification are required');
  const counter = new DataView(raw.buffer, raw.byteOffset + 33, 4).getUint32(0, false);
  if (!requireAttestedCredential) return { flags, counter };
  if (!(flags & 0x40) || raw.length < 55) throw new Error('Attested credential data missing');
  const credentialLength = new DataView(raw.buffer, raw.byteOffset + 53, 2).getUint16(0, false);
  const credentialStart = 55;
  const credentialEnd = credentialStart + credentialLength;
  if (!credentialLength || credentialEnd >= raw.length) throw new Error('Invalid credential id');
  const credentialId = raw.slice(credentialStart, credentialEnd);
  const decoded = decodeCbor(raw, credentialEnd);
  const cose = decoded.value;
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) {
    throw new Error('Only ES256 P-256 passkeys are supported');
  }
  const x = cose.get(-2), y = cose.get(-3);
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error('Invalid ES256 credential key');
  }
  return {
    flags, counter, credentialId,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', alg: 'ES256', ext: true, x: b64urlEncode(x), y: b64urlEncode(y) },
  };
}

export async function verifyRegistrationResponse(response, expected) {
  if (!response || response.type !== 'public-key') throw new Error('Invalid registration response');
  const rawId = b64urlDecode(response.rawId || response.id, 1024);
  decodeClientData(response.clientDataJSON, 'webauthn.create', expected.challenge, expected.origin);
  const attestation = decodeCbor(b64urlDecode(response.attestationObject, 64 * 1024)).value;
  if (!(attestation instanceof Map)) throw new Error('Invalid attestation object');
  const fmt = attestation.get('fmt');
  // Options request attestation:none; accepting packed without validating its
  // attStmt certificate/signature would create a false trust signal.
  if (fmt !== 'none') throw new Error('Unsupported attestation format');
  const authData = attestation.get('authData');
  const parsed = await parseAuthenticatorData(authData, expected.rpId, { requireAttestedCredential: true });
  if (!equalBytes(rawId, parsed.credentialId)) throw new Error('Credential id mismatch');
  return {
    credentialId: b64urlEncode(rawId),
    publicKeyJwk: parsed.publicKeyJwk,
    counter: parsed.counter,
    transports: Array.isArray(response.transports) ? response.transports.filter(x => ['internal','hybrid','usb','nfc','ble'].includes(x)).slice(0, 5) : [],
  };
}

function derEcdsaToRaw(signature) {
  if (signature.length === 64) return signature;
  let offset = 0;
  const take = () => {
    if (offset >= signature.length) throw new Error('Invalid DER signature');
    return signature[offset++];
  };
  if (take() !== 0x30) throw new Error('Invalid DER signature');
  let sequenceLength = take();
  if (sequenceLength & 0x80) {
    const count = sequenceLength & 0x7f;
    sequenceLength = 0;
    for (let i = 0; i < count; i++) sequenceLength = sequenceLength * 256 + take();
  }
  const integer = () => {
    if (take() !== 0x02) throw new Error('Invalid DER integer');
    let length = take();
    if (!length || offset + length > signature.length) throw new Error('Invalid DER integer length');
    let value = signature.slice(offset, offset + length); offset += length;
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new Error('Oversized DER integer');
    const out = new Uint8Array(32); out.set(value, 32 - value.length); return out;
  };
  const r = integer(), s = integer();
  if (sequenceLength <= 0 || offset !== signature.length) throw new Error('Invalid DER signature length');
  return concatBytes(r, s);
}

export async function verifyAuthenticationResponse(response, expected, credential) {
  if (!response || response.type !== 'public-key' || !credential || !credential.publicKeyJwk) throw new Error('Invalid authentication response');
  const rawId = b64urlDecode(response.rawId || response.id, 1024);
  if (b64urlEncode(rawId) !== credential.credentialId) throw new Error('Credential id mismatch');
  const client = decodeClientData(response.clientDataJSON, 'webauthn.get', expected.challenge, expected.origin);
  const authData = b64urlDecode(response.authenticatorData, 4096);
  const parsed = await parseAuthenticatorData(authData, expected.rpId);
  const clientHash = await sha256(client.raw);
  const signed = concatBytes(authData, clientHash);
  const signature = derEcdsaToRaw(b64urlDecode(response.signature, 1024));
  const key = await crypto.subtle.importKey('jwk', credential.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signed);
  if (!verified) throw new Error('Invalid passkey signature');
  const previous = Number(credential.counter || 0);
  if (previous > 0 && parsed.counter > 0 && parsed.counter <= previous) throw new Error('Passkey counter did not advance');
  return { counter: parsed.counter };
}
