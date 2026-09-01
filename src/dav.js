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
export const candidates = () => [...cfg.extra, ...(cfg.base ? [cfg.base] : []), ...BUILTIN_ENDPOINTS].filter((v, i, a) => v && a.indexOf(v) === i)

const auth = () => ({ Authorization: 'Basic ' + btoa(cfg.user + ':' + cfg.pass) })
const encPath = p => p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
export const url = p => cfg.base + '/' + encPath(p)
export const authHeaders = auth

export async function dav (method, p, { headers = {}, body } = {}) {
  return request(method, url(p), { headers: { ...auth(), ...headers }, body })
}

/** First endpoint that answers a PROPFIND wins. Order: user picks, saved, built-ins. */
export async function detect (list = candidates()) {
  for (const b of list) {
    try {
      const r = await request('PROPFIND', b + '/', { headers: { ...auth(), Depth: '0' } })
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
export const getFile = (f, onProgress, key, saveAs) => downloadFile(srcUrl(f), srcHeaders(f), f.name, onProgress, f.src ? null : key, saveAs)
export const fileBytes = f => fetchBytes(srcUrl(f), srcHeaders(f))
