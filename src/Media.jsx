import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as dav from './dav'
import { copyImage } from './bridge'
import { decryptBytes } from './crypto'
import { kindOf, fmtSize, hasThumb, thumbPath, isMedia } from './store'
import Menu from './Menu.jsx'
import Icon from './Icon.jsx'
import { iconOfName } from './ui.jsx'
import { isTable } from './Sheet.jsx'
import { gate, PRI } from './queue'

const MAX_IMG = 24 << 20
const MAX_AV = 96 << 20
// how far outside the window media starts loading, and where it is dropped again
const NEAR = '400px'

export const mkey = f => f.path || (f.src || {}).token || f.name

/* Object URLs are shared between the inline preview and the lightbox. Only entries nobody
   is showing right now may be dropped - revoking a URL still on screen blanks the image. */
const cache = new Map()
const live = new Map()          // key -> how many things are showing it right now
const hold = k => live.set(k, (live.get(k) || 0) + 1)
const free = k => { const n = (live.get(k) || 1) - 1; n > 0 ? live.set(k, n) : live.delete(k) }
function trim () {
  for (const [k, v] of cache) {
    if (cache.size <= 16) break
    if (live.has(k)) continue
    cache.delete(k)
    URL.revokeObjectURL(v)
  }
}
export async function blobUrl (f, key, pri = PRI.full, onBytes) {
  const k = mkey(f)
  if (cache.has(k)) return cache.get(k)
  if (f.src) key = null   // direct bytes are not AES wrapped, WireGuard did that job
  let bytes = await gate(pri, () => dav.fileBytes(f), f.size || 0)
  if (key) bytes = await decryptBytes(key, bytes)
  const url = URL.createObjectURL(new Blob([bytes]))
  cache.set(k, url)
  trim()
  if (onBytes) onBytes(bytes)
  return url
}
/** Leaving a container drops every preview it loaded. */
export function dropCache () {
  for (const [k, v] of cache) if (!live.has(k)) { cache.delete(k); URL.revokeObjectURL(v) }
}

/** Fetch + decrypt, but only while `want`. Returns [url, error, retry]. */
function useBlob (f, key, want, pri, onBytes) {
  const k = mkey(f)
  const [url, setUrl] = useState(() => (want && cache.get(k)) || null)
  const [err, setErr] = useState(null)
  const [again, setAgain] = useState(0)

  // a new file (lightbox stepping) or going off screen resets the slot before it refills
  useEffect(() => { setUrl(want ? cache.get(k) || null : null); setErr(null) }, [k, want])

  useEffect(() => {
    if (!want || url) return
    let on = true
    blobUrl(f, key, pri, onBytes)
      .then(u => { if (on) { setUrl(u); setErr(null) } })
      .catch(e => { if (on) setErr(String(e.message || e)) })
    return () => { on = false }
  }, [want, url, k, key, again])

  /* Hold from the moment the bytes are wanted, not from when they arrive. Holding late left a
     gap: with a container full of pictures, the next blob's trim() revoked a URL a tile was
     about to show, and the tile stayed a black box with its filename. */
  useEffect(() => {
    if (!want) return
    hold(k)
    return () => free(k)
  }, [want, k])

  // a retry has to forget the cached URL too, or it just hands back the broken one
  return [url, err, () => {
    const u = cache.get(k)
    if (u) { cache.delete(k); URL.revokeObjectURL(u) }
    setUrl(null); setErr(null); setAgain(n => n + 1)
  }]
}

/* A file as a row. Its main action is the obvious one: a spreadsheet opens (that was hidden
   behind a small grid button before, and a click on the row saved it instead), anything else
   saves. A spreadsheet keeps a separate save button. */
const Row = ({ f, onSave, onOpen, extra }) => (
  <div className="frow">
    {extra}
    <button className="file hud" onClick={() => (onOpen ? onOpen(f) : onSave(f))} title={onOpen ? 'Open' : 'Save'}>
      <span className="ico"><Icon n={iconOfName(f.name, kindOf(f.name))} size={18} /></span>
      <span className="fn">{f.name}</span>
      <span className="fs">{f.src && <Icon n="direct" size={12} title="Direct from the other device" />}{fmtSize(f.size)}</span>
      {onOpen ? <Icon n="chevR" size={14} /> : <Icon n="download" size={14} />}
    </button>
    {onOpen && <button className="btn" title="Save a copy" aria-label="Save a copy" onClick={() => onSave(f)}><Icon n="download" size={15} /></button>}
  </div>
)

/** Full size overlay for one container's media. Arrows, wheel and keys move through it. */
export function Lightbox ({ list, i, setI, chatKey, close, onSave, onFull }) {
  const f = list[i]
  const kind = kindOf(f.name)
  const [full, err, retry] = useBlob(f, chatKey, true, PRI.open, onFull && (bytes => onFull(f, bytes)))
  const url = full || (hasThumb(f) ? cache.get(thumbPath(f.path)) : null) || null
  const [menu, setMenu] = useState(null)
  const step = useRef(0)
  const go = d => setI(x => (x + d + list.length) % list.length)

  useEffect(() => {
    const h = e => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(-1) }
      else return
      e.stopPropagation()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [close, list.length])

  // one notch per gesture: a trackpad fires dozens of small deltas per flick
  const wheel = e => {
    if (e.timeStamp - step.current < 260) return
    step.current = e.timeStamp
    go(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1)
  }
  const ctx = e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }

  return createPortal((
    <div className="lbox" onWheel={wheel} onPointerDown={e => e.target === e.currentTarget && close()}>
      {!url && !err && <div className="ph">Loading…</div>}
      {err && <button className="ph err" onClick={retry}>{err} · tap to retry</button>}
      {url && (kind === 'video'
        ? <video src={url} controls autoPlay playsInline onContextMenu={ctx} />
        : <img src={url} alt={f.name} decoding="async" onContextMenu={ctx} />)}
      {list.length > 1 && <button className="lnav p" onClick={() => go(-1)} title="Previous" aria-label="Previous"><Icon n="chevL" size={20} /></button>}
      {list.length > 1 && <button className="lnav n" onClick={() => go(1)} title="Next" aria-label="Next"><Icon n="chevR" size={20} /></button>}
      <div className="lcap">{f.name}{list.length > 1 ? ` · ${i + 1} of ${list.length}` : ''}</div>
      <button className="lx" onClick={close} title="Close · Esc" aria-label="Close"><Icon n="x" size={18} /></button>
      {menu && <Menu at={menu} items={[
        ['Save as…', () => onSave(f), false, 'download'],
        url && kind === 'image' && ['Copy image', () => copyImage(url), false, 'copy'],
      ].filter(Boolean)} close={() => setMenu(null)} />}
    </div>
  ), document.body)
}

export default function Attachment ({ f, chatKey, onSave, onZoom, onFull, onSheet, tile: asTile }) {
  const kind = kindOf(f.name)
  const small = hasThumb(f)
  // a tile pulls the 512px sibling when there is one, and only then the original
  const tile = small ? { ...f, path: thumbPath(f.path) } : f
  // the size gates guard the original; with a thumbnail only the 384px sibling is ever pulled
  const inlineOk = small || (kind === 'image' && f.size <= MAX_IMG) || (kind === 'audio' && f.size <= MAX_AV)
  const playable = kind === 'video' && (small || f.size <= MAX_AV)
  // an oversized original stays a row until asked for; that one pull leaves a thumbnail behind
  const [force, setForce] = useState(false)
  const [near, setNear] = useState(false)
  const box = useRef(null)
  // a video shows its thumbnail and nothing else: the clip itself only ever opens full size
  const want = (inlineOk || force || (playable && small)) && near
  const [url, err, retry] = useBlob(tile, chatKey, want, small ? PRI.thumb : PRI.full, small ? null : onFull)

  /* Load once it comes near the window and then leave it alone. Dropping media again on the
     way past made every tile reflow, which moved the tiles below, which reflowed those too.
     ponytail: so a long scroll holds every thumbnail of the open container in memory
     (~40KB each). Leaving the container frees them. Virtualise the stream if that ever bites. */
  useEffect(() => {
    const el = box.current
    if (!el || near) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true) }, { rootMargin: NEAR })
    io.observe(el)
    return () => io.disconnect()
  }, [near])

  // media saves through the menu only, so a click can mean "look at it" instead
  const [menu, setMenu] = useState(null)
  const [broke, setBroke] = useState(false)
  const ctx = e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }
  const save = () => { setMenu(null); onSave(f) }
  const copy = () => { setMenu(null); copyImage(url) }
  const mine = menu && <Menu at={menu} items={[
    ['Save as…', save, false, 'download'],
    url && kind === 'image' && ['Copy image', copy, false, 'copy'],
  ].filter(Boolean)} close={() => setMenu(null)} />
  // a tile that renders as a black box has a dead URL: fetch it once more, then give up
  const heal = () => { if (!broke) { setBroke(true); retry() } }

  // the placeholder holds the picture's own shape from the start, so nothing jumps when it fills
  const shape = f.w && f.h ? { '--ar': `${f.w} / ${f.h}` } : null

  /* A video tile is its thumbnail plus a play mark. The clip itself is never pulled into the
     stream - 90MB per tile is what made it crawl - it opens full size with the pipe to itself. */
  if (playable) {
    return (
      <div className="att hud vtile" ref={box} style={shape} onClick={() => onZoom(f)} onContextMenu={ctx}>
        {url && <img src={url} alt={f.name} decoding="async" onError={heal} />}
        <span className="vplay"><Icon n="play" size={18} fill /></span>
        <div className="cap">{f.name} · {fmtSize(f.size)}</div>
        {mine}
      </div>
    )
  }
  const table = !!(onSheet && f.path && isTable(f.name))
  /* gallery tile for an original too big to preview unasked: a square that says so */
  if (asTile && !inlineOk && !force) return (
    <button className="att hud gtile" ref={box} onClick={() => setForce(true)} title="Load preview">
      <Icon n={iconOfName(f.name, kind)} size={22} /><span>{fmtSize(f.size)}</span>
    </button>
  )
  if (!inlineOk && !force) return (
    <Row f={f} onSave={onSave} onOpen={table ? onSheet : null} extra={!table && isMedia(f.name)
      ? <button className="btn" onClick={() => setForce(true)} title="Load a preview once" aria-label="Load preview"><Icon n="eye" size={15} /></button>
      : null} />
  )

  return (
    <div className="att hud" ref={box} style={shape}>
      {!url && !err && <div className="ph">{want ? 'Loading…' : fmtSize(f.size)}</div>}
      {err && <button className="ph err" onClick={retry}>{err} · tap to retry</button>}
      {url && kind === 'image' && <img className="zin" src={url} alt={f.name} decoding="async" onError={heal} onClick={() => onZoom(f)} onContextMenu={ctx} />}
      {url && kind === 'audio' && <audio src={url} controls onContextMenu={ctx} />}
      <div className="cap" title="Right-click or long-press to save">{f.name} · {fmtSize(f.size)}{f.src ? ' · direct from ' + (f.src.dev || 'another device') : ''}</div>
      {mine}
    </div>
  )
}
