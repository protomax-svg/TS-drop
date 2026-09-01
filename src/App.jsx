import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import * as dav from './dav'
import * as C from './crypto'
import Attachment, { Lightbox, mkey, dropCache } from './Media.jsx'
import LinkCard from './Link.jsx'
import Menu from './Menu.jsx'
import Files from './Files.jsx'
import Sheet from './Sheet.jsx'
import { chatTree, reorder } from './tree'
import {
  ensureRoot, loadChats, createChat, saveChat, deleteChat,
  syncMessages, sendMessage, updateMessage, deleteMessage, cached,
  hashtags, search, fmtSize, KINDS, linksIn, allTags, moveMessages, kindOf, backfillThumb,
  getKey, hasKey, setKey, forgetKey, purgeStoredKeys, locked, readable,
} from './store'
import { PLATFORM, IS_DESKTOP, pickFiles, pasteFiles, clipboardImage, dropPaths, tailscale, reveal, hideWindow, growWindow, ensureStorage, copyText, pickDir, getDownloadDir, setDownloadDir, requestMedia } from './bridge'
import { loadSync, saveSync, runSync, validTarget } from './sync'

const ACCENTS = ['#89e694', '#22d3ee', '#a3a3a3', '#fbbf24', '#f87171', '#c084fc']
// how many messages are on screen at once. Every one of them mounts its tiles and its
// observers, so an old container used to build the whole history before it drew anything.
const PAGE = 50
const hm = { hour: '2-digit', minute: '2-digit', hour12: false }
const clock = t => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], hm)
    : d.toLocaleString([], { month: '2-digit', day: '2-digit', ...hm }).replace(',', '')
}
const clockFull = t => new Date(t).toLocaleString()
const cut = (s, n = 70) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''))
const linkify = s => String(s).split(/(https?:\/\/[^\s<>"')]+)/g).map((p, i) =>
  /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <Fragment key={i}>{p}</Fragment>)

purgeStoredKeys()

export default function App () {
  const [cfg, setCfgState] = useState(dav.loadCfg)
  const [status, setStatus] = useState('wait')
  const [chats, setChats] = useState([])
  const dragId = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [fold, setFold] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('tsdrop.fold') || '[]')) } catch (_) { return new Set() } })
  const toggleFold = id => setFold(f => {
    const n = new Set(f)
    n.has(id) ? n.delete(id) : n.add(id)
    try { localStorage.setItem('tsdrop.fold', JSON.stringify([...n])) } catch (_) {}
    return n
  })
  const [cid, setCid] = useState(() => localStorage.getItem('tsdrop.cid') || '')
  const [all, setAll] = useState({})
  const [q, setQ] = useState('')
  const [tags, setTags] = useState([])
  const [kind, setKind] = useState('all')
  const [scope, setScope] = useState('chat')
  const [text, setText] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [files, setFiles] = useState([])
  const [reply, setReply] = useState(null)
  const [direct, setDirect] = useState(() => localStorage.getItem('tsdrop.direct') === '1')
  const [editTags, setEditTags] = useState(null)
  const [busy, setBusy] = useState(null)
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const [drag, setDrag] = useState(false)
  const [sideOpen, setSideOpen] = useState(false)
  const [fmOn, setFmOn] = useState(() => localStorage.getItem('tsdrop.fm') === '1')
  const [fmEver, setFmEver] = useState(() => localStorage.getItem('tsdrop.fm') === '1')
  const [sel, setSel] = useState([])
  const [editMsg, setEditMsg] = useState(null)
  const [ask, setAsk] = useState(null)
  const [mmenu, setMmenu] = useState(null)
  const [cmenu, setCmenu] = useState(null)
  const [zoom, setZoom] = useState(null)
  const [more, setMore] = useState(() => new Set())
  const [limit, setLimit] = useState(PAGE)
  const [ts, setTs] = useState(null)
  const [unlocks, setUnlocks] = useState(0)
  const [sheet, setSheet] = useState(null)
  const streamRef = useRef(null); const qRef = useRef(null); const taRef = useRef(null)

  const applyCfg = c => { dav.setCfg(c); setCfgState(c) }
  const say = (m, err) => { setToast({ m, err }); setTimeout(() => setToast(t => (t && t.m === m ? null : t)), err ? 7000 : 3500) }
  const me = cfg.me || 'device'
  const chat = chats.find(c => c.id === cid)
  const shut = !!(chat && locked(chat) && !hasKey(chat.id))
  const chatKey = chat && !shut ? getKey(chat.id) : null
  const searching = !!(q || tags.length || kind !== 'all')

  useEffect(() => { document.documentElement.classList.toggle('light', !!cfg.light) }, [cfg.light])
  useEffect(() => { if (cid) localStorage.setItem('tsdrop.cid', cid) }, [cid])
  useEffect(() => { localStorage.setItem('tsdrop.direct', direct ? '1' : '0') }, [direct])
  useEffect(() => { localStorage.setItem('tsdrop.fm', fmOn ? '1' : '0'); if (fmOn) setFmEver(true) }, [fmOn])
  // electron owns the pane width, so this only says on or off
  useEffect(() => { growWindow(fmOn ? 1 : 0) }, [fmOn])
  useEffect(() => { if (cid && !all[cid]) setAll(a => ({ ...a, [cid]: cached(cid) })) }, [cid])
  useEffect(() => { setSel([]); setEditMsg(null); setZoom(null); setLimit(PAGE); dropCache() }, [cid])
  useEffect(() => { setLimit(PAGE) }, [q, tags, kind, scope])

  useEffect(() => {
    if (!dav.ready()) { setStatus('fail'); setModal('setup'); say('type the nextcloud password in setup', true); return }
    let live = true
    ;(async () => {
      const base = await dav.detect()
      if (!live) return
      if (!base) { setStatus('fail'); say('no endpoint answered — open SETUP', true); return }
      applyCfg({ ...dav.getCfg(), base })
      setStatus('ok')
      await ensureRoot()
      let cs = await loadChats()
      if (!cs.length) cs = [await createChat('GENERAL', ACCENTS[0])]
      if (!live) return
      setChats(cs)
      setCid(c => (cs.some(x => x.id === c) ? c : cs[0].id))
    })().catch(e => { setStatus('fail'); say(String(e.message || e), true) })
    return () => { live = false }
  }, [cfg.pass])

  useEffect(() => { ensureStorage() }, [])
  useEffect(() => { tailscale().then(t => { setTs(t); if (t && t.self && !dav.getCfg().me) applyCfg({ ...dav.getCfg(), me: t.self.split('.')[0] }) }) }, [])

  useEffect(() => {
    if (status !== 'ok' || !cid || !chat) return
    let live = true
    const tick = () => syncMessages(cid, chat).then(l => live && setAll(a => ({ ...a, [cid]: l }))).catch(() => {})
    tick(); const h = setInterval(tick, 3000)
    return () => { live = false; clearInterval(h) }
  }, [status, cid, chat, unlocks])

  // leaving a container, or locking it, closes any table opened out of it
  useEffect(() => { setSheet(null) }, [cid, unlocks])

  // 4h with no click/key/touch anywhere in the app forgets every unlocked container's key
  useEffect(() => {
    const IDLE_MS = 4 * 60 * 60 * 1000
    let last = Date.now()
    const bump = () => { last = Date.now() }
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel']
    events.forEach(e => window.addEventListener(e, bump, { passive: true }))
    const h = setInterval(() => {
      if (Date.now() - last < IDLE_MS) return
      let any = false
      for (const c of chats) if (hasKey(c.id)) { forgetKey(c.id); any = true }
      if (any) setUnlocks(n => n + 1)
    }, 60000)
    return () => { events.forEach(e => window.removeEventListener(e, bump)); clearInterval(h) }
  }, [chats])

  useEffect(() => {
    if (status !== 'ok') return
    let live = true
    const tick = async () => {
      const cs = await loadChats(); if (!live || dragId.current) return
      setChats(cs)
      for (const c of cs) {
        if (c.id === cid) continue
        const l = await syncMessages(c.id, c); if (!live) return
        setAll(a => ({ ...a, [c.id]: l }))
      }
    }
    tick().catch(() => {}); const h = setInterval(() => tick().catch(() => {}), 20000)
    return () => { live = false; clearInterval(h) }
  }, [status, cid, unlocks])

  /* A private container's tags never join the shared cloud: inside an open one you see only its
     own tags, outside you see only the tags of the plain containers. */
  const tagSrc = useMemo(() => (locked(chat) ? (readable(chat) ? [chat] : []) : chats.filter(c => !locked(c))), [chat, chats])

  const tree = useMemo(() => chatTree(chats), [chats])

  const view = useMemo(() => {
    const src = scope === 'all' ? tagSrc.flatMap(c => all[c.id] || []) : (all[cid] || [])
    return search(src, q, tags, kind).sort((a, b) => a.ts - b.ts)
  }, [all, tagSrc, cid, q, tags, kind, scope])

  /* Arrows and the wheel walk the media of the open container only, never across containers. */
  const media = useMemo(() => view.filter(m => m.chat === cid)
    .flatMap(m => (m.files || []).filter(f => ['image', 'video'].includes(kindOf(f.name))).map(f => ({ ...f, msg: m }))), [view, cid])
  const shown = view.length > limit ? view.slice(view.length - limit) : view
  const openZoom = f => {
    const i = media.findIndex(x => mkey(x) === mkey(f))
    setZoom(i < 0 ? { list: [f], i: 0 } : { list: media, i })
  }

  const knownTags = useMemo(() => allTags(tagSrc.flatMap(c => all[c.id] || [])), [all, tagSrc])
  const pinned = useMemo(() => (all[cid] || []).filter(m => m.pin), [all, cid])

  const tagCloud = useMemo(() => {
    const n = {}
    for (const c of tagSrc) for (const m of all[c.id] || []) for (const t of m.tags || []) n[t] = (n[t] || 0) + 1
    return Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 10)
  }, [all, tagSrc])

  useEffect(() => {
    const el = streamRef.current
    if (!el || searching) return
    let stick = true
    const onScroll = () => { stick = el.scrollHeight - el.scrollTop - el.clientHeight < 140 }
    const pin = () => { if (stick) el.scrollTop = el.scrollHeight }
    pin()
    const mo = new MutationObserver(pin)          // new messages, and the loading… -> media swap
    mo.observe(el, { childList: true, subtree: true })
    el.addEventListener('load', pin, true)        // images/videos only get their height on load
    el.addEventListener('scroll', onScroll)
    return () => { mo.disconnect(); el.removeEventListener('load', pin, true); el.removeEventListener('scroll', onScroll) }
  }, [cid, searching, shut])

  useEffect(() => {
    const h = e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); qRef.current && qRef.current.focus() }
      if (e.key === 'Escape') {
        if (zoom) setZoom(null)
        else if (ask) setAsk(null)
        else if (modal) setModal(null)
        else if (editMsg) setEditMsg(null)
        else if (sel.length) setSel([])
        else if (reply) setReply(null)
        else if (searching) { setQ(''); setTags([]); setKind('all') }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [modal, searching, reply, ask, editMsg, sel.length, zoom])

  const refresh = c => setAll(a => ({ ...a, [c]: cached(c) }))

  async function send () {
    const t = text.trim()
    const manual = tagDraft.split(/[\s,]+/).filter(Boolean).map(s => s.replace(/^#/, '').toLowerCase())
    const tg = [...new Set([...manual, ...hashtags(t), ...tags])]
    if (!t && !files.length) return
    setBusy({ label: 'sending', loaded: 0, total: 0 })
    try {
      const sent = await sendMessage(cid, chat, { text: t, tags: tg, files, author: me, reply, direct }, (n, l, tot) => setBusy({ label: n, loaded: l, total: tot }))
      if (sent && sent.noThumb) say(`${sent.noThumb} file(s) got no preview — they will load slowly`, true)
      setText(''); setTagDraft(''); setFiles([]); setReply(null)
      if (taRef.current) { taRef.current.style.height = 'auto'; taRef.current.focus() }
      refresh(cid)
    } catch (e) { say(String(e.message || e), true) } finally { setBusy(null) }
  }

  async function grab (f) {
    setBusy({ label: f.name, loaded: 0, total: f.size })
    try {
      const p = await dav.getFile(f, (l, tot) => setBusy({ label: f.name, loaded: l, total: tot || f.size }), chatKey ? C.b64(chatKey) : null, true)
      if (p) setToast({ m: 'saved · ' + f.name, path: p })
    } catch (e) {
      const msg = String(e.message || e)
      const gone = /HTTP (404|410)/.test(msg)
      say(f.src
        ? (gone ? `${f.src.dev || 'that device'} no longer shares this file` : `${f.src.dev || 'that device'} is offline — open TSDROP there`)
        : (gone ? 'that file is no longer on the cloud' : msg), true)
    } finally { setBusy(null) }
  }

  const copy = m => copyText(m.text || (m.files || []).map(f => f.name).join('\n'))
    .then(() => say('copied')).catch(() => say('copy failed', true))

  const patch = async (m, p) => {
    try { await updateMessage(m, p, chats.find(c => c.id === m.chat)); refresh(m.chat) }
    catch (e) { say(String(e.message || e), true) }
  }

  async function saveEdit (m, raw) {
    setEditMsg(null)
    const t = raw.trim()
    if (t === m.text) return
    await patch(m, { text: t, tags: [...new Set([...(m.tags || []), ...hashtags(t)])] })
  }

  const pick1 = m => setSel(x => (x.includes(m.id) ? x.filter(i => i !== m.id) : [...x, m.id]))
  const selMsgs = () => (scope === 'all' ? tagSrc.flatMap(c => all[c.id] || []) : (all[cid] || [])).filter(m => sel.includes(m.id))

  async function dropMany (list) {
    setAsk(null); setSel([])
    setBusy({ label: `deleting ${list.length}`, loaded: 0, total: 0 })
    try { for (const m of list) await deleteMessage(m, chats.find(c => c.id === m.chat)) }
    catch (e) { say(String(e.message || e), true) }
    finally { setBusy(null); new Set(list.map(m => m.chat)).forEach(refresh) }
  }

  async function moveMany (list, toId) {
    setAsk(null); setSel([])
    const to = chats.find(c => c.id === toId)
    setBusy({ label: `moving ${list.length} → ${to.name}`, loaded: 0, total: 0 })
    try {
      for (const [fromId, group] of Object.entries(list.reduce((a, m) => ({ ...a, [m.chat]: [...(a[m.chat] || []), m] }), {}))) {
        await moveMessages(group, chats.find(c => c.id === fromId), to)
      }
      say(`moved ${list.length} → ${to.name}`)
    } catch (e) { say(String(e.message || e), true) }
    finally { setBusy(null); new Set([...list.map(m => m.chat), toId]).forEach(refresh) }
  }

  async function saveTags (m, raw) {
    const list = [...new Set(raw.split(/[\s,]+/).filter(Boolean).map(s => s.replace(/^#/, '').toLowerCase()))]
    setEditTags(null)
    try { await updateMessage(m, { tags: list }, chats.find(c => c.id === m.chat)); refresh(m.chat) } catch (e) { say(String(e.message || e), true) }
  }

  const attach = () => pickFiles().then(f => setFiles(x => [...x, ...f])).catch(() => {})
  const pasteBtn = async () => {
    try {
      const f = await clipboardImage()
      if (f.length) setFiles(x => [...x, ...f]); else say('no image on the clipboard')
    } catch (e) { say(String(e.message || e), true) }
    if (taRef.current) taRef.current.focus()
  }

  async function onDrop (e) {
    e.preventDefault(); setDrag(false)
    const list = [...e.dataTransfer.files]
    if (!list.length) return
    const got = IS_DESKTOP ? (await Promise.all(dropPaths(list))).filter(Boolean)
      : list.map(x => ({ name: x.name, size: x.size, blob: x }))
    setFiles(f => [...f, ...got])
  }

  /* Drag a container over another to slot it there. The list reshuffles live, and the new
     positions are written to chat.json on drop so every device agrees.
     ponytail: rewrites ord on every container, fine for a handful. Native HTML5 drag, so
     desktop only, add a touch fallback if android needs it. */
  const hop = id => setChats(cs => reorder(cs, dragId.current, id))
  /* Pointer events, so one path covers mouse and touch. Only the grip has touch-action:none,
     which keeps normal finger scrolling on the rest of the row. */
  const takeRow = (e, id) => {
    e.preventDefault(); e.stopPropagation()
    dragId.current = id; setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveRow = e => {
    if (!dragId.current) return
    const row = document.elementFromPoint(e.clientX, e.clientY)
    const hit = row && row.closest('.chat')
    if (hit && hit.dataset.id) hop(hit.dataset.id)
  }
  const dropRow = () => { if (dragId.current) { setDragging(false); saveOrder() } }
  const saveOrder = async () => {
    if (!dragId.current) return
    dragId.current = null
    const stamped = chats.map((c, i) => ({ ...c, ord: i }))
    setChats(stamped)
    try { for (const c of stamped) await saveChat(c) } catch (e) { say(String(e.message || e), true) }
  }

  const toggleTag = t => setTags(x => (x.includes(t) ? x.filter(y => y !== t) : [...x, t]))
  const jump = id => { const el = document.getElementById('m-' + id); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900) } }

  return (
    <div className={'app' + (fmOn ? ' fmon' : '')}>
      <div className="top hud flat">
        <div className="brand" title={ts && ts.tailnet ? ts.tailnet : status}>
          <i className={'dot ' + (status === 'ok' ? 'ok' : status === 'wait' ? 'wait' : '')} />TSDROP
        </div>
        <button className="icobtn hud menu" onClick={() => setSideOpen(v => !v)} title="containers">≡</button>
        <button className={'icobtn hud' + (fmOn ? ' on' : '')} onClick={() => setFmOn(v => !v)} title="files">⊞</button>
        <div className="q hud">
          <input ref={qRef} value={q} onChange={e => setQ(e.target.value)} placeholder="search" />
          <button className="k" style={{ color: scope === 'all' ? 'var(--accent)' : undefined }}
            onClick={() => setScope(s2 => (s2 === 'all' ? 'chat' : 'all'))}>{scope === 'all' ? 'ALL' : 'HERE'}</button>
          {searching && <button className="k" onClick={() => { setQ(''); setTags([]); setKind('all') }}>CLR</button>}
        </div>
        <button className="icobtn hud" onClick={() => setModal('setup')} title="setup">⚙</button>
        {IS_DESKTOP && <button className="icobtn hud x" onClick={hideWindow} title="hide · Ctrl+Insert">×</button>}
      </div>

      {fmEver && <Files say={say} ready={status === 'ok'} onClose={() => setFmOn(false)} />}

      {sideOpen && <div className="sideshade" onPointerDown={() => setSideOpen(false)} />}

      <div className={'side hud' + (sideOpen ? ' open' : '')}>
        <div className="chats">
          {tree.map(({ c, kids }) => (
            <Fragment key={c.id}>
              <ChatRow c={c} cid={cid} takeRow={takeRow} moveRow={moveRow} dropRow={dropRow} held={dragging && dragId.current === c.id}
                folded={fold.has(c.id)} nKids={kids.length} onFold={() => toggleFold(c.id)}
                onPick={() => { setCid(c.id); setSideOpen(false) }} onEdit={() => setModal({ edit: c })}
                onMenu={at => setCmenu({ ...at, c })} />
              {!fold.has(c.id) && kids.map(k => (
                <ChatRow key={k.id} c={k} cid={cid} takeRow={takeRow} moveRow={moveRow} dropRow={dropRow} held={dragging && dragId.current === k.id} sub
                  onPick={() => { setCid(k.id); setSideOpen(false) }} onEdit={() => setModal({ edit: k })}
                  onMenu={at => setCmenu({ ...at, c: k })} />
              ))}
            </Fragment>
          ))}
          <button className="btn hud p" onClick={() => setModal({ edit: null })}>+ container</button>
          {!!tagCloud.length && <div className="sec">tags</div>}
          <div className="chips">
            {tagCloud.map(([t]) => (
              <button key={t} className={'chip hud' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>#{t}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="main hud" onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false) }} onDrop={onDrop}>
        <div className="sec">
          {chat ? chat.name : '—'}
          <span className="tag-n">{searching ? `${view.length} hit` : `${view.length} msg`}</span>
          {chat && <button className="btn hud" onClick={() => setModal({ edit: chat })}>edit</button>}
        </div>

        <div className="kinds">
          {KINDS.map(k => (
            <button key={k} className={'kb' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>

        {shut ? (
          <Unlock chat={chat} say={say} onOpen={() => { setUnlocks(n => n + 1); setAll(a => ({ ...a, [chat.id]: [] })) }} />
        ) : (
          <>
          {!!pinned.length && !searching && (
            <div className="pinbar">
              <span className="lab">⚑ {pinned.length}</span>
              {pinned.map(p => <button key={p.id} className="chip hud" onClick={() => jump(p.id)}>{cut(p.text || (p.files[0] || {}).name || 'file', 28)}</button>)}
            </div>
          )}
          {!!sel.length && (
            <div className="selbar hud">
              <span className="lab grow">{sel.length} selected</span>
              <button className="btn hud" onClick={() => setAsk({ kind: 'move', list: selMsgs() })}>move →</button>
              <button className="btn hud x" onClick={() => setAsk({ kind: 'del', list: selMsgs() })}>delete</button>
              <button className="btn hud" onClick={() => setSel([])}>clear</button>
            </div>
          )}
          <div className="stream" ref={streamRef}>
            {!view.length && <div className="empty">{searching ? 'no match' : 'empty container'}</div>}
            {view.length > limit && (
              <button className="btn hud older" onClick={() => setLimit(n => n + PAGE)}>
                load {Math.min(PAGE, view.length - limit)} older · {view.length - limit} left
              </button>
            )}
            {shown.map(m => (
              <div key={m.id} id={'m-' + m.id}
                className={'msg hud' + (m.author === me ? ' mine' : '') + (sel.includes(m.id) ? ' picked' : '') + (editMsg === m.id ? ' editing' : '') +
                  ((m.files || []).some(f => ['image', 'video'].includes(kindOf(f.name))) ? ' media' : '')}
                onClick={e => { if (sel.length && !e.target.closest('button,input,textarea,a,img,video,audio')) pick1(m) }}
                onContextMenu={e => { e.preventDefault(); setMmenu({ x: e.clientX, y: e.clientY, m }) }}>
                <div className="mhead">
                  <span className="who" title={clockFull(m.ts) + (m.edited ? ' · edited ' + clockFull(m.edited) : '')}>
                    <b>{m.author}</b> {clock(m.ts)}
                    {scope === 'all' && searching && ' · ' + ((chats.find(c => c.id === m.chat) || {}).name || m.chat)}
                  </span>
                  {m.pin && <span className="pin" title="pinned">⚑</span>}
                  <span className="grow" />
                  <button className="mb" title="copy text" onClick={() => copy(m)}>⧉</button>
                  <button className="mb" title="reply" onClick={() => { setReply({ id: m.id, author: m.author, text: cut(m.text || (m.files[0] || {}).name || 'file', 60) }); taRef.current && taRef.current.focus() }}>↩</button>
                  <button className="mb" title="tags" onClick={() => setEditTags(editTags === m.id ? null : m.id)}>#</button>
                  <button className="mb x" title="delete" onClick={() => setAsk({ kind: 'del', list: [m] })}>×</button>
                </div>

                {m.reply && (
                  <button className="quote" onClick={() => jump(m.reply.id)}>
                    <b>{m.reply.author}</b> {m.reply.text}
                  </button>
                )}

                {editMsg === m.id ? (
                  <textarea className="medit hud" autoFocus defaultValue={m.text || ''} rows={3}
                    onKeyDown={e => {
                      if (e.key === 'Escape') setEditMsg(null)
                      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveEdit(m, e.target.value) }
                    }}
                    onBlur={e => saveEdit(m, e.target.value)} />
                ) : !!m.text && <div className="mtext">{linkify(m.text)}</div>}
                {!!linksIn(m.text).length && <LinkCard url={linksIn(m.text)[0]} />}
                {!!(m.files || []).length && (() => {
                  const grid = m.files.filter(f => ['image', 'video'].includes(kindOf(f.name))).length > 1
                  /* With thumbnails a tile is ~40KB, so a dozen fit in a blink. Media sent before
                     thumbnails existed costs a whole original per tile, so open only a few. */
                  const cap = m.files.every(f => f.thumb || kindOf(f.name) !== 'image') ? 12 : 4
                  const cut = grid && m.files.length > cap && !more.has(m.id)
                  return (
                    <div className={'album' + (grid ? ' grid' : '')}>
                      {(cut ? m.files.slice(0, cap) : m.files).map(f => (
                        <Attachment key={mkey(f)} f={f} chatKey={chatKey} onSave={grab} onZoom={openZoom} onSheet={setSheet}
                          onFull={bytes => backfillThumb(m, f, bytes, chats.find(c => c.id === m.chat))} />
                      ))}
                      {cut && <button className="tmore hud" onClick={() => setMore(x => new Set(x).add(m.id))}>+{m.files.length - cap}</button>}
                    </div>
                  )
                })()}

                {editTags === m.id ? (
                  <input className="tagin hud" autoFocus defaultValue={(m.tags || []).join(', ')} placeholder="tags, comma sep"
                    onKeyDown={e => { if (e.key === 'Enter') saveTags(m, e.target.value); if (e.key === 'Escape') setEditTags(null) }}
                    onBlur={e => saveTags(m, e.target.value)} />
                ) : !!(m.tags || []).length && (
                  <div className="chips">
                    {m.tags.map(t => <button key={t} className={'chip hud' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>#{t}</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
        )}

        {!shut && (
          <div className="comp hud">
            {reply && (
              <div className="rbar">
                <span className="grow">↩ <b>{reply.author}</b> {reply.text}</span>
                <button className="mb x" onClick={() => setReply(null)}>×</button>
              </div>
            )}
            <textarea ref={taRef} rows={1} value={text} placeholder="message"
              onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(150, e.target.scrollHeight) + 'px' }}
              onKeyDown={e => {
                if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
                if (PLATFORM === 'android' && !(e.ctrlKey || e.metaKey)) return
                e.preventDefault(); send()
              }}
              onPaste={async e => {
                try { const f = await pasteFiles(e); if (f.length) { e.preventDefault(); setFiles(x => [...x, ...f]) } }
                catch (err) { say(String(err.message || err), true) }
              }} />
            {!!files.length && (
              <div className="chips">
                {files.map((f, i) => (
                  <button key={i} className="chip hud on" onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>
                    {f.name} · {fmtSize(f.size)} ×
                  </button>
                ))}
              </div>
            )}
            {busy && (
              <div>
                <div className="lab">{busy.label} {busy.total ? `· ${fmtSize(busy.loaded)} / ${fmtSize(busy.total)}` : ''}</div>
                <div className="bar"><i style={{ width: (busy.total ? (busy.loaded / busy.total) * 100 : 30) + '%' }} /></div>
              </div>
            )}
            <div className="crow">
              <button className="btn hud" onMouseDown={e => e.preventDefault()} onClick={attach}>+ file</button>
              <button className="btn hud" title="paste image" onMouseDown={e => e.preventDefault()} onClick={pasteBtn}>paste</button>
              <button className={'btn hud mode' + (direct ? ' on' : '')} onMouseDown={e => e.preventDefault()}
                title={direct ? 'files stay on this device until the other end pulls them' : 'files go through nextcloud'}
                onClick={() => setDirect(v => !v)}>{direct ? '⇄ direct' : '☁ cloud'}</button>
              <TagBox value={tagDraft} onChange={setTagDraft} known={knownTags} onSend={send} />
              <button className="btn hud p" disabled={!!busy || !cid}
                onMouseDown={e => e.preventDefault()} onClick={send}>send ▸</button>
            </div>
          </div>
        )}

        {drag && <div className="drop">release to attach</div>}
        {toast && (
          <button className={'toast hud' + (toast.err ? ' err' : '')} onClick={() => { if (toast.path) reveal(toast.path); setToast(null) }}>
            {toast.m}{toast.path ? (IS_DESKTOP ? '  ·  click to show' : '  ·  tap to open') : ''}
          </button>
        )}
      </div>

      {sheet && !shut && <Sheet float f={sheet} chatKey={chatKey} say={say} onClose={() => setSheet(null)} />}

      {zoom && (
        <Lightbox list={zoom.list} i={zoom.i} chatKey={chatKey} onSave={grab}
          onFull={(f, bytes) => f.msg && backfillThumb(f.msg, f, bytes, chats.find(c => c.id === f.msg.chat))}
          setI={fn => setZoom(z => (z ? { ...z, i: fn(z.i) } : z))} close={() => setZoom(null)} />
      )}

      {cmenu && (
        <Menu at={cmenu} close={() => setCmenu(null)} items={[
          !cmenu.c.parent && ['+ sub-container', () => setModal({ edit: null, parent: cmenu.c.id })],
          ['edit…', () => setModal({ edit: cmenu.c })],
          locked(cmenu.c) && hasKey(cmenu.c.id) && ['lock now', () => { forgetKey(cmenu.c.id); setUnlocks(n => n + 1) }],
        ]} />
      )}

      {mmenu && (
        <Menu at={mmenu} close={() => setMmenu(null)} items={[
          ['copy text', () => copy(mmenu.m)],
          ['edit text', () => setEditMsg(mmenu.m.id)],
          [mmenu.m.pin ? 'unpin' : 'pin', () => patch(mmenu.m, { pin: !mmenu.m.pin })],
          ['tags', () => setEditTags(mmenu.m.id)],
          [sel.includes(mmenu.m.id) ? 'deselect' : 'select', () => pick1(mmenu.m)],
          ['move to…', () => setAsk({ kind: 'move', list: sel.length ? selMsgs() : [mmenu.m] })],
          ['delete', () => setAsk({ kind: 'del', list: sel.length ? selMsgs() : [mmenu.m] }), true],
        ]} />
      )}

      {ask && ask.kind === 'del' && (
        <Confirm n={ask.list.length} close={() => setAsk(null)} onYes={() => dropMany(ask.list)} />
      )}
      {ask && ask.kind === 'move' && (
        <MoveTo n={ask.list.length} chats={chats} from={cid} close={() => setAsk(null)} onPick={id => moveMany(ask.list, id)} />
      )}

      {modal === 'setup' && <Setup cfg={cfg} applyCfg={applyCfg} ts={ts} status={status} setStatus={setStatus} say={say} close={() => setModal(null)} />}
      {modal && modal.edit !== undefined && (
        <ChatEdit chat={modal.edit} chats={chats} preset={modal.parent} close={() => setModal(null)} say={say}
          hasMsgs={!!(modal.edit && (all[modal.edit.id] || []).length)}
          onLockChange={() => setUnlocks(n => n + 1)}
          onSaved={c => { setChats(x => (x.some(y => y.id === c.id) ? x.map(y => (y.id === c.id ? c : y)) : [...x, c])); setCid(c.id); setModal(null) }}
          onDeleted={id => { setChats(x => x.filter(y => y.id !== id)); setCid(c => (c === id ? '' : c)); setModal(null) }} />
      )}
    </div>
  )
}

/** Enter takes the highlighted suggestion. With nothing to complete, Enter sends. */
function TagBox ({ value, onChange, known, onSend }) {
  const [i, setI] = useState(0)
  const parts = value.split(/[\s,]+/)
  const head = parts.slice(0, -1)
  const word = (parts[parts.length - 1] || '').replace(/^#/, '').toLowerCase()
  const taken = new Set(head.map(x => x.replace(/^#/, '').toLowerCase()))
  const hits = word ? known.filter(t => t.startsWith(word) && t !== word && !taken.has(t)).slice(0, 6) : []
  const at = Math.min(i, Math.max(0, hits.length - 1))
  const take = t => { onChange([...head, t].filter(Boolean).join(', ') + ', '); setI(0) }

  return (
    <div className="tagwrap">
      {!!hits.length && (
        <div className="tsug hud">
          {hits.map((t, n) => (
            <button key={t} className={n === at ? 'on' : ''} onMouseDown={e => { e.preventDefault(); take(t) }}>#{t}</button>
          ))}
        </div>
      )}
      <input className="tagin hud" value={value} placeholder="tags" onChange={e => { onChange(e.target.value); setI(0) }}
        onKeyDown={e => {
          if (e.isComposing) return
          if (hits.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault(); setI(x => (x + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length); return
          }
          if (e.key === 'Tab' && hits.length) { e.preventDefault(); take(hits[at]); return }
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (hits.length) take(hits[at]); else onSend()
        }} />
    </div>
  )
}

function Confirm ({ n, onYes, close }) {
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="sheet hud">
        <div className="h2">delete {n === 1 ? 'this message' : n + ' messages'}?</div>
        <div className="note">The message and any file it uploaded are removed from the cloud. This cannot be undone.</div>
        <div className="row">
          <span className="grow" />
          <button className="btn hud" autoFocus onClick={close}>cancel</button>
          <button className="btn hud x" onClick={onYes}>delete</button>
        </div>
      </div>
    </div>
  )
}

function ChatRow ({ c, cid, takeRow, moveRow, dropRow, held, onPick, onEdit, onMenu, sub, folded, nKids, onFold }) {
  return (
    <button data-id={c.id} className={'chat hud' + (c.id === cid ? ' sel' : '') + (sub ? ' sub' : '') + (held ? ' grab' : '')}
      onClick={onPick} onDoubleClick={onEdit}
      onContextMenu={e => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }) }}>
      {nKids
        ? <span className="fold" style={{ color: c.accent }} title={folded ? 'expand' : 'collapse'}
            onClick={e => { e.stopPropagation(); onFold() }}>{folded ? '▸' : '▾'}</span>
        : <span className="pip" style={{ color: c.accent }} />}
      <span className="nm">{c.name}</span>
      {!!nKids && <span className="kn">{nKids}</span>}
      {locked(c) && <span className="lk" title="private">{hasKey(c.id) ? '◇' : '◆'}</span>}
      <span className="grip" title="drag to reorder"
        onPointerDown={e => takeRow(e, c.id)} onPointerMove={moveRow} onPointerUp={dropRow} onPointerCancel={dropRow}
        onClick={e => e.stopPropagation()}>⠿</span>
    </button>
  )
}

function MoveTo ({ n, chats, from, onPick, close }) {
  const list = chats.filter(c => c.id !== from)
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="sheet hud">
        <div className="h2">move {n} to</div>
        {!list.length && <div className="note">There is no other container yet.</div>}
        {list.map(c => (
          <button key={c.id} className="peer hud" onClick={() => onPick(c.id)}>
            <span className="pip" style={{ color: c.accent }} />
            <span className="grow">{c.name}</span>
            {locked(c) && <span className="lk">{hasKey(c.id) ? '◇' : '◆'}</span>}
          </button>
        ))}
        <div className="note">Files move on the server. Nothing is uploaded again.</div>
        <div className="row"><span className="grow" /><button className="btn hud" onClick={close}>cancel</button></div>
      </div>
    </div>
  )
}

function Unlock ({ chat, onOpen, say }) {
  const [pw, setPw] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    setWork(true)
    const key = await C.unlock(chat.lock, pw)
    setWork(false)
    if (!key) { say('wrong password', true); return }
    setKey(chat.id, key)
    setPw('')
    onOpen()
  }
  return (
    <div className="lockpane">
      <div className="h2">private container</div>
      <div className="note">Messages and files in this container are AES-256-GCM encrypted before they leave this device. Nextcloud only ever sees ciphertext.</div>
      <input className="field hud" type="password" autoFocus value={pw} placeholder="password"
        onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <div className="note">The key is never written to this device. Close the app and it is gone.</div>
      <button className="btn hud p" disabled={work || !pw} onClick={go}>{work ? 'deriving key…' : 'unlock'}</button>
    </div>
  )
}

function ChatEdit ({ chat, chats, preset, close, onSaved, onDeleted, onLockChange, say, hasMsgs }) {
  const [name, setName] = useState(chat ? chat.name : '')
  const [parent, setParent] = useState(chat ? chat.parent || '' : preset || '')
  const [accent, setAccent] = useState(chat ? chat.accent : ACCENTS[0])
  const [priv, setPriv] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    if (priv && (!pw || pw !== pw2)) { say('passwords do not match', true); return }
    setWork(true)
    try {
      const c = chat ? { ...chat, name: name.trim() || chat.name, accent } : await createChat(name.trim() || 'chat', accent, priv ? pw : null)
      if (parent) c.parent = parent; else delete c.parent
      if (chat || parent) await saveChat(c)
      onSaved(c)
    } catch (e) { say(String(e.message || e), true); setWork(false) }
  }
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="sheet hud">
        <div className="h2">{chat ? 'edit container' : 'new container'}</div>
        <div className="lab">name</div>
        <input className="field hud" value={name} autoFocus placeholder="general" onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && go()} />
        <div className="lab">accent</div>
        <div className="sw">{ACCENTS.map(a => <button key={a} className={a === accent ? 'on' : ''} style={{ background: a }} onClick={() => setAccent(a)} />)}</div>

        <div className="lab">inside</div>
        <select className="field hud" value={parent} onChange={e => setParent(e.target.value)}>
          <option value="">— top level —</option>
          {chats.filter(x => !x.parent && (!chat || (x.id !== chat.id && !chats.some(y => y.parent === chat.id)))).map(x => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>

        {!chat && (
          <>
            <label className="row lab"><input type="checkbox" checked={priv} onChange={e => setPriv(e.target.checked)} /> private (password)</label>
            {priv && (
              <>
                <input className="field hud" type="password" value={pw} placeholder="password" onChange={e => setPw(e.target.value)} />
                <input className="field hud" type="password" value={pw2} placeholder="repeat" onChange={e => setPw2(e.target.value)} />
                <div className="note">Real AES-256-GCM, key from PBKDF2. Lose the password and the data is gone — there is no recovery.</div>
              </>
            )}
          </>
        )}
        {chat && locked(chat) && (
          <>
            <div className="note">This container is private. Encryption is set when a container is created; make a new private container to change the password.</div>
            <button className="btn hud" onClick={() => { forgetKey(chat.id); onLockChange(); close() }}>lock now / forget key</button>
          </>
        )}
        {chat && !locked(chat) && hasMsgs && <div className="note">Encryption can only be turned on for a new container.</div>}

        <div className="row">
          {chat && <button className="btn hud x" onClick={() => { if (confirm('delete container + its files?')) deleteChat(chat.id).then(() => onDeleted(chat.id)).catch(e => say(String(e.message), true)) }}>delete</button>}
          <span className="grow" />
          <button className="btn hud" onClick={close}>cancel</button>
          <button className="btn hud p" disabled={work} onClick={go}>{work ? '…' : chat ? 'save' : 'create'}</button>
        </div>
      </div>
    </div>
  )
}

/* Where downloads land, and the one-way backup of a local folder (or the phone's camera
   roll) up to the server. The upload itself is the same streaming path everything else uses. */
function Storage ({ say }) {
  const [dir, setDir] = useState('')
  const [s, setS] = useState(loadSync)
  const [run, setRun] = useState(null)
  const stop = useRef(null)

  useEffect(() => { if (IS_DESKTOP) getDownloadDir().then(setDir).catch(() => {}) }, [])
  const patch = p => { const n = { ...s, ...p }; setS(n); saveSync(n) }

  const go = async () => {
    const target = (s.target || '').trim()
    if (!validTarget(target)) { say('target must be a folder inside files/', true); return }
    if (IS_DESKTOP && !s.dir) { say('pick a folder to back up first', true); return }
    stop.current = new AbortController()
    setRun('starting…')
    try {
      if (PLATFORM === 'android') await requestMedia()
      const r = await runSync({ ...s, target }, {
        onFile: (name, i, n) => setRun(`${i + 1}/${n} · ${name}`),
        signal: stop.current.signal,
      })
      say(`backup · ${r.sent} sent${r.skipped ? ', ' + r.skipped + ' already there' : ''}${r.failed ? ', ' + r.failed + ' failed' : ''}`, !!r.failed)
      setS(loadSync())
    } catch (e) { say(String(e.message || e), true) } finally { setRun(null); stop.current = null }
  }

  return (
    <>
      <div className="h2">storage</div>
      {IS_DESKTOP && (
        <>
          <div className="lab">downloads land in</div>
          <div className="row">
            <span className="note grow" title={dir}>{dir || '…'}</span>
            <button className="btn hud" onClick={() => setDownloadDir().then(d => d && setDir(d))}>change</button>
          </div>
        </>
      )}

      <div className="lab">back up {PLATFORM === 'android' ? 'the gallery' : IS_DESKTOP ? 'a folder' : 'nothing — desktop or android only'}</div>
      {IS_DESKTOP && (
        <div className="row">
          <span className="note grow" title={s.dir}>{s.dir || 'no folder picked'}</span>
          <button className="btn hud" onClick={() => pickDir().then(d => d && patch({ dir: d }))}>pick</button>
        </div>
      )}
      <input className="field hud" value={s.target || ''} placeholder="files/phone"
        onChange={e => patch({ target: e.target.value })} />
      <div className="row">
        <button className="btn hud" onClick={() => patch({ done: {}, last: 0 })}>forget history</button>
        <span className="grow" />
        {run
          ? <button className="btn hud x" onClick={() => stop.current && stop.current.abort()}>stop</button>
          : <button className="btn hud p" onClick={go}>back up now</button>}
      </div>
      {run && <div className="note">{run}</div>}
      <div className="note">One way, newest first. A file already sent is skipped by name, size and date.</div>
    </>
  )
}

function Setup ({ cfg, applyCfg, ts, status, setStatus, say, close }) {
  const [url, setUrl] = useState(cfg.base || '')
  const [me, setMe] = useState(cfg.me || '')
  const [pass, setPass] = useState(cfg.pass || '')
  const [scan, setScan] = useState(null)

  const test = async b => {
    setScan('testing ' + b)
    const hit = await dav.detect([b])
    if (hit) { applyCfg({ ...dav.getCfg(), base: hit, me: me.trim() || cfg.me }); setStatus('ok'); await ensureRoot().catch(() => {}); setScan('ok · ' + hit); say('endpoint set') } else setScan('no answer · ' + b)
  }
  const rescan = async () => {
    setScan('scanning…')
    const hit = await dav.detect(dav.candidates())
    if (hit) { applyCfg({ ...dav.getCfg(), base: hit }); setUrl(hit); setStatus('ok'); await ensureRoot().catch(() => {}); setScan('found · ' + hit) } else { setStatus('fail'); setScan('nothing answered') }
  }

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="sheet hud">
        <div className="h2">setup</div>

        <div className="row">
          <span className="lab grow">theme</span>
          <button className="btn hud" onClick={() => applyCfg({ ...dav.getCfg(), light: !cfg.light })}>{cfg.light ? 'light ◐' : 'dark ◑'}</button>
        </div>

        <div className="lab">display name</div>
        <input className="field hud" value={me} onChange={e => setMe(e.target.value)} placeholder="my-pc"
          onBlur={() => applyCfg({ ...dav.getCfg(), me: me.trim() || cfg.me })} />

        <div className="lab">nextcloud password</div>
        <input className="field hud" type="password" value={pass} placeholder="required" onChange={e => setPass(e.target.value)}
          onBlur={() => pass !== cfg.pass && applyCfg({ ...dav.getCfg(), pass })}
          onKeyDown={e => e.key === 'Enter' && applyCfg({ ...dav.getCfg(), pass })} />
        {!cfg.pass && <div className="note">This stays on this device only. It is never built into the app.</div>}

        <div className="lab">endpoint · {status}</div>
        <input className="field hud" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://host:8080/remote.php/dav/files/transferapp/file-transfer-app" />
        <div className="row">
          <button className="btn hud" onClick={rescan}>auto-detect</button>
          <button className="btn hud p" onClick={() => test(url.replace(/\/+$/, ''))}>use this</button>
        </div>
        {scan && <div className="note">{scan}</div>}

        <div className="h2">tailscale</div>
        {!ts && <div className="note">{PLATFORM === 'desktop' ? 'tailscale cli not found — type the endpoint above' : 'peer list is desktop-only — type the endpoint above'}</div>}
        {ts && (
          <>
            <div className="note">tailnet <b>{ts.tailnet}</b> · this device <b>{ts.self}</b> ({ts.selfIp}) · {ts.state}</div>
            <div className="lab">pick the host that runs nextcloud</div>
            {ts.peers.map(p => (
              <button key={p.ip} className="peer hud" onClick={() => { const b = `http://${p.ip}:${cfg.port}${cfg.davPath}`; setUrl(b); test(b) }}>
                <span className={'st' + (p.online ? ' up' : '')} />
                <span className="grow">{p.host.split('.')[0]}</span>
                <span className="tag-n">{p.ip}</span>
              </button>
            ))}
          </>
        )}

        <Storage say={say} />

        <div className="h2">shortcut</div>
        <div className="note">
          Ctrl+Insert shows / hides the window, and it opens on the tray icon.<br />
          KDE on Wayland blocks both: bind Ctrl+Ins to the <b>tsdrop</b> command in System Settings → Shortcuts.
        </div>

        <div className="row"><span className="grow" /><button className="btn hud p" onClick={close}>close</button></div>
      </div>
    </div>
  )
}
