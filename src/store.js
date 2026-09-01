import * as dav from './dav'
import * as C from './crypto'
import { registerFile, unregisterFile, readBytes, putBytes, localSrc } from './bridge'

export const CHATS = 'chats'
export const INBOX = 'inbox'

const rid = (n = 6) => Math.random().toString(36).slice(2, 2 + n)
export const newId = () => Date.now().toString(36) + '-' + rid()
const safeName = n => (String(n).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(-180) || 'file')

async function pmap (items, n, fn) {
  const out = []
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)))
  return out
}

/* ---------------- keys for locked chats ---------------- */
const keys = new Map()
const kk = cid => 'tsdrop.k.' + cid
export const getKey = cid => keys.get(cid) || null
export const hasKey = cid => keys.has(cid)
/** Keys live in memory for this run only. Nothing about them ever touches the disk. */
export function setKey (cid, raw) {
  keys.set(cid, raw)
  try { localStorage.removeItem(kk(cid)) } catch (_) {}
}
export function forgetKey (cid) {
  keys.delete(cid)
  try { localStorage.removeItem(kk(cid)) } catch (_) {}
  mem.delete(cid)
}
/** Older builds cached raw keys in localStorage. Wipe every last one on start. */
export function purgeStoredKeys () {
  const doomed = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('tsdrop.k.')) doomed.push(k)
  }
  for (const k of doomed) { try { localStorage.removeItem(k) } catch (_) {} }
  return doomed.length
}
export const locked = c => !!(c && c.lock)
export const readable = c => !locked(c) || keys.has(c.id)

/* ---------------- chats ---------------- */
export const ensureRoot = async () => { await dav.mkcol(CHATS); await dav.mkcol(INBOX) }

export async function loadChats () {
  const rows = await dav.propfind(CHATS, 1)
  const out = await pmap(rows.filter(r => r.isDir), 6, r => dav.getJson(`${CHATS}/${r.name}/chat.json`))
  return out.filter(Boolean).sort((a, b) => (a.ord ?? a.created) - (b.ord ?? b.created))
}

export async function createChat (name, accent, password) {
  const c = { id: newId(), name: name || 'container', accent: accent || '#89e694', created: Date.now() }
  if (password) {
    const { lock, key } = await C.newLock(password)
    c.lock = lock
    keys.set(c.id, key)
  }
  await dav.mkcolp(`${CHATS}/${c.id}/m`)
  await dav.putJson(`${CHATS}/${c.id}/chat.json`, c)
  return c
}
export const saveChat = c => dav.putJson(`${CHATS}/${c.id}/chat.json`, c)
export async function deleteChat (id) {
  await dav.del(`${CHATS}/${id}`)
  await dav.del(`${INBOX}/${id}`)
  forgetKey(id)
}

/* ---------------- thumbnails ----------------
   Measured on the tailnet: ~35ms per webdav request (it is PHP) and ~8.5MB/s of bandwidth.
   A 96px grid tile that pulls a 4MB original therefore costs ~0.5s and a full resolution
   decode. A 512px JPEG beside it is ~100x smaller, so a whole screen of tiles fits in one
   round trip. Images only - a video frame needs a native decoder. */
const THUMB_PX = 384
const THUMB_Q = 0.62
const THUMB_MIN = 160 << 10          // under this the original already is thumbnail sized
export const thumbPath = p => p + '.thm'
export const hasThumb = f => !!(f.thumb && f.path)

/** Returns { data, w, h }. The shape travels with the message so a tile can hold its space
    before a single byte of the picture has arrived - that is what stops the reflow dance. */
/** Waits for an <img> or <video> to actually have pixels in it. */
const load = (el, src) => new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error('timed out')), 20000)
  const win = () => { clearTimeout(t); ok(el) }
  el.onload = win
  el.onloadeddata = win
  el.onerror = () => { clearTimeout(t); no(new Error('cannot decode')) }
  el.src = src
})

/** Returns { data, w, h }. Works off a URL, so a 200MB video never enters memory. */
export async function makeThumb (src, kind) {
  let el = null
  try {
    if (kind === 'video') {
      el = document.createElement('video')
      el.muted = true
      el.playsInline = true
      el.preload = 'auto'
      await load(el, src)
      // the very first frame of a clip is often black, so step in a second when there is one
      if (el.duration > 1.2) await new Promise(ok => { el.onseeked = ok; el.currentTime = 1 })
    } else {
      el = await load(document.createElement('img'), src)
    }
    const w0 = el.videoWidth || el.naturalWidth
    const h0 = el.videoHeight || el.naturalHeight
    if (!w0 || !h0) return null
    const f = Math.min(1, THUMB_PX / Math.max(w0, h0))
    const c = new OffscreenCanvas(Math.max(1, Math.round(w0 * f)), Math.max(1, Math.round(h0 * f)))
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height)
    const b = await c.convertToBlob({ type: 'image/jpeg', quality: THUMB_Q })
    return { data: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height }
  } catch (_) {
    return null
  } finally {
    if (el) { el.src = ''; el.removeAttribute('src') }
  }
}

// an unknown size still gets one: a missing thumbnail costs far more than a spare one
const thumbable = f => isMedia(f.name) && kindOf(f.name) !== 'audio' && (!f.size || f.size >= THUMB_MIN)

async function putThumb (path, src, kind, k) {
  const t = await makeThumb(src, kind)
  if (!t) return null
  const r = await putBytes(dav.url(thumbPath(path)), dav.authHeaders(), k ? await C.encryptBytes(k, t.data) : t.data)
  return r && r.status < 400 ? { thumb: 1, w: t.w, h: t.h } : null
}

/** Make one from a file the user just picked, without reading the whole thing into memory. */
async function thumbOfLocal (path, f, k) {
  let url = f.blob ? URL.createObjectURL(f.blob) : localSrc(f.path)
  try {
    let t = url && await putThumb(path, url, kindOf(f.name), k)
    // android content:// urls are not always reachable from the page; fall back to the bytes
    if (!t) {
      const raw = await readBytes(f).catch(() => null)
      if (raw) {
        const u2 = URL.createObjectURL(new Blob([raw]))
        try { t = await putThumb(path, u2, kindOf(f.name), k) } finally { URL.revokeObjectURL(u2) }
      }
    }
    return t
  } finally { if (f.blob && url) URL.revokeObjectURL(url) }
}

/** Media sent before thumbnails existed: once the full bytes were fetched anyway, leave one. */
export async function backfillThumb (m, f, bytes, chat) {
  if (!f.path || f.thumb || !thumbable(f)) return
  const url = URL.createObjectURL(new Blob([bytes]))
  let t = null
  try { t = await putThumb(f.path, url, kindOf(f.name), keys.get(m.chat)) } finally { URL.revokeObjectURL(url) }
  if (!t) return
  const files = m.files.map(x => (x.path === f.path ? { ...x, ...t } : x))
  await updateMessage(m, { files }, chat).catch(() => {})
}

/* ---------------- message cache ----------------
   Locked chats stay in memory only, so plaintext never lands on disk. */
const mem = new Map()
const mkey = cid => 'tsdrop.m.' + cid
export function cached (cid) {
  if (mem.has(cid)) return mem.get(cid)
  try { return JSON.parse(localStorage.getItem(mkey(cid)) || '[]') } catch (_) { return [] }
}
function store (cid, list, secret) {
  mem.set(cid, list)
  try { secret ? localStorage.removeItem(mkey(cid)) : localStorage.setItem(mkey(cid), JSON.stringify(list)) } catch (_) {}
}

const wrap = async (cid, m) => {
  const k = keys.get(cid)
  return k ? { e: 1, d: await C.encryptJson(k, m) } : m
}
const unwrap = async (cid, raw) => {
  if (!raw) return null
  if (!raw.e) return raw
  const k = keys.get(cid)
  if (!k) return null
  try { return await C.decryptJson(k, raw.d) } catch (_) { return null }
}

/** Directory listing is the source of truth. Etags let edited messages come back. */
export async function syncMessages (cid, chat) {
  if (locked(chat) && !keys.has(cid)) { mem.set(cid, []); return [] }
  const rows = (await dav.propfind(`${CHATS}/${cid}/m`, 1)).filter(r => !r.isDir && r.name.endsWith('.json'))
  const have = new Map(cached(cid).map(m => [m.id, m]))
  const got = await pmap(rows, 8, async r => {
    const id = r.name.slice(0, -5)
    const old = have.get(id)
    const stamp = r.etag || String(r.mtime)
    if (old && old._s === stamp) return old
    const m = await unwrap(cid, await dav.getJson(`${CHATS}/${cid}/m/${id}.json`))
    // a hiccup on one GET must not make a message vanish from the list
    return m ? { ...m, _s: stamp } : (old || null)
  })
  const list = got.filter(Boolean).sort((a, b) => a.ts - b.ts)
  store(cid, list, locked(chat))
  return list
}

export async function sendMessage (cid, chat, { text, tags, files = [], author, reply, direct }, onProgress) {
  const id = newId()
  const k = keys.get(cid)
  const meta = []
  let noThumb = 0

  if (files.length && direct) {
    // nothing is uploaded: the bytes stay here and the message says where to fetch them
    for (const f of files) {
      const src = await registerFile(f)
      if (!src) throw new Error('direct needs tailscale up on this device — switch to CLOUD')
      meta.push({ name: safeName(f.name), size: f.size || 0, src: { ...src, dev: author || '?' } })
    }
  } else if (files.length) {
    await dav.mkcolp(`${INBOX}/${cid}/${id}`)
    const used = new Set()
    for (const f of files) {
      // locked chats get opaque names on the server; the real one lives in the encrypted body
      let stored = k ? rid(20) : safeName(f.name)
      while (used.has(stored)) stored = k ? rid(20) : stored.replace(/(\.[^.]*)?$/, m => '_' + rid(4) + (m || ''))
      used.add(stored)
      const path = `${INBOX}/${cid}/${id}/${stored}`
      const r = await dav.put(path, f, (l, t) => onProgress && onProgress(f.name, l, t), k ? C.b64(k) : null)
      if (r && r.status >= 400) throw new Error(`upload "${f.name}" failed (HTTP ${r.status})`)
      let thumb = null
      if (thumbable(f)) thumb = await thumbOfLocal(path, f, k)
      if (!thumb && thumbable(f)) noThumb++
      meta.push({ name: safeName(f.name), size: f.size || 0, path, ...(thumb || {}) })
    }
  }
  const m = {
    id, chat: cid, ts: Date.now(), author: author || '?',
    text: text || '', tags: tags || [], files: meta,
    ...(reply ? { reply } : {}),
  }
  const r = await dav.putJson(`${CHATS}/${cid}/m/${id}.json`, await wrap(cid, m))
  if (r.status >= 400) throw new Error('send failed (HTTP ' + r.status + ')')
  store(cid, [...cached(cid), m].sort((a, b) => a.ts - b.ts), locked(chat))
  return { ...m, noThumb }
}

/** Edit an already sent message. Used for tagging after the fact. */
export async function updateMessage (m, patch, chat) {
  const next = { ...m, ...patch, ...(patch.text !== undefined ? { edited: Date.now() } : {}) }
  delete next._s
  const r = await dav.putJson(`${CHATS}/${m.chat}/m/${m.id}.json`, await wrap(m.chat, next))
  if (r.status >= 400) throw new Error('save failed (HTTP ' + r.status + ')')
  store(m.chat, cached(m.chat).map(x => (x.id === m.id ? next : x)), locked(chat))
  return next
}

export async function deleteMessage (m, chat) {
  await dav.del(`${CHATS}/${m.chat}/m/${m.id}.json`)
  for (const f of m.files || []) if (f.src) await Promise.resolve(unregisterFile(f.src.token)).catch(() => {})
  if ((m.files || []).some(f => f.path)) await dav.del(`${INBOX}/${m.chat}/${m.id}`)
  store(m.chat, cached(m.chat).filter(x => x.id !== m.id), locked(chat))
}

/**
 * Move messages to another container. The message body is rewritten (a locked container
 * needs its own key) but attachments are moved server side, so nothing travels twice.
 */
export async function moveMessages (msgs, from, to) {
  if (from.id === to.id) return
  if (locked(from) && !keys.has(from.id)) throw new Error('unlock the source container first')
  if (locked(to) && !keys.has(to.id)) throw new Error('unlock the target container first')
  const moved = []
  for (const m of msgs) {
    const next = { ...m, chat: to.id }
    delete next._s
    if ((m.files || []).some(f => f.path)) {
      await dav.mkcolp(`${INBOX}/${to.id}`)
      const r = await dav.move(`${INBOX}/${from.id}/${m.id}`, `${INBOX}/${to.id}/${m.id}`)
      if (r.status >= 400 && r.status !== 404) throw new Error(`moving the files failed (HTTP ${r.status})`)
      const oldDir = `${INBOX}/${from.id}/${m.id}/`
      next.files = m.files.map(f => (f.path ? { ...f, path: f.path.replace(oldDir, `${INBOX}/${to.id}/${m.id}/`) } : f))
    }
    const w = await dav.putJson(`${CHATS}/${to.id}/m/${m.id}.json`, await wrap(to.id, next))
    if (w.status >= 400) throw new Error(`move failed (HTTP ${w.status})`)
    await dav.del(`${CHATS}/${from.id}/m/${m.id}.json`)
    moved.push(next)
  }
  const gone = new Set(moved.map(m => m.id))
  store(from.id, cached(from.id).filter(x => !gone.has(x.id)), locked(from))
  store(to.id, [...cached(to.id).filter(x => !gone.has(x.id)), ...moved].sort((a, b) => a.ts - b.ts), locked(to))
  return moved
}

/* ---------------- classify + search ---------------- */
const IMG = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i
const VID = /\.(mp4|webm|mkv|mov|m4v|avi|mpe?g)$/i
const AUD = /\.(mp3|m4a|aac|ogg|opus|wav|flac|wma)$/i
export const kindOf = n => (IMG.test(n) ? 'image' : VID.test(n) ? 'video' : AUD.test(n) ? 'audio' : 'file')
export const isMedia = n => kindOf(n) !== 'file'
export const LINK = /https?:\/\/[^\s<>"')]+/gi
export const linksIn = t => String(t || '').match(LINK) || []

export const hashtags = t => [...new Set((String(t).match(/#[\p{L}\p{N}_-]+/gu) || []).map(s => s.slice(1).toLowerCase()))]

export const allTags = msgs => [...new Set(msgs.flatMap(m => m.tags || []))].sort()

export const KINDS = ['all', 'media', 'files', 'links', 'text']
const matchKind = (m, kind) => {
  const fs = m.files || []
  switch (kind) {
    case 'media': return fs.some(f => isMedia(f.name))
    case 'files': return fs.some(f => !isMedia(f.name))
    case 'links': return linksIn(m.text).length > 0
    case 'text': return !fs.length
    default: return true
  }
}

export function search (msgs, q, tags, kind = 'all') {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean)
  return msgs.filter(m => {
    if (kind !== 'all' && !matchKind(m, kind)) return false
    if (tags.length && !tags.every(t => (m.tags || []).includes(t))) return false
    if (!terms.length) return true
    const hay = [m.text, (m.tags || []).join(' '), (m.files || []).map(f => f.name).join(' '), m.author]
      .join(' ').toLowerCase()
    return terms.every(t => hay.includes(t))
  })
}

export const fmtSize = b => {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)))
  return (b / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]
}
