// AES-256-GCM with a PBKDF2 key. Wire format everywhere: [12B IV][ciphertext||16B tag].
// Node (electron/main.cjs) and Java (DavPlugin) produce the exact same bytes.
const enc = new TextEncoder()
const dec = new TextDecoder()
export const ITER = 250000

export const b64 = u => {
  let s = ''
  const a = new Uint8Array(u)
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000))
  return btoa(s)
}
/* The byte loop costs ~36ms of blocked UI per 5MB, so use the native decoder where it exists. */
export const unb64 = s => {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s)
  const bin = atob(s)
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}
export const rand = n => crypto.getRandomValues(new Uint8Array(n))

export async function deriveKey (password, saltB64, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter, hash: 'SHA-256' }, base, 256)
  return new Uint8Array(bits)
}

const aes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encryptBytes (raw, data) {
  const iv = rand(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(raw), data))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}
export async function decryptBytes (raw, buf) {
  const u = new Uint8Array(buf)
  const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, await aes(raw), u.subarray(12))
  return new Uint8Array(p)
}

export const encryptJson = async (raw, o) => b64(await encryptBytes(raw, enc.encode(JSON.stringify(o))))
export const decryptJson = async (raw, s) => JSON.parse(dec.decode(await decryptBytes(raw, unb64(s))))

/** What a locked chat stores so a password can be checked without a server round trip.
    The iteration count travels with the lock, so a vault can cost more than a chat does
    and an old lock still opens with the count it was made at. */
export async function newLock (password, iter = ITER) {
  const salt = b64(rand(16))
  const key = await deriveKey(password, salt, iter)
  return { lock: { v: 1, salt, it: iter, check: b64(await encryptBytes(key, enc.encode('tsdrop'))) }, key }
}
export async function unlock (lock, password) {
  const key = await deriveKey(password, lock.salt, lock.it || ITER)
  try {
    if (dec.decode(await decryptBytes(key, unb64(lock.check))) !== 'tsdrop') return null
    return key
  } catch (_) { return null }
}
