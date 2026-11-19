/* Read-only access to a restic repository, enough to browse the latest snapshot and read
   files out of it. Written from restic's design document (doc/design.rst), repository
   versions 1 and 2:

     keys/<id>      JSON: scrypt parameters + the master key, encrypted with the password
     config         encrypted JSON {version, id, chunker_polynomial}
     snapshots/<id> encrypted JSON {time, tree, paths, tags, ...}
     index/<id>     encrypted JSON {packs:[{id, blobs:[{id, type, offset, length, uncompressed_length?}]}]}
     data/<xx>/<id> pack files: encrypted blobs back to back, then a header we never need,
                    because the index already says where every blob is

   Every encrypted thing is IV(16) | AES-256-CTR ciphertext | MAC(16), the MAC being
   Poly1305-AES over the ciphertext with the IV as nonce. In a version 2 repository a
   snapshot or index file may start with byte 2 and be zstd compressed after that, and a
   blob is compressed when the index gives it an uncompressed_length.

   The storage is whatever `backend` is: { get(path, start?, length?) -> Uint8Array,
   list(dir) -> [name] }. That is MEGA in the app and a folder on disk in the tests. */
import { ctr, ecb } from '@noble/ciphers/aes.js'
import { poly1305 } from '@noble/ciphers/_poly1305.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { decompress } from 'fzstd'

const te = new TextEncoder()
const td = new TextDecoder()
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }
const hex = u => Array.from(u, x => x.toString(16).padStart(2, '0')).join('')
const MASK = [0xff, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f]

/** {enc, k, r} as raw bytes. */
const keyOf = (enc, k, r) => ({ enc, k, r: r.map((x, i) => x & MASK[i]) })

function mac (key, nonce, data) {
  const s = ecb(key.k, { disablePadding: true }).encrypt(nonce)
  const pk = new Uint8Array(32); pk.set(key.r, 0); pk.set(s, 16)
  return poly1305(data, pk)
}

export function open (key, box) {
  if (box.length < 32) throw new Error('restic: encrypted data too short')
  const iv = box.subarray(0, 16)
  const ct = box.subarray(16, box.length - 16)
  const want = box.subarray(box.length - 16)
  const got = mac(key, iv, ct)
  let bad = 0
  for (let i = 0; i < 16; i++) bad |= got[i] ^ want[i]
  if (bad) throw new Error('restic: MAC check failed (wrong password or damaged data)')
  return ctr(key.enc, iv).decrypt(ct)
}

/** The inverse, for the tests' repository builder. */
export function seal (key, plain, iv = crypto.getRandomValues(new Uint8Array(16))) {
  const ct = ctr(key.enc, iv).encrypt(plain)
  const out = new Uint8Array(32 + ct.length)
  out.set(iv, 0); out.set(ct, 16); out.set(mac(key, iv, ct), 16 + ct.length)
  return out
}

/** Snapshot and index files of a v2 repository: byte 2 + zstd, or plain JSON. */
function unpackJson (plain) {
  if (plain[0] === 2) plain = decompress(plain.subarray(1))
  return JSON.parse(td.decode(plain))
}

/** The scrypt step is the slow part (restic tunes it to ~0.5 s of a server CPU, so several
    seconds on a phone). The master key it unlocks is what gets remembered instead. */
export async function unlock (backend, password, remembered) {
  if (remembered) {
    try {
      const m = JSON.parse(remembered)
      const key = keyOf(unb64(m.encrypt), unb64(m.mac.k), unb64(m.mac.r))
      open(key, await backend.get('config'))     // still the right repository?
      return { key, saved: remembered }
    } catch (_) {}
  }
  const ids = await backend.list('keys')
  if (!ids.length) throw new Error('restic: the repository has no keys')
  let last
  for (const id of ids) {
    const kf = JSON.parse(td.decode(await backend.get('keys/' + id)))
    if (kf.kdf !== 'scrypt') { last = new Error('restic: unknown KDF ' + kf.kdf); continue }
    const dk = await scryptAsync(te.encode(password), unb64(kf.salt), { N: kf.N, r: kf.r, p: kf.p, dkLen: 64 })
    const user = keyOf(dk.slice(0, 32), dk.slice(32, 48), dk.slice(48, 64))
    try {
      const m = JSON.parse(td.decode(open(user, unb64(kf.data))))
      return { key: keyOf(unb64(m.encrypt), unb64(m.mac.k), unb64(m.mac.r)), saved: JSON.stringify(m) }
    } catch (e) { last = e }
  }
  throw last && /MAC/.test(last.message) ? new Error('restic: wrong password for this backup') : last
}

export class Repo {
  constructor (backend, key) {
    this.b = backend
    this.key = key
    this.blobs = null            // blob id -> {pack, offset, length, ulen}
    this.trees = new Map()
    this.queue = []              // blob reads waiting for the next batch
    this.timer = null
  }

  async config () { return JSON.parse(td.decode(open(this.key, await this.b.get('config')))) }

  async snapshots () {
    const out = []
    for (const id of await this.b.list('snapshots')) {
      try { out.push({ id, ...unpackJson(open(this.key, await this.b.get('snapshots/' + id))) }) } catch (_) {}
    }
    return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  }

  async loadIndex () {
    const blobs = new Map()
    for (const id of await this.b.list('index')) {
      const ix = unpackJson(open(this.key, await this.b.get('index/' + id)))
      for (const p of ix.packs || []) {
        for (const x of p.blobs || []) blobs.set(x.id, { pack: p.id, offset: x.offset, length: x.length, ulen: x.uncompressed_length || 0 })
      }
    }
    this.blobs = blobs
  }

  where (id) {
    const w = this.blobs && this.blobs.get(id)
    if (!w) throw new Error('restic: blob ' + id.slice(0, 8) + ' is not in the index')
    return w
  }

  plain (w, box, id) {
    let out = open(this.key, box)
    if (w.ulen) out = decompress(out)
    if (id && hex(sha256(out)) !== id) throw new Error('restic: blob ' + id.slice(0, 8) + ' does not match its id')
    return out
  }

  /* Small reads are batched. Opening a container asks for every message file at once; on
     MEGA each separate read is two web requests, but those messages were written by the same
     hourly backup and sit side by side in a pack or two. So reads asked for in the same
     moment are grouped by pack, and neighbours (gaps up to GAP) come down as one range. */
  blob (id) {
    const w = this.where(id)
    return new Promise((resolve, reject) => {
      this.queue.push({ id, w, resolve, reject })
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 20)
    })
  }

  flush () {
    const q = this.queue
    this.queue = []; this.timer = null
    const GAP = 256 << 10; const MAX = 8 << 20
    const byPack = new Map()
    for (const x of q) { const l = byPack.get(x.w.pack) || []; l.push(x); byPack.set(x.w.pack, l) }
    const runs = []
    for (const [pack, l] of byPack) {
      l.sort((a, b) => a.w.offset - b.w.offset)
      let r = null
      for (const x of l) {
        const end = x.w.offset + x.w.length
        if (r && x.w.offset - r.end <= GAP && end - r.start <= MAX) { r.items.push(x); r.end = Math.max(r.end, end) }
        else { r = { pack, start: x.w.offset, end, items: [x] }; runs.push(r) }
      }
    }
    let next = 0
    const worker = async () => {
      while (next < runs.length) {
        const r = runs[next++]
        try {
          const raw = await this.b.get(`data/${r.pack.slice(0, 2)}/${r.pack}`, r.start, r.end - r.start)
          for (const x of r.items) {
            try { x.resolve(this.plain(x.w, raw.subarray(x.w.offset - r.start, x.w.offset - r.start + x.w.length), x.id)) } catch (e) { x.reject(e) }
          }
        } catch (e) { r.items.forEach(x => x.reject(e)) }
      }
    }
    return Promise.all([worker(), worker(), worker(), worker()])
  }

  async tree (id) {
    if (!this.trees.has(id)) {
      const p = this.blob(id).then(b => JSON.parse(td.decode(b)).nodes || [])
      this.trees.set(id, p)
      p.catch(() => this.trees.delete(id))
    }
    return this.trees.get(id)
  }

  /** The node at an absolute path ("/mnt/hdd/x"), or null. The root is a fake dir node. */
  async node (root, path) {
    let n = { type: 'dir', subtree: root, name: '' }
    for (const part of path.split('/').filter(Boolean)) {
      if (n.type !== 'dir') return null
      n = (await this.tree(n.subtree)).find(x => x.name === part)
      if (!n) return null
    }
    return n
  }

  /** A file's bytes. Blobs that sit next to each other in one pack (the usual case for one
      file) are fetched as one range, so a photo is a request or two, not one per chunk. */
  async read (node, onProgress) {
    if ((node.content || []).length === 1) {           // most message files: let them batch
      const b = await this.blob(node.content[0])
      if (onProgress) onProgress(b.length, b.length)
      return b
    }
    const parts = (node.content || []).map(id => ({ id, ...this.where(id) }))
    const runs = []
    for (const p of parts) {
      const r = runs[runs.length - 1]
      if (r && r.pack === p.pack && r.end === p.offset && r.end - r.start < 32 << 20) { r.items.push(p); r.end += p.length }
      else runs.push({ pack: p.pack, start: p.offset, end: p.offset + p.length, items: [p] })
    }
    const out = new Uint8Array(node.size || 0)
    let at = 0
    for (const r of runs) {
      const raw = await this.b.get(`data/${r.pack.slice(0, 2)}/${r.pack}`, r.start, r.end - r.start)
      for (const p of r.items) {
        const b = this.plain(p, raw.subarray(p.offset - r.start, p.offset - r.start + p.length), p.id)
        if (at + b.length > out.length) throw new Error('restic: file is larger than its recorded size')
        out.set(b, at); at += b.length
      }
      if (onProgress) onProgress(at, out.length)
    }
    return at === out.length ? out : out.subarray(0, at)
  }
}

export const _test = { b64, unb64, keyOf, hex }
