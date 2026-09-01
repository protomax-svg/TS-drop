import * as dav from './dav.js'
import * as C from './crypto.js'

/* The file manager side of the same Nextcloud: a plain browsable tree under ROOT.
   A vault is a TOP-LEVEL folder holding VAULT_FILE; its key encrypts the CONTENT of
   every file below it, at any depth. Deliberate ceiling: file and folder NAMES stay
   readable on the server, so a locked tree can still be browsed without the password. */
export const ROOT = 'files'
export const VAULT_FILE = '.tsvault.json'

const join = (...p) => p.filter(Boolean).join('/')

export const parentOf = p => String(p).split('/').filter(Boolean).slice(0, -1).join('/')
export const crumbs = p => String(p).split('/').filter(Boolean)
  .map((n, i, a) => ({ name: n, path: a.slice(0, i + 1).join('/') }))

/** One path segment, traversal-safe. Names come from the user AND from the server. */
export const safeSeg = name => {
  const s = String(name ?? '')
    .replace(/[\\/]/g, '')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-180)
    .replace(/^\.+/, '')  // a dot name is hidden by listDir, so it must not be creatable
    .trim()
  return s || 'file'
}

export const ensureFilesRoot = async () => { await dav.mkcol(ROOT) }

export async function listDir (path) {
  const rows = await dav.propfind(path, 1)
  return rows.filter(r => !r.name.startsWith('.'))
    .map(r => ({ name: r.name, path: join(path, r.name), isDir: !!r.isDir, size: r.size || 0, mtime: r.mtime || 0 }))
    .sort((a, b) => (b.isDir - a.isDir) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export async function mkdir (path) {
  const parts = String(path).split('/').filter(Boolean).map(safeSeg)
  for (let i = 1; i <= parts.length; i++) await dav.mkcol(parts.slice(0, i).join('/'))
  clearRecent()
  return parts.join('/')
}

export async function rename (path, newName) {
  const to = join(parentOf(path), safeSeg(newName))
  if (to === path) return path
  const r = await dav.move(path, to)
  if (r.status >= 400) throw new Error(`rename failed (HTTP ${r.status})`)
  clearRecent()
  return to
}

export async function moveTo (path, destDir) {
  if (destDir === path || destDir.startsWith(path + '/')) throw new Error('a folder cannot move into itself')
  const to = join(destDir, safeSeg(path.split('/').pop()))
  if (to === path) return path
  const r = await dav.move(path, to)
  if (r.status >= 400) throw new Error(`move failed (HTTP ${r.status})`)
  clearRecent()
  return to
}

export async function remove (path) {
  const r = await dav.del(path)
  if (r.status >= 400 && r.status !== 404) throw new Error(`delete failed (HTTP ${r.status})`)
  clearRecent()
}

export async function uploadTo (dir, file, onProgress, keyB64) {
  const name = safeSeg(file.name)
  const path = join(dir, name)
  const r = await dav.put(path, file, onProgress, keyB64 || null)
  if (r && r.status >= 400) throw new Error(`upload "${name}" failed (HTTP ${r.status})`)
  clearRecent()
  return { name, path, isDir: false, size: file.size || 0, mtime: Date.now() }
}

/* ---------------- recent ----------------
   ponytail: bounded breadth-first walk (3 levels, 120 dirs, 6 PROPFINDs in flight).
   Nextcloud commonly refuses Depth: infinity, which is why the tree has to be walked.
   Swap for a Nextcloud REPORT/search query if the tree ever outgrows those bounds. */
const RKEY = 'tsdrop.recent'
const RTTL = 90000
let rcache = null

const cached = () => {
  if (rcache) return rcache
  try { rcache = JSON.parse(localStorage.getItem(RKEY) || 'null') } catch (_) { rcache = null }
  return rcache
}

export function clearRecent () {
  rcache = null
  try { localStorage.removeItem(RKEY) } catch (_) {}
}

export async function recent (limit = 60) {
  const c = cached()
  if (c && Date.now() - c.ts < RTTL) return c.rows.slice(0, limit)
  const q = [{ p: ROOT, d: 0 }]
  const files = []
  let dirs = 0
  while (q.length && dirs < 120) {
    const batch = q.splice(0, 6)
    dirs += batch.length
    const got = await Promise.all(batch.map(async b => [b, await listDir(b.p).catch(() => [])]))
    for (const [b, rows] of got) {
      for (const r of rows) {
        if (!r.isDir) files.push(r)
        else if (b.d + 1 < 3) q.push({ p: r.path, d: b.d + 1 })
      }
    }
  }
  const rows = files.sort((a, b) => b.mtime - a.mtime).slice(0, 200)
  rcache = { ts: Date.now(), rows }
  try { localStorage.setItem(RKEY, JSON.stringify(rcache)) } catch (_) {}
  return rows.slice(0, limit)
}

/* ---------------- vaults ---------------- */
export const vaultRootOf = path => {
  const parts = String(path).split('/').filter(Boolean)
  return parts[0] === ROOT && parts.length > 1 ? join(ROOT, parts[1]) : null
}

/** Memoised, the null answer too: browsing must not re-ask the server on every hop. */
const vaults = new Map()
export async function readVault (vaultRoot) {
  if (!vaultRoot) return null
  if (vaults.has(vaultRoot)) return vaults.get(vaultRoot)
  const lock = await dav.getJson(join(vaultRoot, VAULT_FILE))
  const v = lock && lock.salt && lock.check ? lock : null
  vaults.set(vaultRoot, v)
  return v
}

export async function makeVault (vaultRoot, password) {
  const { lock, key } = await C.newLock(password)
  const r = await dav.putJson(join(vaultRoot, VAULT_FILE), lock)
  if (r.status >= 400) throw new Error(`vault create failed (HTTP ${r.status})`)
  vaults.set(vaultRoot, lock)
  return key
}

export async function openVault (vaultRoot, password) {
  const lock = await readVault(vaultRoot)
  return lock ? C.unlock(lock, password) : null
}
