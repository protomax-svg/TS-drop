/* The authenticator vault: one AES-256-GCM blob on the server, opened by a password of its
   own — never the nextcloud one, never a container one. Plaintext secrets live in this
   module's memory and nowhere else: no localStorage, no disk, gone when the tab closes.

   File: vault/vault.json = { v, salt, it, check, rev, ts, d }, where d is the encrypted
   { entries: [...] }. Nextcloud only ever holds the ciphertext, so an account on the server
   (or a backup of it) is worth nothing without the password. */
import * as dav from './dav'
import * as C from './crypto'

export const DIR = 'vault'
export const FILE = DIR + '/vault.json'
/* 600k PBKDF2-SHA256 rounds, the current OWASP figure — ~0.4s on a phone, paid once per
   unlock. Chats use the older 250k; the count travels in the lock, so both keep working. */
export const ITER = 600000
export const IDLE_MS = 5 * 60 * 1000

let key = null          // the raw AES key, in memory only
let meta = null         // { v, salt, it, check } — what re-encrypting needs
let entries = null      // decrypted, including tombstones
let rev = 0
let touched = 0

const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
const byName = (a, b) => (a.issuer || a.name).localeCompare(b.issuer || b.name) || a.name.localeCompare(b.name)

export const isOpen = () => !!key
/** Every interaction pushes the auto-lock out; the UI asks idle() on a timer. */
export const touch = () => { touched = Date.now() }
export const idle = () => (key ? Date.now() - touched : 0)
export function lock () { key = null; meta = null; entries = null; rev = 0 }

export const list = () => (entries || []).filter(e => !e.del).sort(byName)
export const count = () => (entries || []).filter(e => !e.del).length

/* null means there really is no vault yet; a server that cannot be reached throws instead.
   The difference matters: "no vault" is what offers to create one, and creating one writes
   over whatever is at that path. A 503 must never be read as an empty slot. */
export async function load () {
  const r = await dav.dav('GET', FILE)
  if (r.status === 404) return null
  if (r.status >= 400) throw new Error(`could not read the vault (HTTP ${r.status})`)
  try { return JSON.parse(r.text) } catch (_) { throw new Error('the vault file is damaged — restore a backup') }
}
export const exists = raw => !!(raw && raw.salt && raw.check)

export async function create (password) {
  if (exists(await load())) throw new Error('there already is a vault on the server — unlock it instead')
  const { lock: lk, key: k } = await C.newLock(password, ITER)
  key = k; meta = lk; entries = []; rev = 0; touch()
  await dav.mkcolp(DIR)
  await write(entries)
}

/** false means a wrong password: nothing is unlocked and nothing leaks which part was wrong. */
export async function open (raw, password) {
  const k = await C.unlock(raw, password)
  if (!k) return false
  try {
    const body = await C.decryptJson(k, raw.d)
    key = k
    meta = { v: raw.v || 1, salt: raw.salt, it: raw.it || C.ITER, check: raw.check }
    entries = Array.isArray(body.entries) ? body.entries : []
    rev = raw.rev || 0
    touch()
    return true
  } catch (_) {
    lock()
    throw new Error('the vault file is damaged — restore a backup')
  }
}

async function write (next) {
  const body = { v: 1, salt: meta.salt, it: meta.it, check: meta.check, rev: rev + 1, ts: Date.now(), d: await C.encryptJson(key, { entries: next }) }
  const r = await dav.putJson(FILE, body)
  if (r.status >= 400) throw new Error('saving the vault failed (HTTP ' + r.status + ')')
  entries = next
  rev = body.rev
  touch()
}

/* Two phones adding a code at the same time used to mean one of them lost it: the whole
   vault is one file, so the second PUT wins outright. Every write therefore re-reads the
   file first and merges by entry id, newest mod stamp wins. A delete leaves a tombstone
   behind for the same reason — without one it would come back from the other device. */
const merge = (mine, theirs) => {
  const by = new Map()
  for (const e of [...theirs, ...mine]) {
    const p = by.get(e.id)
    if (!p || (e.mod || 0) >= (p.mod || 0)) by.set(e.id, e)
  }
  return [...by.values()]
}

async function commit (apply) {
  if (!key) throw new Error('the vault is locked')
  let base = entries
  const raw = await load()
  if (raw && raw.salt !== meta.salt) {
    throw new Error('the vault password was changed on another device — lock and unlock it again')
  }
  if (raw && (raw.rev || 0) > rev) {
    const body = await C.decryptJson(key, raw.d)
    base = merge(entries, Array.isArray(body.entries) ? body.entries : [])
    rev = raw.rev
  }
  await write(apply(base))
}

/** Pull in what the other devices wrote. Silent on a hiccup: the codes on screen still work. */
export async function refresh () {
  if (!key) return false
  const raw = await load().catch(() => null)
  if (!raw || raw.salt !== meta.salt || (raw.rev || 0) <= rev) return false
  try {
    const body = await C.decryptJson(key, raw.d)
    entries = merge(entries, Array.isArray(body.entries) ? body.entries : [])
    rev = raw.rev
    return true
  } catch (_) { return false }
}

const same = (a, b) => a.secret === b.secret && (a.issuer || '') === (b.issuer || '') && a.name === b.name

/** Returns how many were added and how many were already in there (re-importing is safe). */
export async function add (list2) {
  let added = 0; let dupes = 0
  await commit(cur => {
    const live = cur.filter(e => !e.del)
    const next = [...cur]
    for (const e of list2) {
      if (live.some(x => same(x, e))) { dupes++; continue }
      const row = { id: newId(), mod: Date.now(), type: 'totp', algo: 'SHA1', digits: 6, period: 30, counter: 0, ...e }
      next.push(row)
      live.push(row)
      added++
    }
    return next
  })
  return { added, dupes }
}

export const update = (id, patch) => commit(cur => cur.map(e => (e.id === id ? { ...e, ...patch, mod: Date.now() } : e)))
/** A tombstone, not a hole: the entry has to stay dead on the other devices too. */
export const remove = id => commit(cur => cur.map(e => (e.id === id ? { id: e.id, del: Date.now(), mod: Date.now() } : e)))

/** New password, same accounts. The whole blob is re-encrypted under a fresh salt and key. */
export async function changePassword (current, next) {
  if (!key) throw new Error('the vault is locked')
  const raw = await load()
  if (!raw || !(await C.unlock(raw, current))) return false
  const { lock: lk, key: k } = await C.newLock(next, ITER)
  const keep = entries
  key = k; meta = lk
  await write(keep)
  return true
}
