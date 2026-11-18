/* RFC 4226 (HOTP) + RFC 6238 (TOTP), plus the otpauth:// and Google Authenticator export
   formats. No dependencies and no DOM: the same code runs in the app and in totp.test.mjs. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const dec = new TextDecoder()

export function b32decode (s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!clean) throw new Error('the secret is empty')
  const bad = clean.replace(/[A-Z2-7]/g, '')
  if (bad) throw new Error(`"${bad[0]}" is not base32 — a secret is A-Z and 2-7 only`)
  const out = new Uint8Array((clean.length * 5) >> 3)
  let bits = 0; let val = 0; let i = 0
  for (const ch of clean) {
    val = (val << 5) | B32.indexOf(ch); bits += 5
    if (bits >= 8) { out[i++] = (val >>> (bits - 8)) & 0xff; bits -= 8 }
  }
  if (!i) throw new Error('the secret is too short')
  return out.subarray(0, i)
}

export function b32encode (bytes) {
  let bits = 0; let val = 0; let out = ''
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31]
  return out
}

export const ALGOS = ['SHA1', 'SHA256', 'SHA512']
const hashOf = a => ({ SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' })[normAlgo(a)]
export const normAlgo = a => {
  const n = String(a || '').toUpperCase().replace(/[\s-]/g, '')
  return ALGOS.includes(n) ? n : 'SHA1'
}
const digitsOf = d => (Number(d) >= 6 && Number(d) <= 10 ? Number(d) : 6)
const periodOf = p => (Number(p) > 0 && Number(p) <= 300 ? Number(p) : 30)

/** One HOTP code. counter is a plain number; 2^53 steps is ~billions of years at 30s. */
export async function hotp (secretBytes, counter, { digits = 6, algo = 'SHA1' } = {}) {
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(Math.floor(counter)))
  const k = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: hashOf(algo) }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg))
  const o = h[h.length - 1] & 0x0f                       // dynamic truncation, RFC 4226 §5.3
  const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) >>> 0
  return String(n % 10 ** digits).padStart(digits, '0')
}

export const step = (e, t = Date.now()) => Math.floor(t / 1000 / periodOf(e.period))
/** Seconds this TOTP code still has. Steps are aligned to the epoch, not to when it was added. */
export const remain = (e, t = Date.now()) => {
  const p = periodOf(e.period) * 1000
  return (p - (t % p)) / 1000
}

/** The code an entry shows right now. HOTP reads its stored counter, TOTP the clock. */
export const code = (e, t = Date.now()) =>
  hotp(b32decode(e.secret), e.type === 'hotp' ? (e.counter || 0) : step(e, t), e)

/* ---------------- otpauth:// ---------------- */

/** otpauth://totp/Issuer:account?secret=…&issuer=…&algorithm=…&digits=…&period=… */
export function parseUri (uri) {
  const s = String(uri || '').trim()
  if (!/^otpauth:\/\//i.test(s)) throw new Error('not an otpauth:// link')
  const u = new URL(s)
  const type = u.host.toLowerCase() === 'hotp' ? 'hotp' : 'totp'
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const at = label.indexOf(':')
  const prefix = at < 0 ? '' : label.slice(0, at).trim()
  const name = (at < 0 ? label : label.slice(at + 1)).trim()
  const q = u.searchParams
  const secret = (q.get('secret') || '').replace(/\s/g, '')
  b32decode(secret)                                      // reject garbage before it is stored
  return {
    type,
    name: name || label || 'account',
    issuer: (q.get('issuer') || prefix || '').trim(),
    secret: secret.toUpperCase().replace(/=+$/, ''),
    algo: normAlgo(q.get('algorithm')),
    digits: digitsOf(q.get('digits')),
    period: periodOf(q.get('period')),
    counter: Math.max(0, Math.floor(Number(q.get('counter')) || 0)),
  }
}

/** The link back out, for moving an account to another app or printing a paper backup. */
export function toUri (e) {
  const label = encodeURIComponent(e.issuer ? `${e.issuer}:${e.name}` : e.name)
  const q = new URLSearchParams({ secret: e.secret, algorithm: normAlgo(e.algo), digits: String(digitsOf(e.digits)) })
  if (e.issuer) q.set('issuer', e.issuer)
  if (e.type === 'hotp') q.set('counter', String(e.counter || 0)); else q.set('period', String(periodOf(e.period)))
  return `otpauth://${e.type === 'hotp' ? 'hotp' : 'totp'}/${label}?${q}`
}

/* ---------------- Google Authenticator export ----------------
   Its "transfer accounts" QR is otpauth-migration://offline?data=<base64 protobuf>. The
   wire format is tiny, so the few fields it holds are read here instead of pulling in protobufjs. */
const varint = (b, p) => {
  let v = 0; let shift = 0
  for (;;) {
    if (p >= b.length) throw new Error('truncated export payload')
    const c = b[p++]
    v += (c & 0x7f) * 2 ** shift
    if (!(c & 0x80)) return [v, p]
    shift += 7
    if (shift > 56) throw new Error('bad export payload')
  }
}
function * fields (b) {
  let p = 0
  while (p < b.length) {
    let tag; [tag, p] = varint(b, p)
    const no = tag >>> 3
    switch (tag & 7) {
      case 0: { let v; [v, p] = varint(b, p); yield [no, v]; break }
      case 2: { let len; [len, p] = varint(b, p); const s = p; p += len; if (p > b.length) throw new Error('truncated export payload'); yield [no, b.subarray(s, p)]; break }
      case 5: p += 4; break
      case 1: p += 8; break
      default: throw new Error('bad export payload')
    }
  }
}
const unb64 = s => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}
const MIG_ALGO = { 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }

function migEntry (buf) {
  const e = { type: 'totp', algo: 'SHA1', digits: 6, period: 30, counter: 0, name: '', issuer: '', secret: '' }
  for (const [no, v] of fields(buf)) {
    if (no === 1) e.secret = b32encode(v)
    else if (no === 2) e.name = dec.decode(v).trim()
    else if (no === 3) e.issuer = dec.decode(v).trim()
    else if (no === 4) e.algo = MIG_ALGO[v] || 'SHA1'
    else if (no === 5) e.digits = v === 2 ? 8 : 6
    else if (no === 6) e.type = v === 1 ? 'hotp' : 'totp'
    else if (no === 7) e.counter = v
  }
  if (!e.secret) throw new Error('an account in that export carries no secret')
  // the label often still is "issuer:account" even when the issuer field is set
  const at = e.name.indexOf(':')
  if (at > 0) {
    if (!e.issuer) e.issuer = e.name.slice(0, at).trim()
    e.name = e.name.slice(at + 1).trim()
  }
  if (!e.name) e.name = e.issuer || 'account'
  return e
}

export function parseMigration (uri) {
  const s = String(uri || '').trim()
  if (!/^otpauth-migration:\/\//i.test(s)) throw new Error('not an otpauth-migration:// link')
  const data = new URL(s).searchParams.get('data')
  if (!data) throw new Error('that export link carries no data')
  const out = []
  for (const [no, v] of fields(unb64(data))) if (no === 1) out.push(migEntry(v))
  if (!out.length) throw new Error('that export holds no accounts')
  return out
}

/** Everything in a blob of pasted text: plain links, export links, one or many, any order. */
export function parseAny (text) {
  const bits = String(text || '').split(/[\s\n]+/).filter(Boolean)
  const out = []
  const bad = []
  for (const b of bits) {
    if (!/^otpauth(-migration)?:/i.test(b)) continue        // prose around a pasted link
    try {
      if (/^otpauth-migration:/i.test(b)) out.push(...parseMigration(b))
      else out.push(parseUri(b))
    } catch (e) { bad.push(e.message) }
  }
  if (!out.length) throw new Error(bad[0] || 'paste an otpauth:// or otpauth-migration:// link')
  return out
}
