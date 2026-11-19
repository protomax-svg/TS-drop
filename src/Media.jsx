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

/* Full window viewer for one container's media, the way Telegram does it: the picture fits the
   window, the wheel (or a trackpad pinch) zooms at the cursor, a double click or double tap
   toggles a close-up, two fingers pinch, a zoomed picture drags around, and at fit a swipe
   sideways moves through the album while a swipe down closes. A tap beside the picture closes.

   The view is { s, x, y }: zoom over "fits the window" and a pan in px from the centre. The
   picture is laid out at its fitted size and only ever transformed, so zooming never reflows. */
const ZMAX = 8
const STEP = 1.6                        // one press of + or -
export function Lightbox ({ list, i, setI, chatKey, close, onSave, onFull }) {
  const f = list[i]
  const kind = kindOf(f.name)
  const vid = kind === 'video'
  const [full, err, retry] = useBlob(f, chatKey, true, PRI.open, onFull && (bytes => onFull(f, bytes)))
  const url = full || (hasThumb(f) ? cache.get(thumbPath(f.path)) : null) || null
  const [menu, setMenu] = useState(null)
  const stage = useRef(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [ratio, setRatio] = useState(0)
  const [v, setV] = useState({ s: 1, x: 0, y: 0 })
  const [anim, setAnim] = useState(false)
  const [held, setHeld] = useState(false)
  const pts = useRef(new Map())          // pointer id -> [x, y] of every finger down
  const g = useRef(null)                 // the gesture running now
  const tapAt = useRef(null)             // the last tap, for a double tap

  const many = list.length > 1
  const go = d => { if (many) setI(x => (x + d + list.length) % list.length) }

  useEffect(() => {
    const el = stage.current
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // every picture opens at fit; the shape is known from the message before a byte arrives
  useEffect(() => { setV({ s: 1, x: 0, y: 0 }); setAnim(false); setRatio(f.w && f.h ? f.w / f.h : 0) }, [i, list])

  const fit = ratio && box.w && box.h
    ? (box.w / box.h > ratio ? { w: box.h * ratio, h: box.h } : { w: box.w, h: box.w / ratio })
    : null
  // a zoomed picture may not be dragged past its own edge; at fit it stays centred
  const clamp = (s, x, y) => {
    s = Math.min(ZMAX, Math.max(1, s))
    if (!fit) return { s, x: 0, y: 0 }
    const mx = Math.max(0, (fit.w * s - box.w) / 2)
    const my = Math.max(0, (fit.h * s - box.h) / 2)
    return { s, x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) }
  }
  // zoom to s2 keeping the point (cx, cy) - px from the centre - where it is on screen
  const zoomAt = (o, s2, cx = 0, cy = 0) => {
    const k = Math.min(ZMAX, Math.max(1, s2)) / o.s
    return clamp(o.s * k, cx - (cx - o.x) * k, cy - (cy - o.y) * k)
  }
  const at = (px, py) => { const b = stage.current.getBoundingClientRect(); return [px - b.left - b.width / 2, py - b.top - b.height / 2] }
  const live = useRef({})
  live.current = { v, zoomAt, vid }

  // the wheel zooms; React's onWheel is passive and could not stop the page from scrolling
  useEffect(() => {
    const el = stage.current
    const h = e => {
      const L = live.current
      if (L.vid) return
      e.preventDefault()
      const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      const [cx, cy] = at(e.clientX, e.clientY)
      setAnim(false)
      setV(o => L.zoomAt(o, o.s * Math.exp(-d * (e.ctrlKey ? 0.012 : 0.0022)), cx, cy))
    }
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  useEffect(() => {
    const h = e => {
      const L = live.current
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(1) }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(-1) }
      else if (e.key === '+' || e.key === '=') { setAnim(true); setV(o => L.zoomAt(o, o.s * STEP)) }
      else if (e.key === '-' || e.key === '_') { setAnim(true); setV(o => L.zoomAt(o, o.s / STEP)) }
      else if (e.key === '0') { setAnim(true); setV({ s: 1, x: 0, y: 0 }) }
      else return
      e.stopPropagation()
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [close, list.length])

  const pinchFrom = () => {
    const [a, b] = [...pts.current.values()]
    return { t: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m0: at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), s0: v.s, x0: v.x, y0: v.y }
  }
  const oneFrom = (px, py, onImg) => ({ t: 'one', sx: px, sy: py, x0: v.x, y0: v.y, moved: false, axis: null, onImg })

  const down = e => {
    if (e.button > 0 || e.target.closest('button')) return
    if (vid) { if (e.target === e.currentTarget) close(); return }
    stage.current.setPointerCapture(e.pointerId)
    pts.current.set(e.pointerId, [e.clientX, e.clientY])
    setAnim(false)
    if (pts.current.size === 2) g.current = pinchFrom()
    else if (pts.current.size === 1) g.current = oneFrom(e.clientX, e.clientY, e.target.tagName === 'IMG')
  }
  const move = e => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.set(e.pointerId, [e.clientX, e.clientY])
    const G = g.current
    if (!G) return
    if (G.t === 'pinch') {
      if (pts.current.size < 2) return
      const [a, b] = [...pts.current.values()]
      const m = at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
      const s2 = Math.min(ZMAX, Math.max(1, G.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / G.d0))
      const k = s2 / G.s0
      // the spot that was under the fingers stays under them while they move apart and travel
      setV(clamp(s2, m[0] - (G.m0[0] - G.x0) * k, m[1] - (G.m0[1] - G.y0) * k))
      return
    }
    const dx = e.clientX - G.sx; const dy = e.clientY - G.sy
    if (!G.moved && Math.hypot(dx, dy) < 6) return
    G.moved = true
    if (v.s > 1.01) { setHeld(true); setV(clamp(v.s, G.x0 + dx, G.y0 + dy)); return }
    // at fit the picture follows the finger along one axis: sideways to change, down to close
    G.axis = G.axis || (Math.abs(dx) > Math.abs(dy) ? 'x' : 'y')
    setV({ s: 1, x: G.axis === 'x' ? dx : 0, y: G.axis === 'y' ? dy : 0 })
  }
  const up = (e, cancel) => {
    if (!pts.current.has(e.pointerId)) return
    pts.current.delete(e.pointerId)
    const G = g.current
    setHeld(false)
    if (G && G.t === 'pinch') {
      // one finger left on the glass carries on as a drag
      if (pts.current.size === 1) { const [p] = [...pts.current.values()]; g.current = { ...oneFrom(p[0], p[1], false), moved: true } } else g.current = null
      return
    }
    g.current = null
    if (!G) return
    if (G.moved && v.s <= 1.01) {
      const dx = e.clientX - G.sx; const dy = e.clientY - G.sy
      setAnim(true)
      if (!cancel && G.axis === 'x' && Math.abs(dx) > 70 && many) { go(dx < 0 ? 1 : -1); return }
      if (!cancel && G.axis === 'y' && dy > 110) { close(); return }
      setV({ s: 1, x: 0, y: 0 })
      return
    }
    if (G.moved || cancel) return
    // a tap: beside the picture closes, twice on the picture zooms in or back out
    if (!G.onImg) { close(); return }
    const now = Date.now(); const last = tapAt.current
    if (last && now - last.t < 320 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      tapAt.current = null
      const [cx, cy] = at(e.clientX, e.clientY)
      setAnim(true)
      setV(o => (o.s > 1.01 ? { s: 1, x: 0, y: 0 } : zoomAt(o, 2.5, cx, cy)))
    } else tapAt.current = { t: now, x: e.clientX, y: e.clientY }
  }

  const btnZoom = k => { setAnim(true); setV(o => zoomAt(o, o.s * k)) }
  const ctx = e => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }
  const zoomed = v.s > 1.01
  const fade = !zoomed && v.y > 0 ? Math.max(0.35, 1 - v.y / 400) : 1

  return createPortal((
    <div className="lbox" style={{ '--lfade': fade }}>
      <div ref={stage} className={'lstage' + (vid ? ' vid' : '') + (zoomed ? ' zoomed' : '') + (held ? ' held' : '')}
        onPointerDown={down} onPointerMove={move} onPointerUp={e => up(e)} onPointerCancel={e => up(e, true)}>
        {!url && !err && <div className="ph">Loading…</div>}
        {err && <button className="ph err" onClick={retry}>{err} · tap to retry</button>}
        {url && (vid
          ? <video src={url} controls autoPlay playsInline onContextMenu={ctx} />
          : <img src={url} alt={f.name} decoding="async" draggable={false} onContextMenu={ctx}
              onLoad={e => { const t = e.currentTarget; if (t.naturalWidth && t.naturalHeight) setRatio(t.naturalWidth / t.naturalHeight) }}
              style={fit
                ? { width: fit.w, height: fit.h, transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, transition: anim ? 'transform .2s ease' : 'none' }
                : { maxWidth: '100%', maxHeight: '100%' }} />)}
      </div>
      <div className="ltop">
        <div className="lname">{f.name}{many && <span>{i + 1} of {list.length}</span>}</div>
        {!vid && <>
          <button className="lbtn" onClick={() => btnZoom(1 / STEP)} disabled={!zoomed} title="Zoom out · −" aria-label="Zoom out"><Icon n="minus" size={18} /></button>
          <button className="lpct" onClick={() => { setAnim(true); setV({ s: 1, x: 0, y: 0 }) }} title="Fit to window · 0">{Math.round(v.s * 100)}%</button>
          <button className="lbtn" onClick={() => btnZoom(STEP)} disabled={v.s >= ZMAX} title="Zoom in · +" aria-label="Zoom in"><Icon n="plus" size={18} /></button>
        </>}
        <button className="lbtn" onClick={() => onSave(f)} title="Save" aria-label="Save"><Icon n="download" size={18} /></button>
        <button className="lbtn" onClick={close} title="Close · Esc" aria-label="Close"><Icon n="x" size={20} /></button>
      </div>
      {many && !zoomed && <button className="lnav p" onClick={() => go(-1)} title="Previous" aria-label="Previous"><Icon n="chevL" size={22} /></button>}
      {many && !zoomed && <button className="lnav n" onClick={() => go(1)} title="Next" aria-label="Next"><Icon n="chevR" size={22} /></button>}
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
  const [nat, setNat] = useState(0)       // width/height, read off the picture when the message has none
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
  const ratio = f.w && f.h ? f.w / f.h : nat
  const shape = ratio ? { '--ar': String(ratio), '--arn': String(ratio) } : null
  // small pictures and direct sends carry no size; the first load tells it, once
  const measure = e => { const t = e.currentTarget; if (!ratio && t.naturalWidth && t.naturalHeight) setNat(t.naturalWidth / t.naturalHeight) }

  /* A video tile is its thumbnail plus a play mark. The clip itself is never pulled into the
     stream - 90MB per tile is what made it crawl - it opens full size with the pipe to itself. */
  if (playable) {
    return (
      <div className="att hud pic vtile" ref={box} style={shape} onClick={() => onZoom(f)} onContextMenu={ctx}>
        {url && <img src={url} alt={f.name} decoding="async" onError={heal} onLoad={measure} />}
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
    <div className={'att hud' + (kind === 'image' ? ' pic' : '')} ref={box} style={shape}>
      {!url && !err && <div className="ph">{want ? 'Loading…' : fmtSize(f.size)}</div>}
      {err && <button className="ph err" onClick={retry}>{err} · tap to retry</button>}
      {url && kind === 'image' && <img className="zin" src={url} alt={f.name} decoding="async" onError={heal} onLoad={measure} onClick={() => onZoom(f)} onContextMenu={ctx} />}
      {url && kind === 'audio' && <audio src={url} controls onContextMenu={ctx} />}
      <div className="cap" title="Right-click or long-press to save">{f.name} · {fmtSize(f.size)}{f.src ? ' · direct from ' + (f.src.dev || 'another device') : ''}</div>
      {mine}
    </div>
  )
}
