/* One-way backup of a local source - the android camera roll, or a folder on desktop - into
   a folder on the user's own server. This module only decides WHAT to upload; files.uploadTo
   already streams the bytes with progress. */

const ROOT = 'files'   // files.ROOT, kept literal so this module needs no import to validate a target
const CAP = 20000

/* The rest of src/ imports extensionless, which Vite resolves and node does not, and the
   selftest imports this module directly. Nothing here needs the bridge until a sync runs. */
let P = 'web'
let dep = null
const load = () => dep || (dep = Promise.all([import('./bridge'), import('./files')]).then(([b, f]) => ({ b, f })))
load().then(d => { P = d.b.PLATFORM }, () => {})

export const CFG_KEY = 'tsdrop.sync'
const DEF = { on: false, dir: '', target: ROOT + '/sync', done: {}, last: 0 }

export const loadSync = () => ({ ...DEF, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') })
export const saveSync = c => localStorage.setItem(CFG_KEY, JSON.stringify(c))

export const sourceLabel = () => (P === 'android' ? 'gallery' : P === 'desktop' ? loadSync().dir : '')

/** A target may only ever live under files/ - anything else could scribble over chats/. */
export const validTarget = (t, root = ROOT) => typeof t === 'string' && t.startsWith(root + '/') &&
  t.slice(root.length + 1).split('/').every(s => /^[^/\\]+$/.test(s) && s !== '.' && s !== '..')

/* ponytail: name+size+mtime, so an edit that keeps both size and mtime is never re-sent.
   Hashing every photo on a phone is the wrong trade; if it bites, hash size + head bytes. */
export const fileKey = f => `${f.name}:${f.size}:${f.mtime}`

export const listSource = async cfg => {
  const { b } = await load()
  if (b.PLATFORM === 'android') return b.gallery(cfg.last || 0)
  if (b.IS_DESKTOP) return cfg.dir ? b.listLocalDir(cfg.dir) : []
  return []
}

export const pending = (cfg, list) => { const d = cfg.done || {}; return list.filter(f => !d[fileKey(f)]) }

/* ponytail: done is capped at 20000 keys, oldest insertion first, so localStorage cannot grow
   without bound. Past that a very old file can be re-sent once; move to IndexedDB if it bites. */
const mark = (cfg, k) => {
  cfg.done[k] = 1
  const ks = Object.keys(cfg.done)
  if (ks.length > CAP) for (const old of ks.slice(0, ks.length - CAP)) delete cfg.done[old]
  saveSync(cfg)
}

/** Uploads everything pending. Returns {sent, failed, skipped}. */
export const runSync = async (cfg, { onFile, onProgress, signal } = {}) => {
  const { f } = await load()
  if (!validTarget(cfg.target, f.ROOT)) throw new Error('bad sync target: ' + cfg.target)
  // No password to hand uploadTo, so a vault target would write plaintext into an encrypted folder
  const vr = f.vaultRootOf(cfg.target)
  if (vr && await f.readVault(vr).catch(() => null)) throw new Error('sync target is inside a vault')
  if (!cfg.done) cfg.done = {}
  await f.mkdir(cfg.target)

  const list = await listSource(cfg)
  const todo = pending(cfg, list)
  const out = { sent: 0, failed: 0, skipped: list.length - todo.length }
  let stopped = false
  // Sequential on purpose: phones and home servers both fall over on parallel video uploads,
  // and one at a time is the only way progress means anything
  for (let i = 0; i < todo.length; i++) {
    if (signal && signal.aborted) { stopped = true; break }
    const file = todo[i]
    if (onFile) onFile(file.name, i, todo.length)
    try {
      await f.uploadTo(cfg.target, file, onProgress)
      mark(cfg, fileKey(file))   // per file, not batched: a crash mid-run must lose nothing and re-send nothing
      out.sent++
    } catch (_) { out.failed++ }   // one bad file must not end the run, and stays unmarked so it retries
  }
  // gallery() only lists files newer than cfg.last, so moving the window past a file that
  // failed or was never reached would hide it forever. done[] makes a re-listing cheap.
  if (!out.failed && !stopped) cfg.last = list.reduce((m, x) => Math.max(m, x.mtime || 0), cfg.last || 0)
  saveSync(cfg)
  return out
}
