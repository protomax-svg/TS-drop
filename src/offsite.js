/* The MEGA copy, read back when no server answers.

   The Proxmox host's hourly job (Cloud_infrastructure/bin/celephais-tsdrop-offsite) puts the
   switched-on containers, the vault and folders into a restic repository of their own on
   MEGA. Its install script leaves /.offsite.json in TSDROP's root:

     { "link": "https://mega.nz/folder/<handle>#<key>",   read-only link to that repository
       "password": "...",                                 the repository's restic password
       "root": "/mnt/hdd/tsdrop/data" }                   where TSDROP's data sits in a snapshot

   The app copies it to this device whenever a server answers, so it is still here on the day
   none does. A device that never met the server can take the link and password typed in by
   hand instead (adopt), checked against the backup before they are kept. The folder link can only read, so a lost phone cannot delete the backups, and
   the repository holds nothing but TSDROP, so it cannot open the cloud share's backups.

   What comes out is the same shape dav.js gives for the server - listings, JSON, file
   bytes - read only, frozen at the last snapshot. */
// MEGA's client and the restic reader load only when the backup is opened, not at every start

const CFG = 'tsdrop.offsite'
const MK = 'tsdrop.offsite.mk'
const get = k => { try { return localStorage.getItem(k) } catch (_) { return null } }
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch (_) {} }

/** What this device knows about the MEGA copy, or null. */
export const saved = () => { try { return JSON.parse(get(CFG) || 'null') } catch (_) { return null } }

/** Called with the server's /.offsite.json after every connect. null = the server has none. */
export function remember (o) {
  if (!o || !o.link || !o.password) return
  const old = saved()
  if (old && old.link === o.link && old.password === o.password && old.root === o.root) return
  put(CFG, JSON.stringify({ link: o.link, password: o.password, root: o.root || '/mnt/hdd/tsdrop/data' }))
  put(MK, null)
}

/* Typed in by hand, for a device that never met the server: a new phone on the day the
   server is gone, with the link and password from wherever they were written down. */
const LINK = /^https:\/\/mega(?:\.co)?\.nz\/(?:folder\/[\w-]+#[\w-]+|#F![\w-]+![\w-]+)$/

/** What is wrong with a typed link, or '' when it looks like a MEGA folder link. */
export function linkProblem (link) {
  const l = (link || '').trim()
  if (!l) return 'Paste the MEGA folder link'
  if (!/^https:\/\/mega(\.co)?\.nz\//.test(l)) return 'That is not a mega.nz link'
  if (!l.includes('#')) return 'The link is missing its key: the part after # must be included'
  if (!LINK.test(l)) return 'That is not a MEGA folder link (https://mega.nz/folder/…#…)'
  return ''
}

/** Check the link and password against the backup itself, and keep them only if it opens.
    Returns the opened snapshot, so the app can show it without unlocking a second time.
    backend is for the tests. */
export async function adopt ({ link, password, root }, backend) {
  const o = { link: (link || '').trim(), password: password || '', root: (root || '').trim() || '/mnt/hdd/tsdrop/data' }
  if (!backend) { const bad = linkProblem(o.link); if (bad) throw new Error(bad) }
  if (!o.password) throw new Error('Type the backup password')
  // A remembered master key would open the repository without looking at the password, so a
  // mistyped password would be kept. Forget it first; the password has to prove itself.
  const oldMk = get(MK)
  put(MK, null)
  try {
    const v = await connect(o, backend)
    put(CFG, JSON.stringify(o))
    return v
  } catch (e) {
    put(MK, oldMk)
    throw e
  }
}

/** Drop this device's copy of the link and password. The next server visit brings them back. */
export function forget () { put(CFG, null); put(MK, null) }

/* ---- MEGA as restic storage ---- */

async function megaBackend (link) {
  const { File } = await import('megajs')
  const top = File.fromURL(link)
  await top.loadAttributes()
  const at = path => path.split('/').filter(Boolean).reduce((n, name) => n && (n.children || []).find(c => c.name === name), top)
  return {
    async list (dir) { const n = at(dir); return n && n.children ? n.children.filter(c => !c.directory).map(c => c.name) : [] },
    async get (path, start, length) {
      const n = at(path)
      if (!n || n.directory) throw new Error('MEGA: no ' + path + ' in the backup')
      const opt = length == null ? {} : { start, end: start + length - 1 }
      if (length === 0) return new Uint8Array(0)
      const b = await n.downloadBuffer(opt)
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    },
  }
}

/* ---- the snapshot as a read-only server ---- */

const row = (name, n, href) => ({
  href, name,
  isDir: n.type === 'dir',
  size: n.type === 'file' ? n.size || 0 : 0,
  mtime: Date.parse(n.mtime || '') || 0,
  etag: n.type === 'dir' ? n.subtree : (n.content || []).join('').slice(0, 64) || 'empty',
})

/** Open the latest snapshot. backend is for the tests; the app passes nothing and gets MEGA. */
export async function connect (o = saved(), backend) {
  if (!o) throw new Error('This device has no MEGA backup details yet. They arrive the next time it reaches a server, or type them in Settings → MEGA backup.')
  const { unlock, Repo } = await import('./restic.js')
  const b = backend || await megaBackend(o.link)
  const { key, saved: mk } = await unlock(b, o.password, get(MK))
  if (!backend) put(MK, mk)
  const repo = new Repo(b, key)
  const snaps = await repo.snapshots()
  if (!snaps.length) throw new Error('The MEGA backup has no snapshots yet')
  const snap = snaps[snaps.length - 1]
  await repo.loadIndex()
  const base = (o.root || '/mnt/hdd/tsdrop/data').replace(/\/+$/, '')
  const top = await repo.node(snap.tree, base)
  if (!top || top.type !== 'dir') throw new Error('The MEGA backup does not contain ' + base)
  const node = p => repo.node(top.subtree, p)

  const list = async (p, depth) => {
    const n = await node(p)
    if (!n || n.type !== 'dir') return []
    const out = []
    const walk = async (subtree, rel, deep) => {
      for (const c of await repo.tree(subtree)) {
        const q = rel ? rel + '/' + c.name : c.name
        out.push(row(c.name, c, '/' + [p, q].filter(Boolean).join('/') + (c.type === 'dir' ? '/' : '')))
        if (deep && c.type === 'dir') await walk(c.subtree, q, true)
      }
    }
    await walk(n.subtree, '', depth === 'infinity')
    return out
  }

  return {
    time: Date.parse(snap.time) || 0,
    list,
    async stat (p) { const n = await node(p); return n ? { etag: row('', n).etag, mtime: row('', n).mtime } : null },
    async text (p) {
      const n = await node(p)
      return n && n.type === 'file' ? new TextDecoder().decode(await repo.read(n)) : null
    },
    async bytes (p, onProgress) {
      const n = await node(p)
      if (!n || n.type !== 'file') throw Object.assign(new Error('Not in the MEGA backup: ' + p.split('/').pop()), { status: 404 })
      return repo.read(n, onProgress)
    },
  }
}
