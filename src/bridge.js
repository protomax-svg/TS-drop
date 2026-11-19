import { registerPlugin, Capacitor } from '@capacitor/core'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import { Share } from '@capacitor/share'
import { b64, unb64, encryptBytes, decryptBytes } from './crypto'

const E = typeof window !== 'undefined' ? window.tsdrop : null
const NATIVE = Capacitor.isNativePlatform && Capacitor.isNativePlatform()
export const PLATFORM = E ? 'desktop' : NATIVE ? 'android' : 'web'
export const IS_DESKTOP = PLATFORM === 'desktop'

// One native plugin does every HTTP call on Android: HttpURLConnection refuses PROPFIND,
// and file bodies have to stream (and optionally encrypt) instead of going through JS.
const Dav = NATIVE ? registerPlugin('Dav') : null

const prog = new Map()
const emit = (id, loaded, total) => { const cb = prog.get(id); if (cb) cb(loaded, total) }
if (E) E.onProgress(({ id, loaded, total }) => emit(id, loaded, total))
if (NATIVE) Dav.addListener('progress', p => emit(p.url, p.loaded, p.total))

// Dev in a plain browser goes through the Vite proxy (CORS).
const devUrl = u => { const p = new URL(u); return '/dav' + p.pathname + p.search }

/** timeout (ms) is for probes only - a transfer must be allowed to take as long as it takes. */
export async function request (method, url, { headers = {}, body, timeout } = {}) {
  if (E) return E.req({ method, url, headers, body, timeout })
  if (NATIVE) {
    const r = await Dav.request({ method, url, headers, body: body == null ? null : String(body), timeout: timeout || 0 })
    return { status: r.status, text: r.data || '' }
  }
  const r = await fetch(devUrl(url), { method, headers, body })
  return { status: r.status, text: await r.text() }
}

/** A page's head for a link card. Untrusted URL: capped, redirect-following, no auth headers. */
export async function fetchHead (url) {
  if (E) return E.og(url)
  if (NATIVE) return (await Dav.og({ url })).data || ''
  const r = await fetch(url).catch(() => null)   // dev browser: CORS blocks most of these
  return r && r.ok ? (await r.text()).slice(0, 131072) : ''
}

/** Whole body as bytes. Previews only - callers must check the size first. */
export async function fetchBytes (url, headers) {
  if (E) {
    const r = await E.bytes({ url, headers })
    if (r.status !== 200) throw Object.assign(new Error(r.error || 'HTTP ' + r.status), { status: r.status })
    return new Uint8Array(r.data)          // raw over IPC: no base64 round trip
  }
  if (NATIVE) return unb64((await Dav.getBytes({ url, headers })).data)
  const r = await fetch(devUrl(url), { headers })
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status })
  return new Uint8Array(await r.arrayBuffer())
}

/** PUT bytes we already hold (thumbnails). The caller encrypts, this only carries. */
export async function putBytes (url, headers, bytes) {
  if (E) return request('PUT', url, { headers, body: bytes })
  if (NATIVE) {
    const r = await Dav.request({ method: 'PUT', url, headers, bodyB64: b64(bytes) })
    return { status: r.status, text: r.data || '' }
  }
  const r = await fetch(devUrl(url), { method: 'PUT', headers, body: bytes })
  return { status: r.status, text: '' }
}

/** A URL the page itself can load a local file from, so a thumbnail needs no copy in memory. */
export const localSrc = p => {
  if (!p) return null
  if (E) return E.fileUrl(p)
  if (NATIVE) return Capacitor.convertFileSrc(p)
  return null
}

/** Bytes of a file the user picked. Fallback for when the page cannot load it by URL. */
export async function readBytes (f) {
  if (f.blob) return new Uint8Array(await f.blob.arrayBuffer())
  if (!f.path) return null
  if (E) { const b = await E.read(f.path); return b ? new Uint8Array(b) : null }
  if (NATIVE) { const r = await Dav.read({ path: f.path }); return r && r.data ? unb64(r.data) : null }
  return null
}

export async function uploadFile (url, headers, file, onProgress, key) {
  if (onProgress) prog.set(url, onProgress)
  try {
    if (E) return await E.upload({ id: url, url, headers, filePath: file.path, key })
    if (NATIVE) return await Dav.upload({ url, headers, path: file.path, key })
    const raw = new Uint8Array(await file.blob.arrayBuffer())
    const body = key ? await encryptBytes(unb64(key), raw) : raw
    const r = await fetch(devUrl(url), { method: 'PUT', headers, body })
    return { status: r.status, text: '' }
  } finally { prog.delete(url) }
}

/** dir: desktop only - android and web have no say over where a download lands.
    ponytail: a folder picker on android means the SAF tree API, add it when someone asks. */
export async function downloadFile (url, headers, name, onProgress, key, saveAs, dir) {
  if (onProgress) prog.set(url, onProgress)
  try {
    if (E) return await E.download({ id: url, url, headers, name, key, saveAs, dir })
    if (NATIVE) return (await Dav.download({ url, headers, name, key })).path
    let bytes = new Uint8Array(await (await fetch(devUrl(url), { headers })).arrayBuffer())
    if (key) bytes = await decryptBytes(unb64(key), bytes)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes]))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 30000)
    return name
  } finally { prog.delete(url) }
}

/** Save bytes the page already holds, where downloadFile would have put them. Returns the
    path, or null when a save dialog was cancelled. */
export async function saveBytes (name, bytes, saveAs, dir) {
  if (E) return E.saveBytes({ name, data: bytes, saveAs, dir })
  if (NATIVE) return (await Dav.saveBytes({ name, data: b64(bytes) })).path
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([bytes]))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30000)
  return name
}

/** Put the picture already on screen on the clipboard. Returns true when it landed. */
export async function copyImage (url) {
  if (!url) return false
  const b = await fetch(url).then(r => r.blob()).catch(() => null)
  if (!b) return false
  if (E) return E.copyImage(new Uint8Array(await b.arrayBuffer()))
  try {
    // the clipboard only takes png, so anything else is re-drawn once through a canvas
    const png = b.type === 'image/png' ? b : await new Promise((ok, no) => {
      const i = new Image()
      i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight
        c.getContext('2d').drawImage(i, 0, 0); c.toBlob(x => (x ? ok(x) : no(new Error('no blob'))), 'image/png') }
      i.onerror = () => no(new Error('not an image'))
      i.src = url
    })
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch (_) { return false }
}

export async function pickFiles () {
  if (E) return E.pick()
  const { files } = await FilePicker.pickFiles({ readData: false })
  return files.map(f => ({ name: f.name, size: f.size, path: f.path, blob: f.blob }))
}

/** Images on the clipboard, turned into the same {name,size,path} shape the picker returns. */
export async function pasteFiles (ev) {
  const items = [...((ev.clipboardData && ev.clipboardData.items) || [])]
  const imgs = items.filter(i => i.kind === 'file' && /^image\//.test(i.type))
  if (!imgs.length) return []
  if (E) return (await E.paste()) || []
  const out = []
  for (const it of imgs) {
    const blob = it.getAsFile()
    if (!blob) continue
    const ext = (it.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const name = blob.name && /\./.test(blob.name) ? blob.name : `pasted-${Date.now()}.${ext}`
    if (!NATIVE) { out.push({ name, size: blob.size, blob }); continue }
    const raw = new Uint8Array(await blob.arrayBuffer())
    const r = await Dav.writeTemp({ name, data: b64(raw) })
    out.push({ name, size: r.size, path: r.path })
  }
  return out
}

/** Paste button: read the OS clipboard directly. Returns [] when there is no image on it. */
export async function clipboardImage () {
  if (E) return (await E.paste()) || []
  if (NATIVE) { const r = await Dav.clipboardImage(); return r && r.path ? [{ name: r.name, size: r.size, path: r.path }] : [] }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find(t => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      return [{ name: `pasted-${Date.now()}.${type.split('/')[1] || 'png'}`, size: blob.size, blob }]
    }
  } catch (_) {}
  return []
}

/** Direct mode: keep the bytes here and hand back where to fetch them. null = no tailnet. */
export async function registerFile (f) {
  if (E) return E.serve({ path: f.path, name: f.name, size: f.size })
  if (NATIVE) { const r = await Dav.serve({ path: f.path }); return r && r.ip ? r : null }
  return null
}
export const unregisterFile = token => (E ? E.unserve(token) : NATIVE ? Dav.unserve({ token }) : null)

/* ---- file manager + folder backup ---- */
export const pickDir = () => (E ? E.pickDir() : Promise.resolve(null))
export const listLocalDir = (path, recurse) => (E ? E.listDir({ path, recurse: !!recurse }) : Promise.resolve([]))
/** Camera roll as content:// URIs, which upload() streams without a temp copy. */
export const gallery = since => (NATIVE ? Dav.gallery({ since: since || 0 }).then(r => r.files || []) : Promise.resolve([]))
export const requestMedia = () => (NATIVE ? Dav.requestMedia() : Promise.resolve())
export const getDownloadDir = () => (E ? E.getDownloadDir() : Promise.resolve(''))
export const setDownloadDir = p => (E ? E.setDownloadDir(p) : Promise.resolve(''))

export const dropPaths = list => (E ? list.map(f => E.pathOf(f)).filter(Boolean).map(p => E.stat(p)) : [])

/** Files dropped into the chat compose box: direct mode serves straight off disk, so it needs
    a real path. Desktop already resolves one; android's drop event never carries one, so copy
    through a temp file the same way pasteFiles does. Web has no filesystem to write to. */
export async function dropFiles (list) {
  if (E) return (await Promise.all(dropPaths(list))).filter(Boolean)
  if (!NATIVE) return list.map(x => ({ name: x.name, size: x.size, blob: x }))
  const out = []
  for (const f of list) {
    const raw = new Uint8Array(await f.arrayBuffer())
    const r = await Dav.writeTemp({ name: f.name, data: b64(raw) })
    out.push({ name: f.name, size: r.size, path: r.path })
  }
  return out
}
/** Android 9 and older need a write permission before media can reach the gallery. */
export const ensureStorage = () => (NATIVE ? Dav.requestStorage().catch(() => {}) : Promise.resolve())
/** file:// is not a secure context, so the desktop copies through the main process. */
/** The text of a QR in an image. Android's webview has a decoder built in; the desktop has
    none, so it shells out to zbarimg, and says what to install when that is missing too.
    Returns '' when the picture simply holds no QR. */
export async function decodeQr (f) {
  const Det = typeof window !== 'undefined' ? window.BarcodeDetector : null
  if (Det) {
    const formats = await Det.getSupportedFormats().catch(() => [])
    if (formats.includes('qr_code')) {
      const bytes = f.blob ? null : await readBytes(f)
      const bmp = await createImageBitmap(f.blob || new Blob([bytes]))
      try {
        const hits = await new Det({ formats: ['qr_code'] }).detect(bmp)
        if (hits.length) return hits.map(h => h.rawValue).join('\n')
      } finally { bmp.close() }
    }
  }
  if (E && f.path) {
    const r = await E.qr(f.path)
    if (r && r.err) throw new Error(r.err)
    return (r && r.text) || ''
  }
  return ''
}

export const copyText = t => (E ? E.copy(String(t)) : navigator.clipboard.writeText(String(t)))
export const tailscale = () => (E ? E.tailscale() : Promise.resolve(null))
export const hideWindow = () => (E ? E.hide() : null)
/** The palette the desktop itself is themed with (Omarchy), or null anywhere else. */
export const desktopTheme = () => (E && E.desktopTheme ? E.desktopTheme() : Promise.resolve(null))
export const onDesktopTheme = cb => { if (E && E.onDesktopTheme) E.onDesktopTheme(cb) }
/** The OS share sheet (telegram, signal, mail…). paths are what downloadFile() handed back.
    Returns false where there is no sheet to open - desktop linux/windows have none. */
export async function shareTo (paths, text) {
  if (NATIVE) { await Dav.share({ paths: paths || [], text: text || '' }); return true }
  if (!E && navigator.share) { await navigator.share({ text: text || '' }); return true }
  return false
}
/** Only android can hand real FILES to another app. A browser's navigator.share would need
    the bytes back in memory as File objects, so there the caller saves them instead. */
export const CAN_SHARE = NATIVE

/** desktop: show in file manager. android: open it (gallery for media, picker otherwise). */
export const reveal = p => (E ? E.reveal(p) : NATIVE ? Dav.open({ path: p }).catch(() => Share.share({ files: [p] }).catch(() => {})) : null)
