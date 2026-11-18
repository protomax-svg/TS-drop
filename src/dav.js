import { request, uploadFile, downloadFile, fetchBytes } from './bridge'

/* Your own tailnet addresses, comma separated, from .env at build time.
   Nothing personal is committed; empty is fine, then you type it in Setup once. */
export const BUILTIN_ENDPOINTS = (import.meta.env.VITE_DAV_ENDPOINTS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const DEFAULT_CFG = {
  base: '', extra: [], user: 'transferapp',
  pass: '',
  me: '', port: 8080, davPath: '/remote.php/dav/files/transferapp/file-transfer-app',
}

/** No password yet = first run. The app asks for it instead of shipping one. */
export const ready = () => !!cfg.pass

export const loadCfg = () => ({ ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('tsdrop.cfg') || '{}') })
export const saveCfg = c => localStorage.setItem('tsdrop.cfg', JSON.stringify(c))

let cfg = loadCfg()
export const setCfg = c => { cfg = c; saveCfg(c) }
export const getCfg = () => cfg
/* Built-ins come before the remembered one. cfg.base is only "the last server that
   answered"; when the built-in list moves (Nextcloud on the laptop -> Proxmox, with the
   laptop as the fallback), a remembered old server that still answers would otherwise keep
   winning forever. A server tested by hand in Setup becomes cfg.base and is used for the
   rest of that run; the next start goes back to the built-in order. cfg.extra, if ever
   set, outranks everything. */
export const candidates = () => [...cfg.extra, ...BUILTIN_ENDPOINTS, ...(cfg.base ? [cfg.base] : [])].filter((v, i, a) => v && a.indexOf(v) === i)

const auth = () => ({ Authorization: 'Basic ' + btoa(cfg.user + ':' + cfg.pass) })
const encPath = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
export const url = p => cfg.base + '/' + encPath(p)
export const authHeaders = auth

export async function dav (method, p, { headers = {}, body } = {}) {
  return request(method, url(p), { headers: { ...auth(), ...headers }, body })
}

/** First endpoint that answers a PROPFIND wins. Order: user picks, built-ins, last used. */
export async function detect (list = candidates()) {
  for (const b of list) {
    try {
      const r = await request('PROPFIND', b + '/', { headers: { ...auth(), Depth: '0' }, timeout: 6000 })
      if (r.status === 207) return b
    } catch (_) {}
  }
  return null
}

export async function propfind (p, depth = 1) {
  const r = await dav('PROPFIND', p + '/', { headers: { Depth: String(depth), 'Content-Type': 'application/xml' } })
  if (r.status === 404) return []
  if (r.status !== 207) throw new Error(`PROPFIND ${p} -> ${r.status}`)
  const doc = new DOMParser().parseFromString(r.text, 'application/xml')
  const selfPath = decodeURIComponent(new URL(url(p)).pathname).replace(/\/+$/, '')
  return [...doc.getElementsByTagNameNS('DAV:', 'response')].map(n => {
    const g = t => n.getElementsByTagNameNS('DAV:', t)[0]
    const href = decodeURIComponent(g('href').textContent)
    const name = href.replace(/\/$/, '').split('/').pop()
    return {
      href, name,
      isDir: !!n.getElementsByTagNameNS('DAV:', 'collection')[0],
      size: Number((g('getcontentlength') || {}).textContent || 0),
      mtime: Date.parse(((g('getlastmodified') || {}).textContent) || '') || 0,
      etag: ((g('getetag') || {}).textContent || '').replace(/"/g, ''),
    }
  }).filter(x => x.name && x.href.replace(/\/+$/, '') !== selfPath)
}

/** The entry itself (Depth 0): { etag, mtime } of a file or folder, null if it is not there.
    A folder's ETag moves whenever anything in it is added, replaced or removed (Apache's
    mod_dav_fs writes by rename, so even a same-size edit counts), which makes this a
    one-line "did anything change?" before paying for a full listing. */
export async function stat (p) {
  const r = await dav('PROPFIND', p + '/', { headers: { Depth: '0', 'Content-Type': 'application/xml' } })
  if (r.status === 404) return null
  if (r.status !== 207) throw new Error(`PROPFIND ${p} -> ${r.status}`)
  const doc = new DOMParser().parseFromString(r.text, 'application/xml')
  const g = t => doc.getElementsByTagNameNS('DAV:', t)[0]
  return {
    etag: ((g('getetag') || {}).textContent || '').replace(/"/g, ''),
    mtime: Date.parse(((g('getlastmodified') || {}).textContent) || '') || 0,
  }
}

export async function mkcol (p) {
  const r = await dav('MKCOL', p)
  if (r.status === 201 || r.status === 405) return true
  throw new Error(`MKCOL ${p} -> ${r.status}`)
}
export async function mkcolp (p) {
  const parts = p.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) await mkcol(parts.slice(0, i).join('/'))
}
export async function getJson (p) {
  const r = await dav('GET', p)
  if (r.status >= 400) return null
  try { return JSON.parse(r.text) } catch (_) { return null }
}
export const putJson = (p, o) => dav('PUT', p, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
export const del = p => dav('DELETE', p)
/** Server side move. Nothing is downloaded or uploaded again. */
export const move = (from, to) => dav('MOVE', from, { headers: { Destination: url(to), Overwrite: 'T' } })

export const put = (p, file, onProgress, key) => uploadFile(url(p), auth(), file, onProgress, key)

/* An attachment is either in the cloud (f.path, encrypted if the chat is locked) or
   served straight off the sending device (f.src). Direct bytes ride inside WireGuard. */
export const srcUrl = f => (f.src ? `http://${f.src.ip}:${f.src.port}/b/${f.src.token}` : url(f.path))
const srcHeaders = f => (f.src ? {} : auth())
export const getFile = (f, onProgress, key, saveAs, dir) => downloadFile(srcUrl(f), srcHeaders(f), f.name, onProgress, f.src ? null : key, saveAs, dir)
export const fileBytes = f => fetchBytes(srcUrl(f), srcHeaders(f))
