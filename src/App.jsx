import { useEffect, useMemo, useRef, useState, Fragment } from 'react'
import * as dav from './dav'
import * as C from './crypto'
import Attachment, { Lightbox, mkey, dropCache } from './Media.jsx'
import LinkCard from './Link.jsx'
import Menu from './Menu.jsx'
import Sheet from './Sheet.jsx'
import Vault from './Vault.jsx'
import Icon, { Logo } from './Icon.jsx'
import { Dialog, Switch, Seg, serverOf, ACCENTS, accentOf, iconOfName } from './ui.jsx'
import * as vault from './vault'
import { chatTree, reorder } from './tree'
import {
  ensureRoot, loadChats, createChat, saveChat, deleteChat,
  syncMessages, sendMessage, updateMessage, deleteMessage, cached,
  hashtags, search, fmtSize, KINDS, linksIn, allTags, moveMessages, kindOf, backfillThumb,
  getKey, hasKey, setKey, forgetKey, purgeStoredKeys, locked, readable, containerUse,
} from './store'
import { PLATFORM, IS_DESKTOP, pickFiles, pasteFiles, clipboardImage, dropFiles, tailscale, reveal, hideWindow, ensureStorage, copyText, pickDir, getDownloadDir, setDownloadDir, requestMedia, shareTo, CAN_SHARE, desktopTheme, onDesktopTheme } from './bridge'
import * as omarchy from './omarchy'
import * as offsite from './offsite'
import { filesOf, textOf, saveAll } from './share'
import { loadSync, saveSync, runSync, validTarget } from './sync'

// how many messages are on screen at once. Every one of them mounts its tiles and its
// observers, so an old container used to build the whole history before it drew anything.
const PAGE = 50

/* Below this the container list is a drawer behind the menu button, above it a column of its
   own (hud.css, .app.narrow). Measured here rather than with a CSS media query: a frameless
   window dragged wider by its right edge does not always re-evaluate one, so the list kept
   hiding in a window with room for it. 850 leaves the chat ~670px beside the 168px column. */
const NARROW = 850
/* Android has no top bar: the container header carries the menu, search, codes and settings,
   so the container name sits at the very top of the screen. */
const PHONE = PLATFORM === 'android'
const widthNow = el => Math.max(el ? el.getBoundingClientRect().width : 0,
  typeof window !== 'undefined' ? window.innerWidth || 0 : 0,
  typeof document !== 'undefined' ? document.documentElement.clientWidth || 0 : 0)
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
  const [findOpen, setFindOpen] = useState(false)   // phone: the search row under the header
  const [narrow, setNarrow] = useState(() => widthNow() < NARROW)
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
  const [desk, setDesk] = useState(null)
  const [mode, setMode] = useState(() => localStorage.getItem('tsdrop.view') === 'gallery' ? 'gallery' : 'chat')
  const [picking, setPicking] = useState(null)      // the one message whose text is selectable on a phone
  const [conn, setConn] = useState(0)               // bumped to run the connect sequence again
  const [megaAt, setMegaAt] = useState(0)            // time of the MEGA snapshot being read, 0 = not reading one
  const megaPin = useRef(false)                      // opened by hand in Settings: stay until "Back to the server"
  const streamRef = useRef(null); const qRef = useRef(null); const taRef = useRef(null)
  const appRef = useRef(null)

  const applyCfg = c => { dav.setCfg(c); setCfgState(c) }
  const say = (m, err) => { setToast({ m, err }); setTimeout(() => setToast(t => (t && t.m === m ? null : t)), err ? 7000 : 3500) }
  const me = cfg.me || 'device'
  const theme = cfg.theme || (cfg.light ? 'light' : desk ? 'auto' : 'dark')
  const chat = chats.find(c => c.id === cid)
  const shut = !!(chat && locked(chat) && !hasKey(chat.id))
  const chatKey = chat && !shut ? getKey(chat.id) : null
  const searching = !!(q || tags.length || kind !== 'all')

  /* Three sources, because no single one is trustworthy everywhere: ResizeObserver fires
     on the element's own box (the one that must hold both columns), and resize /
     orientationchange cover a viewport that changed without the box being re-observed. */
  useEffect(() => {
    const read = () => setNarrow(widthNow(appRef.current) < NARROW)
    read()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : null
    if (ro) { ro.observe(document.documentElement); if (appRef.current) ro.observe(appRef.current) }
    window.addEventListener('resize', read)
    window.addEventListener('orientationchange', read)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
    }
  }, [])
  // the drawer and its shade are a narrow-window thing; the column replaces them
  useEffect(() => { if (!narrow) setSideOpen(false) }, [narrow])

  /* 'auto' wears the desktop's own theme and follows it when it changes; the other
     two are the app's own palettes, for a desktop that has no theme to report. */
  useEffect(() => { desktopTheme().then(setDesk); onDesktopTheme(setDesk) }, [])
  useEffect(() => {
    if (theme === 'auto' && desk) return
    omarchy.clear()
    document.documentElement.classList.toggle('light', theme === 'light')
  }, [theme, desk])
  useEffect(() => { if (theme === 'auto' && desk) omarchy.apply(desk) }, [theme, desk])
  useEffect(() => { if (cid) localStorage.setItem('tsdrop.cid', cid) }, [cid])
  useEffect(() => { localStorage.setItem('tsdrop.direct', direct ? '1' : '0') }, [direct])
  useEffect(() => { localStorage.setItem('tsdrop.view', mode) }, [mode])
  useEffect(() => { setPicking(null) }, [cid])
  useEffect(() => { if (cid && !all[cid]) setAll(a => ({ ...a, [cid]: cached(cid) })) }, [cid])
  useEffect(() => { setSel([]); setEditMsg(null); setZoom(null); setLimit(PAGE); dropCache() }, [cid])
  useEffect(() => { setLimit(PAGE) }, [q, tags, kind, scope])

  useEffect(() => {
    // no server password: a fresh device. If it has the MEGA details (typed in by hand), it
    // can still read the backup; otherwise Settings is the only place to go.
    if (!dav.ready() && !offsite.saved()) { setStatus('fail'); setModal('setup'); say('Enter the server password in Settings, or the MEGA backup details', true); return }
    let live = true
    ;(async () => {
      const base = megaPin.current || !dav.ready() ? null : await dav.detect()
      if (!live) return
      if (!base) {
        if (!offsite.saved()) { setStatus('fail'); say('No server answered. Open Settings to check the address.', true); return }
        // no server: the last MEGA snapshot, read only
        if (!dav.offsite()) {
          setStatus('wait')
          if (!megaPin.current) say('No server answered · opening the MEGA backup')
          const v = await offsite.connect()
          if (!live) return
          dav.setOffsite(v)
          setMegaAt(v.time)
        }
        setStatus('mega')
        const cs = await loadChats()
        if (!live) return
        setChats(cs)
        setCid(c => (cs.some(x => x.id === c) ? c : (cs[0] || {}).id))
        return
      }
      if (dav.offsite()) { dav.setOffsite(null); setMegaAt(0); say('Back on the server') }
      applyCfg({ ...dav.getCfg(), base })
      setStatus('ok')
      await ensureRoot()
      // the MEGA link and password, kept on this device for the day no server answers
      dav.getJson('.offsite.json').then(offsite.remember).catch(() => {})
      let cs = await loadChats()
      if (!cs.length) cs = [await createChat('GENERAL', ACCENTS[0])]
      if (!live) return
      setChats(cs)
      setCid(c => (cs.some(x => x.id === c) ? c : cs[0].id))
    })().catch(e => {
      const pinned = megaPin.current
      if (dav.offsite() || pinned) { dav.setOffsite(null); setMegaAt(0); megaPin.current = false }
      say(String(e.message || e), true)
      // opened by hand and it failed: go straight back to the server rather than sit offline
      if (pinned) setConn(n => n + 1); else setStatus('fail')
      // no server password either: Settings is the only way forward
      if (!dav.ready()) setModal('setup')
    })
    return () => { live = false }
  }, [cfg.pass, conn])

  /* The server can go away mid-session (and come back). Offline, look again every 20s; online,
     once a minute ask whether a better server answers - the built-in order puts Proxmox before
     the laptop copy, so this both falls over to the laptop and comes home again by itself. */
  useEffect(() => {
    if (!dav.ready()) return
    if (status === 'fail' || (status === 'mega' && !megaPin.current)) {
      const h = setInterval(async () => { if (await dav.detect()) setConn(n => n + 1) }, 20000)
      return () => clearInterval(h)
    }
    if (status !== 'ok') return
    const h = setInterval(async () => {
      const was = dav.getCfg().base
      const best = await dav.detect()
      if (!best) { setStatus('fail'); return }
      if (best !== was) {
        applyCfg({ ...dav.getCfg(), base: best })
        say(serverOf(best) === 'laptop' ? 'The server is unreachable · switched to the laptop copy' : 'Back on the server', serverOf(best) === 'laptop')
      }
    }, 60000)
    return () => clearInterval(h)
  }, [status])

  useEffect(() => { ensureStorage() }, [])
  useEffect(() => { tailscale().then(t => { setTs(t); if (t && t.self && !dav.getCfg().me) applyCfg({ ...dav.getCfg(), me: t.self.split('.')[0] }) }) }, [])

  useEffect(() => {
    if ((status !== 'ok' && status !== 'mega') || !cid || !chat) return
    let live = true
    const tick = () => syncMessages(cid, chat).then(l => live && setAll(a => ({ ...a, [cid]: l }))).catch(e => { if (status === 'mega') say(String(e.message || e), true) })
    tick(); if (status === 'mega') return () => { live = false }    // a snapshot does not change
    const h = setInterval(tick, 3000)
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
      // the vault keeps its own, much shorter fuse, and burns it even with its pane closed
      if (vault.idle() > vault.IDLE_MS) vault.lock()
      if (Date.now() - last < IDLE_MS) return
      let any = false
      for (const c of chats) if (hasKey(c.id)) { forgetKey(c.id); any = true }
      if (any) setUnlocks(n => n + 1)
    }, 60000)
    return () => { events.forEach(e => window.removeEventListener(e, bump)); clearInterval(h) }
  }, [chats])

  useEffect(() => {
    if (status !== 'ok' && status !== 'mega') return
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
    tick().catch(() => {})
    if (status === 'mega') return () => { live = false }
    const h = setInterval(() => tick().catch(() => {}), 20000)
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
      if (p) {
        const m = 'saved · ' + f.name
        setToast({ m, path: p })
        setTimeout(() => setToast(t => (t && t.m === m ? null : t)), 10000)
      }
    } catch (e) {
      const msg = String(e.message || e)
      const gone = /HTTP (404|410)/.test(msg)
      say(f.src
        ? (gone ? `${f.src.dev || 'that device'} no longer shares this file` : `${f.src.dev || 'that device'} is offline — open TSDROP there`)
        : (gone ? 'that file is no longer on the cloud' : msg), true)
    } finally { setBusy(null) }
  }

  const copy = m => copyText(m.text || (m.files || []).map(f => f.name).join('\n'))
    .then(() => say('Copied')).catch(() => say('Copy failed', true))
  /* On a phone a long-press opens the message menu, not a native selection (message text is
     not selectable there - a long-press used to start one and the menu at the same time).
     "Select text" makes this one message selectable and selects it, so the system's own
     copy/share toolbar takes over. */
  const selectText = m => {
    setPicking(m.id)
    setTimeout(() => {
      const el = document.querySelector('#m-' + CSS.escape(m.id) + ' .mtext')
      if (!el) return
      const r = document.createRange(); r.selectNodeContents(el)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    }, 30)
  }

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
    setBusy({ label: `Moving ${list.length} to ${to.name}`, loaded: 0, total: 0 })
    try {
      for (const [fromId, group] of Object.entries(list.reduce((a, m) => ({ ...a, [m.chat]: [...(a[m.chat] || []), m] }), {}))) {
        await moveMessages(group, chats.find(c => c.id === fromId), to)
      }
      say(`Moved ${list.length} to ${to.name}`)
    } catch (e) { say(String(e.message || e), true) }
    finally { setBusy(null); new Set([...list.map(m => m.chat), toId]).forEach(refresh) }
  }

  /* The key belongs to the container, not to the selection: in ALL scope a pick can hold
     files from several containers, each with its own (or no) password. */
  const keyOf = id => { const k = getKey(id); return k ? C.b64(k) : null }

  /** Save every file of these messages into one folder. Desktop asks which one; android
      drops them where downloads already go. Returns the paths that landed. */
  async function saveMany (list, quiet) {
    const files = filesOf(list)
    if (!files.length) { say('no files in that selection'); return [] }
    const dir = IS_DESKTOP ? await pickDir() : null
    if (IS_DESKTOP && !dir) return []
    setSel([])
    setBusy({ label: 'saving', loaded: 0, total: 0 })
    try {
      const paths = await saveAll(files, keyOf, setBusy, dir)
      if (!quiet) {
        const m = `saved ${paths.length}/${files.length} file(s)`
        setToast({ m, path: paths[0] })
        setTimeout(() => setToast(t => (t && t.m === m ? null : t)), 10000)
      }
      return paths
    } catch (e) { say(String(e.message || e), true); return [] } finally { setBusy(null) }
  }

  /** Hand the selection to the OS share sheet (telegram, signal, mail…). Desktop has no
      such sheet, so there it saves into a folder and opens it for a drag into telegram. */
  async function shareMany (list) {
    const text = textOf(list)
    const files = filesOf(list)
    try {
      if (!files.length) {
        if (await shareTo([], text)) { setSel([]); return }
        await copyText(text); setSel([]); return say('text copied — paste it into telegram')
      }
      if (!CAN_SHARE) {
        const paths = await saveMany(list, true)
        if (!paths.length) return
        if (text) await copyText(text).catch(() => {})
        reveal(paths[0])
        return say(`${paths.length} file(s) saved — drag them into telegram`)
      }
      const paths = await saveMany(list, true)
      if (paths.length) await shareTo(paths, text)
    } catch (e) { say(String(e.message || e), true) }
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
    const got = await dropFiles(list)
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

  const where = serverOf(cfg.base)
  const megaWhen = megaAt ? new Date(megaAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
  const stat = status === 'mega' ? ['warn', 'MEGA backup', `Reading the MEGA backup from ${megaWhen}. Read only.`]
    : status === 'ok'
    ? (where === 'laptop' ? ['warn', 'Laptop copy', 'The server is unreachable; working from the laptop copy'] : ['ok', 'Server', 'Connected to the server'])
    : status === 'wait' ? ['', 'Connecting', 'Looking for the server'] : ['bad', 'Offline', 'No server answered. Open Settings to check the address.']
  const pd = e => e.preventDefault()
  const msgMenu = (e, m) => { e.preventDefault(); setMmenu({ x: e.clientX, y: e.clientY, m }) }

  const clearFind = () => { setQ(''); setTags([]); setKind('all') }
  const searchBox = (
    <div className="q hud">
      <Icon n="search" size={15} />
      <input ref={qRef} value={q} onChange={e => setQ(e.target.value)} aria-label="Search" autoFocus={PHONE}
        placeholder={scope === 'all' ? 'Search all containers' : 'Search this container'} />
      {searching && <button className="mb" title="Clear search" onClick={clearFind}><Icon n="x" size={14} /></button>}
      <Seg value={scope} onChange={setScope} label="Search in" options={[['chat', 'Here'], ['all', 'All']]} />
    </div>
  )
  // closing the phone's search row also drops the search, or the list stays filtered unseen
  const toggleFind = () => { if (findOpen || searching) { setFindOpen(false); clearFind() } else setFindOpen(true) }

  return (
    <div className={'app' + (narrow ? ' narrow' : '') + (PHONE ? ' phone' : '')} ref={appRef}>
      {!PHONE && <div className="top hud flat">
        <button className="icobtn menu" onClick={() => setSideOpen(v => !v)} title="Containers" aria-label="Containers"><Icon n="menu" size={18} /></button>
        <div className="brand" title={ts && ts.tailnet ? ts.tailnet : ''}><Logo size={20} /><b>TSDROP</b></div>
        {searchBox}
        <button className={'stat ' + stat[0]} onClick={() => setModal('setup')} title={stat[2]}><i /><span>{stat[1]}</span></button>
        <button className="icobtn" onClick={() => setModal('vault')} title="Authenticator · 2FA codes" aria-label="Authenticator"><Icon n="shield" size={18} /></button>
        <button className="icobtn" onClick={() => setModal('setup')} title="Settings" aria-label="Settings"><Icon n="settings" size={18} /></button>
        {IS_DESKTOP && <button className="icobtn x" onClick={hideWindow} title="Hide · Ctrl+Insert" aria-label="Hide"><Icon n="x" size={18} /></button>}
      </div>}

      {sideOpen && <div className="sideshade" onPointerDown={() => setSideOpen(false)} />}

      <div className={'side hud' + (sideOpen ? ' open' : '')}
        onClick={e => { if (sideOpen && (e.target === e.currentTarget || e.target.matches('.chats,.chips'))) setSideOpen(false) }}>
        <div className="sec">Containers<span className="grow" />
          <button className="icobtn" title="New container" aria-label="New container" onClick={() => setModal({ edit: null })}><Icon n="plus" size={16} /></button>
        </div>
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
          {!!tagCloud.length && <div className="sec">Tags</div>}
          <div className="chips" style={{ padding: '0 4px' }}>
            {tagCloud.map(([t]) => (
              <button key={t} className={'chip hud' + (tags.includes(t) ? ' on' : '')} aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="main hud" onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false) }} onDrop={onDrop}>
        <div className="mtop">
          {PHONE && <button className="icobtn menu" onClick={() => setSideOpen(v => !v)} title="Containers" aria-label="Containers"><Icon n="menu" size={18} /></button>}
          <div className="ttl">
            {chat && <span className="pip" style={{ color: accentOf(chat.accent) }} />}
            <b>{chat ? chat.name : 'No container'}</b>
            {chat && locked(chat) && <Icon n={shut ? 'lock' : 'unlock'} size={14} title={shut ? 'Private · locked' : 'Private · unlocked'} />}
            {!PHONE && <span className="tag-n">{searching ? `${view.length} found` : mode === 'gallery' ? `${media.length} item${media.length === 1 ? '' : 's'}` : `${view.length} message${view.length === 1 ? '' : 's'}`}</span>}
          </div>
          {!shut && <Seg value={mode} onChange={setMode} label="View" options={[['chat', narrow ? '' : 'Messages', 'chat'], ['gallery', narrow ? '' : 'Gallery', 'image']]} />}
          {!PHONE && chat && <button className="icobtn" title="Edit container" aria-label="Edit container" onClick={() => setModal({ edit: chat })}><Icon n="edit" size={16} /></button>}
          {PHONE && <>
            <button className={'icobtn' + (findOpen || searching ? ' on' : '')} onClick={toggleFind} title="Search" aria-label="Search"><Icon n="search" size={18} /></button>
            <button className="icobtn" onClick={() => setModal('vault')} title="Authenticator · 2FA codes" aria-label="Authenticator"><Icon n="shield" size={18} /></button>
            {/* settings and the connection state were two buttons to the same sheet: one now, with a dot */}
            <button className={'icobtn setst ' + stat[0]} onClick={() => setModal('setup')} title={stat[2]} aria-label={'Settings · ' + stat[1]}><Icon n="settings" size={18} /><i /></button>
          </>}
        </div>
        {PHONE && (findOpen || searching) && <div className="findrow">{searchBox}</div>}

        {status === 'ok' && where === 'laptop' && (
          <div className="banner warn"><Icon n="laptop" size={16} />
            <span><b>Working from the laptop copy.</b> The server can't be reached. You can read everything and add new things; they move to the server when it is back.</span>
          </div>
        )}
        {status === 'mega' && (
          <div className="banner warn"><Icon n="cloudUp" size={16} />
            <span><b>Reading the MEGA backup from {megaWhen}.</b> {megaPin.current ? 'Opened from Settings.' : 'No server answered.'} Read only: only containers switched to MEGA are here, and nothing can be sent until a server is back.</span>
          </div>
        )}
        {status === 'fail' && (
          <div className="banner bad"><Icon n="warn" size={16} />
            <span><b>Offline.</b> No server answered. Retrying every 20 seconds, or check the address in Settings.</span>
          </div>
        )}

        {shut ? (
          <Unlock chat={chat} say={say} onOpen={() => { setUnlocks(n => n + 1); setAll(a => ({ ...a, [chat.id]: [] })) }} />
        ) : mode === 'gallery' ? (
          <Gallery media={media} chatKey={chatKey} onZoom={openZoom} onSave={grab} />
        ) : (
          <>
          <div className="kinds">
            <Seg value={kind} onChange={setKind} label="Show" options={KINDS.map(k => [k, k])} />
          </div>
          {!!pinned.length && !searching && (
            <div className="pinbar">
              <span className="lab"><Icon n="pin" size={13} />{pinned.length}</span>
              {pinned.map(p => <button key={p.id} className="chip hud plain" onClick={() => jump(p.id)}>{cut(p.text || (p.files[0] || {}).name || 'file', 28)}</button>)}
            </div>
          )}
          {!!sel.length && (
            <div className="selbar hud">
              <span className="lab">{sel.length} selected</span>
              <button className="btn sm p" onClick={() => shareMany(selMsgs())}><Icon n="share" size={13} />Share</button>
              <button className="btn sm" onClick={() => saveMany(selMsgs())}><Icon n="download" size={13} />Save</button>
              <button className="btn sm" onClick={() => setSel(view.map(m => m.id))}><Icon n="select" size={13} />All</button>
              <button className="btn sm" onClick={() => setAsk({ kind: 'move', list: selMsgs() })}><Icon n="move" size={13} />Move</button>
              <button className="btn sm x" onClick={() => setAsk({ kind: 'del', list: selMsgs() })}><Icon n="trash" size={13} />Delete</button>
              <button className="icobtn" title="Clear selection" onClick={() => setSel([])}><Icon n="x" size={15} /></button>
            </div>
          )}
          <div className="stream" ref={streamRef}>
            {!view.length && (
              <div className="empty">
                <Icon n={searching ? 'search' : 'send'} size={28} />
                {searching ? 'Nothing matches.' : 'Nothing here yet. Send yourself a note, a link or a file.'}
              </div>
            )}
            {view.length > limit && (
              <button className="btn older" onClick={() => setLimit(n => n + PAGE)}>
                Load {Math.min(PAGE, view.length - limit)} older · {view.length - limit} left
              </button>
            )}
            {shown.map(m => (
              <div key={m.id} id={'m-' + m.id}
                className={'msg hud' + (m.author === me ? ' mine' : '') + (sel.includes(m.id) ? ' picked' : '') + (editMsg === m.id ? ' editing' : '') +
                  (picking === m.id ? ' selectable' : '') +
                  ((m.files || []).some(f => ['image', 'video'].includes(kindOf(f.name))) ? ' media' : '') +
                  ((m.files || []).filter(f => ['image', 'video'].includes(kindOf(f.name))).length === 1 ? ' one' : '')}
                onClick={e => { if (sel.length && !e.target.closest('button,input,textarea,a,img,video,audio')) pick1(m) }}
                onContextMenu={e => msgMenu(e, m)}>
                <div className="mhead">
                  <span className="who" title={clockFull(m.ts) + (m.edited ? ' · edited ' + clockFull(m.edited) : '')}>
                    <b>{m.author}</b>{clock(m.ts)}{m.edited ? ' · edited' : ''}
                    {scope === 'all' && searching && ' · ' + ((chats.find(c => c.id === m.chat) || {}).name || m.chat)}
                  </span>
                  {m.pin && <span className="pin" title="Pinned"><Icon n="pin" size={13} /></span>}
                  <span className="grow" />
                  <div className="acts">
                    <button className="mb" title="Copy text" onClick={() => copy(m)}><Icon n="copy" size={14} /></button>
                    <button className="mb keep" title="Reply" onClick={() => { setReply({ id: m.id, author: m.author, text: cut(m.text || (m.files[0] || {}).name || 'file', 60) }); taRef.current && taRef.current.focus() }}><Icon n="reply" size={14} /></button>
                    <button className="mb" title="Tags" onClick={() => setEditTags(editTags === m.id ? null : m.id)}><Icon n="tag" size={14} /></button>
                    <button className="mb x" title="Delete" onClick={() => setAsk({ kind: 'del', list: [m] })}><Icon n="trash" size={14} /></button>
                    <button className="mb keep" title="More" onClick={e => msgMenu(e, m)}><Icon n="more" size={14} /></button>
                  </div>
                </div>

                {m.reply && (
                  <button className="quote" onClick={() => jump(m.reply.id)}>
                    <b>{m.reply.author}</b>{m.reply.text}
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
                  <input className="tagin hud solo" autoFocus defaultValue={(m.tags || []).join(', ')} placeholder="Tags, comma separated"
                    onKeyDown={e => { if (e.key === 'Enter') saveTags(m, e.target.value); if (e.key === 'Escape') setEditTags(null) }}
                    onBlur={e => saveTags(m, e.target.value)} />
                ) : !!(m.tags || []).length && (
                  <div className="chips">
                    {m.tags.map(t => <button key={t} className={'chip hud' + (tags.includes(t) ? ' on' : '')} onClick={() => toggleTag(t)}>{t}</button>)}
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
        )}

        {!shut && mode === 'chat' && status !== 'mega' && (
          <div className="comp hud">
            {reply && (
              <div className="rbar">
                <Icon n="reply" size={14} />
                <span className="grow"><b>{reply.author}</b> {reply.text}</span>
                <button className="mb" title="Cancel reply" onClick={() => setReply(null)}><Icon n="x" size={14} /></button>
              </div>
            )}
            <textarea ref={taRef} rows={1} value={text} placeholder={chat ? 'Message ' + chat.name : 'Message'} aria-label="Message"
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
                  <button key={i} className="chip hud plain on" title="Remove" onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>
                    <Icon n={iconOfName(f.name, kindOf(f.name))} size={13} />{f.name} · {fmtSize(f.size)}<Icon n="x" size={12} />
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
              <button className="icobtn" title="Attach files" aria-label="Attach files" onMouseDown={pd} onClick={attach}><Icon n="clip" size={18} /></button>
              <button className="icobtn" title="Paste an image from the clipboard" aria-label="Paste image" onMouseDown={pd} onClick={pasteBtn}><Icon n="paste" size={18} /></button>
              <Seg keepFocus value={direct ? 'direct' : 'server'} label="How files travel" onChange={v => setDirect(v === 'direct')}
                options={[['server', narrow ? '' : 'Server', 'cloud'], ['direct', narrow ? '' : 'Direct', 'direct']]} />
              <TagBox value={tagDraft} onChange={setTagDraft} known={knownTags} onSend={send} />
              <button className="btn p send" disabled={!!busy || !cid} title={direct ? 'Files stay on this device until the other end pulls them' : 'Files are stored on the server'}
                onMouseDown={pd} onClick={send}><Icon n="send" size={14} />Send</button>
            </div>
          </div>
        )}

        {drag && <div className="drop"><span><Icon n="upload" size={26} />Drop to attach</span></div>}
        {toast && (
          <button className={'toast hud' + (toast.err ? ' err' : '')} onClick={() => { if (toast.path) reveal(toast.path); setToast(null) }}>
            <Icon n={toast.err ? 'warn' : 'ok'} size={16} />
            <span>{toast.m}{toast.path ? (IS_DESKTOP ? ' · click to show' : ' · tap to open') : ''}</span>
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
          !cmenu.c.parent && ['New container inside', () => setModal({ edit: null, parent: cmenu.c.id }), false, 'plus'],
          ['Edit', () => setModal({ edit: cmenu.c }), false, 'edit'],
          locked(cmenu.c) && hasKey(cmenu.c.id) && ['Lock now', () => { forgetKey(cmenu.c.id); setUnlocks(n => n + 1) }, false, 'lock'],
        ]} />
      )}

      {mmenu && (
        <Menu at={mmenu} close={() => setMmenu(null)} items={[
          ['Reply', () => { setReply({ id: mmenu.m.id, author: mmenu.m.author, text: cut(mmenu.m.text || (mmenu.m.files[0] || {}).name || 'file', 60) }); taRef.current && taRef.current.focus() }, false, 'reply'],
          ['Copy text', () => copy(mmenu.m), false, 'copy'],
          !!mmenu.m.text && ['Select text', () => selectText(mmenu.m), false, 'select'],
          ['Edit text', () => setEditMsg(mmenu.m.id), false, 'edit'],
          [mmenu.m.pin ? 'Unpin' : 'Pin', () => patch(mmenu.m, { pin: !mmenu.m.pin }), false, 'pin'],
          ['Tags', () => setEditTags(mmenu.m.id), false, 'tag'],
          [sel.includes(mmenu.m.id) ? 'Deselect' : 'Select message', () => pick1(mmenu.m), false, 'check'],
          ['Share', () => shareMany(sel.length ? selMsgs() : [mmenu.m]), false, 'share'],
          ['Move to…', () => setAsk({ kind: 'move', list: sel.length ? selMsgs() : [mmenu.m] }), false, 'move'],
          ['Delete', () => setAsk({ kind: 'del', list: sel.length ? selMsgs() : [mmenu.m] }), true, 'trash'],
        ]} />
      )}

      {ask && ask.kind === 'del' && (
        <Confirm n={ask.list.length} close={() => setAsk(null)} onYes={() => dropMany(ask.list)} />
      )}
      {ask && ask.kind === 'move' && (
        <MoveTo n={ask.list.length} chats={chats} from={cid} close={() => setAsk(null)} onPick={id => moveMany(ask.list, id)} />
      )}

      {modal === 'vault' && <Vault say={say} close={() => setModal(null)} />}
      {modal === 'setup' && <Setup chats={chats} cfg={cfg} applyCfg={applyCfg} ts={ts} status={status} setStatus={setStatus} say={say} theme={theme} desk={desk} close={() => setModal(null)}
        mega={{
          at: megaAt,
          open: () => { megaPin.current = true; setModal(null); setConn(n => n + 1) },
          // typed-in details, already checked: show that snapshot without unlocking it again.
          // With a server password this is a deliberate visit, so pin it like open(); without
          // one there is no server to go back to, and entering a password later leaves MEGA.
          adopted: v => { dav.setOffsite(v); setMegaAt(v.time); megaPin.current = dav.ready(); setModal(null); setConn(n => n + 1) },
          leave: () => { megaPin.current = false; setConn(n => n + 1) },
        }} />}
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

/* Photos and videos of the open container as a plain grid, newest first, by month - the
   phone-gallery view. Tiles are the same thumbnails the messages use, so nothing extra is
   downloaded, and a tap opens the same full-size viewer. */
function Gallery ({ media, chatKey, onZoom, onSave }) {
  const groups = useMemo(() => {
    const out = []
    let cur = null
    for (const f of [...media].reverse()) {
      const d = new Date(f.msg.ts)
      const k = d.getFullYear() * 12 + d.getMonth()
      if (!cur || cur.k !== k) {
        cur = { k, label: d.toLocaleDateString([], { month: 'long', year: 'numeric' }), items: [] }
        out.push(cur)
      }
      cur.items.push(f)
    }
    return out
  }, [media])
  if (!media.length) {
    return <div className="stream"><div className="empty"><Icon n="image" size={28} />No photos or videos in this container yet.</div></div>
  }
  return (
    <div className="stream gallery">
      {groups.map(g => (
        <section key={g.k}>
          <div className="gsec">{g.label}<span className="tag-n">{g.items.length}</span></div>
          <div className="ggrid">
            {g.items.map(f => <Attachment key={mkey(f)} f={f} chatKey={chatKey} onSave={onSave} onZoom={onZoom} tile />)}
          </div>
        </section>
      ))}
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
      <Icon n="tag" size={14} />
      {!!hits.length && (
        <div className="tsug hud">
          {hits.map((t, n) => (
            <button key={t} className={n === at ? 'on' : ''} onMouseDown={e => { e.preventDefault(); take(t) }}>{t}</button>
          ))}
        </div>
      )}
      <input className="tagin hud" value={value} placeholder="Tags" aria-label="Tags" onChange={e => { onChange(e.target.value); setI(0) }}
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
    <Dialog title={n === 1 ? 'Delete this message?' : `Delete ${n} messages?`} icon="trash" close={close}>
      <div className="note">The message and any file it uploaded are removed from the server. The laptop copy keeps them in its archive; nothing else can bring them back.</div>
      <div className="sfoot">
        <span className="grow" />
        <button className="btn ghost" autoFocus onClick={close}>Cancel</button>
        <button className="btn x" onClick={onYes}><Icon n="trash" size={14} />Delete</button>
      </div>
    </Dialog>
  )
}

function ChatRow ({ c, cid, takeRow, moveRow, dropRow, held, onPick, onEdit, onMenu, sub, folded, nKids, onFold }) {
  const open = locked(c) && hasKey(c.id)
  return (
    <button data-id={c.id} className={'chat hud' + (c.id === cid ? ' sel' : '') + (sub ? ' sub' : '') + (held ? ' grab' : '')}
      onClick={onPick} onDoubleClick={onEdit} aria-current={c.id === cid ? 'true' : undefined}
      onContextMenu={e => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }) }}>
      {nKids
        ? <span className={'fold' + (folded ? ' shut' : '')} style={{ color: accentOf(c.accent) }} title={folded ? 'Expand' : 'Collapse'}
            onClick={e => { e.stopPropagation(); onFold() }}><Icon n="chevD" size={14} /></span>
        : <span className="pip" style={{ color: accentOf(c.accent) }} />}
      <span className="nm">{c.name}</span>
      {!!nKids && folded && <span className="kn">{nKids}</span>}
      {c.backup && <span className="bk" title="Backed up to MEGA"><Icon n="cloudUp" size={14} /></span>}
      {locked(c) && <span className={'lk' + (open ? ' open' : '')} title={open ? 'Private · unlocked' : 'Private · locked'}><Icon n={open ? 'unlock' : 'lock'} size={13} /></span>}
      <span className="grip" title="Drag to reorder"
        onPointerDown={e => takeRow(e, c.id)} onPointerMove={moveRow} onPointerUp={dropRow} onPointerCancel={dropRow}
        onClick={e => e.stopPropagation()}><Icon n="grip" size={14} /></span>
    </button>
  )
}

function MoveTo ({ n, chats, from, onPick, close }) {
  const list = chats.filter(c => c.id !== from)
  return (
    <Dialog title={`Move ${n === 1 ? 'message' : n + ' messages'} to`} icon="move" close={close}>
      {!list.length && <div className="note">There is no other container yet.</div>}
      {list.map(c => (
        <button key={c.id} className="peer hud" onClick={() => onPick(c.id)}>
          <span className="pip" style={{ color: accentOf(c.accent) }} />
          <span className="grow">{c.name}</span>
          {locked(c) && <Icon n={hasKey(c.id) ? 'unlock' : 'lock'} size={13} />}
          <Icon n="chevR" size={14} />
        </button>
      ))}
      <div className="note">Files move on the server. Nothing is uploaded again.</div>
    </Dialog>
  )
}

function Unlock ({ chat, onOpen, say }) {
  const [pw, setPw] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    setWork(true)
    const key = await C.unlock(chat.lock, pw)
    setWork(false)
    if (!key) { say('Wrong password', true); return }
    setKey(chat.id, key)
    setPw('')
    onOpen()
  }
  return (
    <div className="lockpane">
      <div className="lockmark"><Icon n="lock" size={22} /></div>
      <div className="h2">{chat.name} is private</div>
      <div className="note">Messages and files here are encrypted on this device before they leave it. The server only ever sees ciphertext.</div>
      <input className="field hud" type="password" autoFocus value={pw} placeholder="Container password" aria-label="Container password"
        onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <button className="btn p" disabled={work || !pw} onClick={go}><Icon n="unlock" size={14} />{work ? 'Unlocking…' : 'Unlock'}</button>
      <div className="note">The key is kept in memory only. Closing the app, or 4 hours without use, locks it again.</div>
    </div>
  )
}

function ChatEdit ({ chat, chats, preset, close, onSaved, onDeleted, onLockChange, say, hasMsgs }) {
  const [name, setName] = useState(chat ? chat.name : '')
  const [parent, setParent] = useState(chat ? chat.parent || '' : preset || '')
  const [accent, setAccent] = useState(chat ? accentOf(chat.accent) : ACCENTS[0])
  const [priv, setPriv] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [mega, setMega] = useState(!!(chat && chat.backup))
  const [work, setWork] = useState(false)
  const go = async () => {
    if (priv && (!pw || pw !== pw2)) { say('The passwords do not match', true); return }
    setWork(true)
    try {
      const c = chat ? { ...chat, name: name.trim() || chat.name, accent } : await createChat(name.trim() || 'container', accent, priv ? pw : null)
      if (parent) c.parent = parent; else delete c.parent
      // Read by the server's hourly MEGA job straight from chat.json, so it stays a plain
      // field even in a private container. Absent means off.
      if (mega) c.backup = true; else delete c.backup
      if (chat || parent || mega) await saveChat(c)
      onSaved(c)
    } catch (e) { say(String(e.message || e), true); setWork(false) }
  }
  return (
    <Dialog title={chat ? 'Edit container' : 'New container'} icon="folder" close={close}>
      <div className="lab">Name</div>
      <input className="field hud" value={name} autoFocus placeholder="General" onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && go()} />

      <div className="lab">Colour</div>
      <div className="sw" role="radiogroup" aria-label="Colour">
        {ACCENTS.map(a => <button key={a} role="radio" aria-checked={a === accent} className={a === accent ? 'on' : ''} style={{ background: a }} onClick={() => setAccent(a)} />)}
      </div>

      <div className="lab">Inside</div>
      <select className="field hud" value={parent} onChange={e => setParent(e.target.value)}>
        <option value="">Top level</option>
        {chats.filter(x => !x.parent && (!chat || (x.id !== chat.id && !chats.some(y => y.parent === chat.id)))).map(x => (
          <option key={x.id} value={x.id}>{x.name}</option>
        ))}
      </select>

      <div className="card">
        <Switch on={mega} onChange={setMega} label="Back up to MEGA"
          sub={mega
            ? 'Every hour, encrypted on the server before it leaves. Messages and attachments of this container.'
            : 'Off. Kept on the server, the laptop copy and the USB disk. Nothing leaves the house.'} />
      </div>

      {!chat && (
        <div className="card">
          <Switch on={priv} onChange={setPriv} label="Private"
            sub={priv ? 'Encrypted on each device with this password. Lose it and the content is gone, there is no recovery.' : 'Anyone with the server password can read it.'} />
          {priv && (
            <>
              <input className="field hud" type="password" value={pw} placeholder="Password" onChange={e => setPw(e.target.value)} />
              <input className="field hud" type="password" value={pw2} placeholder="Repeat password" onChange={e => setPw2(e.target.value)} />
            </>
          )}
        </div>
      )}
      {chat && locked(chat) && (
        <div className="card">
          <div className="note"><b>Private container.</b> Encryption is set when a container is created; to change the password, make a new private container and move the messages.</div>
          {hasKey(chat.id) && <div><button className="btn" onClick={() => { forgetKey(chat.id); onLockChange(); close() }}><Icon n="lock" size={14} />Lock now</button></div>}
        </div>
      )}
      {chat && !locked(chat) && hasMsgs && <div className="note">Encryption can only be turned on for a new container.</div>}

      <div className="sfoot">
        {chat && <button className="btn ghost" onClick={() => { if (confirm('Delete this container and every file in it?')) deleteChat(chat.id).then(() => onDeleted(chat.id)).catch(e => say(String(e.message), true)) }}><Icon n="trash" size={14} />Delete</button>}
        <span className="grow" />
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn p" disabled={work} onClick={go}>{work ? 'Saving…' : chat ? 'Save' : 'Create'}</button>
      </div>
    </Dialog>
  )
}

/* Where downloads land, and the one-way backup of a local folder (or the phone's camera
   roll) up to the server. The upload itself is the same streaming path everything else uses. */
function Storage ({ say, status }) {
  const [dir, setDir] = useState('')
  const [s, setS] = useState(loadSync)
  const [run, setRun] = useState(null)
  const stop = useRef(null)

  useEffect(() => { if (IS_DESKTOP) getDownloadDir().then(setDir).catch(() => {}) }, [])
  const patch = p => { const n = { ...s, ...p }; setS(n); saveSync(n) }

  const go = async () => {
    const target = (s.target || '').trim()
    if (!validTarget(target)) { say('The target must be a folder inside files/', true); return }
    if (IS_DESKTOP && !s.dir) { say('Pick a folder to back up first', true); return }
    stop.current = new AbortController()
    setRun('starting…')
    try {
      if (PLATFORM === 'android') await requestMedia()
      const r = await runSync({ ...s, target }, {
        onFile: (name, i, n) => setRun(`${i + 1} of ${n} · ${name}`),
        signal: stop.current.signal,
      })
      say(`Backup done · ${r.sent} sent${r.skipped ? ', ' + r.skipped + ' already there' : ''}${r.failed ? ', ' + r.failed + ' failed' : ''}`, !!r.failed)
      setS(loadSync())
    } catch (e) { say(String(e.message || e), true) } finally { setRun(null); stop.current = null }
  }

  return (
    <>
      {IS_DESKTOP && (
        <div className="card">
          <div className="lab">Downloads go to</div>
          <div className="row">
            <Icon n="folder" size={15} />
            <span className="note grow" title={dir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dir || '…'}</span>
            <button className="btn sm" onClick={() => setDownloadDir().then(d => d && setDir(d))}>Change</button>
          </div>
        </div>
      )}

      {(IS_DESKTOP || PLATFORM === 'android') && <div className="card">
        <div className="lab">Back up {PLATFORM === 'android' ? 'the phone gallery' : 'a folder'} to the server</div>
        {IS_DESKTOP && (
          <div className="row">
            <Icon n="folder" size={15} />
            <span className="note grow" title={s.dir} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.dir || 'No folder picked'}</span>
            <button className="btn sm" onClick={() => pickDir().then(d => d && patch({ dir: d }))}>Pick</button>
          </div>
        )}
        <input className="field hud" value={s.target || ''} placeholder="files/phone" aria-label="Server folder"
          onChange={e => patch({ target: e.target.value })} />
        <div className="row">
          <button className="btn ghost sm" onClick={() => patch({ done: {}, last: 0 })}>Forget history</button>
          <span className="grow" />
          {run
            ? <button className="btn x sm" onClick={() => stop.current && stop.current.abort()}>Stop</button>
            : <button className="btn p sm" onClick={go}><Icon n="upload" size={13} />Back up now</button>}
        </div>
        {run && <div className="note">{run}</div>}
        <div className="note">One way, newest first. A file already sent is skipped by name, size and date.</div>
      </div>}

      <MegaFolders say={say} status={status} />
    </>
  )
}

/* Reading the MEGA copy back. The link and password normally come from the server
   (offsite.js), so there is nothing to type: this says whether this device has them, and
   lets you open the backup by hand to see that it works before the day it has to.
   A device that never met the server - a new phone after the server is gone - can type
   them in instead; they are checked against the backup before they are kept. */
function MegaRead ({ status, mega, say }) {
  const have = !!offsite.saved()
  const when = mega.at ? new Date(mega.at).toLocaleString() : ''
  const [typing, setTyping] = useState(false)
  const [link, setLink] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const form = typing || (!have && status !== 'mega')

  const go = async () => {
    const bad = offsite.linkProblem(link)
    if (bad) { setErr(bad); return }
    if (!pw) { setErr('Type the backup password'); return }
    setBusy(true); setErr('')
    try {
      const v = await offsite.adopt({ link, password: pw })
      setPw(''); setTyping(false)
      say('MEGA backup opened · the details are saved on this device')
      mega.adopted(v)
    } catch (e) {
      setErr(String(e.message || e))
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="note">
        {status === 'mega' ? <>Showing the snapshot from <b>{when}</b>. Only containers, folders and the vault switched to MEGA are in it.</>
          : have ? 'This device has the read-only link to the backup. If no server answers, TSDROP opens the newest MEGA snapshot by itself: what is switched to MEGA, read only.'
            : 'This device has no link to the backup yet. It arrives from the server once the server is set up for it, or type it in below.'}
      </div>
      {form && <>
        <div className="lab">MEGA folder link</div>
        <input className="field hud" value={link} onChange={e => { setLink(e.target.value); setErr('') }} placeholder="https://mega.nz/folder/…#…"
          autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} />
        <div className="lab">Backup password</div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="field hud" type={show ? 'text' : 'password'} value={pw} placeholder="The restic password" disabled={busy}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            onChange={e => { setPw(e.target.value); setErr('') }} onKeyDown={e => e.key === 'Enter' && !busy && go()} />
          <button className="icobtn" title={show ? 'Hide password' : 'Show password'} onClick={() => setShow(v => !v)}><Icon n="eye" size={16} /></button>
        </div>
        {err && <div className="note" role="alert" style={{ color: 'var(--danger)' }}>{err}</div>}
        {busy && <div className="note">Checking the backup… the first unlock takes a few seconds.</div>}
      </>}
      <div className="row">
        {form
          ? <>
            <button className="btn p sm" onClick={go} disabled={busy}><Icon n="cloudUp" size={13} />{busy ? 'Opening…' : 'Open this backup'}</button>
            {have && <button className="btn sm" onClick={() => { setTyping(false); setErr(''); setPw('') }} disabled={busy}>Cancel</button>}
          </>
          : <>
            {status === 'mega'
              ? <button className="btn sm" onClick={mega.leave}><Icon n="server" size={13} />Back to the server</button>
              : have && <button className="btn sm" onClick={mega.open}><Icon n="cloudUp" size={13} />Open the MEGA backup</button>}
            <button className="btn sm" onClick={() => setTyping(true)}>Enter details by hand</button>
          </>}
      </div>
    </div>
  )
}

/* Which top-level folders in files/ also go to MEGA. Off unless switched on here. The switch
   is a hidden .tsbackup marker in the folder (listDir skips dot-files), which the server's
   hourly MEGA job looks for. Containers and the vault have their own switches. */
function MegaFolders ({ say, status }) {
  const [rows, setRows] = useState(null)
  // the list lives on the server (or in the MEGA snapshot); with neither there is nothing to ask
  const reach = status === 'ok' || status === 'mega'
  useEffect(() => {
    if (!reach) return
    let live = true
    ;(async () => {
      const dirs = (await dav.propfind('files', 1)).filter(r => r.isDir && !r.name.startsWith('.'))
      const out = await Promise.all(dirs.map(async d => ({ name: d.name, on: !!(await dav.getJson(`files/${d.name}/.tsbackup`)) })))
      if (live) setRows(out.sort((a, b) => a.name.localeCompare(b.name)))
    })().catch(e => { if (live) { setRows([]); say(String(e.message || e), true) } })
    return () => { live = false }
  }, [reach])
  const flip = async (name, on) => {
    const p = `files/${name}/.tsbackup`
    const r = on ? await dav.putJson(p, { on: true, ts: Date.now() }) : await dav.del(p)
    if (r.status >= 400 && !(r.status === 404 && !on)) { say(`MEGA switch failed (HTTP ${r.status})`, true); return }
    setRows(x => x.map(y => (y.name === name ? { ...y, on } : y)))
  }
  return (
    <div className="card">
      <div className="lab">Back up to MEGA · folders</div>
      {!reach
        ? <div className="note">Shown once a server answers.</div>
        : rows === null
        ? <div className="note">Reading folders…</div>
        : !rows.length
            ? <div className="note">No folders in files/ yet.</div>
            : rows.map(r => (
              <Switch key={r.name} on={r.on} onChange={on => flip(r.name, on)} label={r.name}
                sub={r.on ? 'Hourly to MEGA, encrypted' : 'Server, laptop copy and USB disk only'} />
            ))}
    </div>
  )
}

/* How much each container takes on the server, biggest first. Counted once per run of the app
   (a walk of every folder), kept until Recount. A sub-container counts on its own. */
let diskSeen = null
function DiskUse ({ chats }) {
  const [use, setUse] = useState(() => diskSeen || {})
  const [busy, setBusy] = useState(false)
  const count = async () => {
    setBusy(true)
    const out = {}
    // one container at a time, each walked 8 requests wide, so the list fills in as it goes
    for (const c of chats) {
      out[c.id] = await containerUse(c.id).catch(() => null)
      setUse({ ...out })
    }
    diskSeen = out
    setBusy(false)
  }
  useEffect(() => { if (!diskSeen) count() }, [])

  const name = c => { const p = c.parent && chats.find(x => x.id === c.parent); return p ? p.name + ' › ' + c.name : c.name }
  const rows = chats.filter(c => use[c.id]).sort((a, b) => use[b.id].bytes - use[a.id].bytes)
  const top = rows.length ? use[rows[0].id].bytes || 1 : 1
  const total = rows.reduce((t, c) => t + use[c.id].bytes, 0)
  return (
    <div className="card">
      <div className="row">
        <span className="lab grow">{busy ? `Counting… ${Object.keys(use).length} of ${chats.length}` : `${fmtSize(total)} in ${rows.length} container${rows.length === 1 ? '' : 's'}`}</span>
        <button className="btn sm" disabled={busy} onClick={count}><Icon n="refresh" size={14} />Recount</button>
      </div>
      {rows.map(c => (
        <div key={c.id} className="duse" title={`${use[c.id].files} file${use[c.id].files === 1 ? '' : 's'} · ${fmtSize(use[c.id].bytes - use[c.id].msgBytes)} · messages ${fmtSize(use[c.id].msgBytes)}`}>
          <div className="row">
            <span className="pip" style={{ color: accentOf(c.accent) }} />
            <span className="grow duse-n">{name(c)}</span>
            <span className="duse-f">{use[c.id].files} file{use[c.id].files === 1 ? '' : 's'}</span>
            <b>{fmtSize(use[c.id].bytes)}</b>
          </div>
          <div className="bar"><i style={{ width: Math.max(1, (use[c.id].bytes / top) * 100) + '%' }} /></div>
        </div>
      ))}
      {chats.some(c => use[c.id] === null) && <div className="note">Some containers could not be counted. Recount to try again.</div>}
    </div>
  )
}

function Setup ({ chats, cfg, applyCfg, ts, status, setStatus, say, theme, desk, close, mega }) {
  const [url, setUrl] = useState(cfg.base || '')
  const [me, setMe] = useState(cfg.me || '')
  const [pass, setPass] = useState(cfg.pass || '')
  const [show, setShow] = useState(false)
  const [scan, setScan] = useState(null)

  const test = async b => {
    setScan('Testing ' + b)
    const hit = await dav.detect([b])
    if (hit && status === 'mega') { applyCfg({ ...dav.getCfg(), base: hit, me: me.trim() || cfg.me }); mega.leave(); setScan('Connected · ' + hit) }
    else if (hit) { applyCfg({ ...dav.getCfg(), base: hit, me: me.trim() || cfg.me }); setStatus('ok'); await ensureRoot().catch(() => {}); setScan('Connected · ' + hit); say('Server address set') } else setScan('No answer from ' + b)
  }
  const rescan = async () => {
    setScan('Looking for a server…')
    const hit = await dav.detect(dav.candidates())
    if (hit && status === 'mega') { applyCfg({ ...dav.getCfg(), base: hit }); setUrl(hit); mega.leave(); setScan('Found · ' + hit) }
    else if (hit) { applyCfg({ ...dav.getCfg(), base: hit }); setUrl(hit); setStatus('ok'); await ensureRoot().catch(() => {}); setScan('Found · ' + hit) }
    else { if (status !== 'mega') setStatus('fail'); setScan('Nothing answered') }
  }
  const where = serverOf(cfg.base)
  const setTheme = next => applyCfg({ ...dav.getCfg(), theme: next, light: next === 'light' })

  return (
    <Dialog title="Settings" icon="settings" close={close}>
      <div className="h3">Connection</div>
      <div className="card">
        <div className="row">
          <Icon n={status === 'mega' ? 'cloudUp' : status !== 'ok' ? 'warn' : where === 'laptop' ? 'laptop' : 'server'} size={18} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>
              {status === 'mega' ? 'Reading the MEGA backup' : status === 'ok' ? (where === 'laptop' ? 'Working from the laptop copy' : 'Connected to the server') : status === 'wait' ? 'Connecting…' : 'Offline'}
            </div>
            <div className="note">
              {status === 'mega' ? 'Read only, frozen at the last hourly snapshot. Retrying the servers every 20 seconds.'
                : status === 'ok' && where === 'laptop' ? 'The server did not answer. New things you add here move to the server when it is back.'
                : status === 'ok' ? 'The laptop keeps a copy, updated every 5 minutes, and takes over if the server is down.'
                  : 'No server answered. Check the address and the password below.'}
            </div>
          </div>
        </div>
        <div className="lab">Server address</div>
        <input className="field hud" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://host:8090/remote.php/dav/files/transferapp/file-transfer-app" />
        <div className="row">
          <button className="btn sm" onClick={rescan}><Icon n="refresh" size={13} />Find automatically</button>
          <button className="btn p sm" onClick={() => test(url.replace(/\/+$/, ''))}>Use this address</button>
        </div>
        {scan && <div className="note">{scan}</div>}
      </div>

      <div className="h3">MEGA backup</div>
      <MegaRead status={status} mega={mega} say={say} />

      <div className="h3">This device</div>
      <div className="card">
        <div className="lab">Name shown on messages</div>
        <input className="field hud" value={me} onChange={e => setMe(e.target.value)} placeholder="my-pc"
          onBlur={() => applyCfg({ ...dav.getCfg(), me: me.trim() || cfg.me })} />
        <div className="lab">Server password</div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="field hud" type={show ? 'text' : 'password'} value={pass} placeholder="Required" onChange={e => setPass(e.target.value)}
            onBlur={() => pass !== cfg.pass && applyCfg({ ...dav.getCfg(), pass })}
            onKeyDown={e => e.key === 'Enter' && applyCfg({ ...dav.getCfg(), pass })} />
          <button className="icobtn" title={show ? 'Hide password' : 'Show password'} onClick={() => setShow(v => !v)}><Icon n="eye" size={16} /></button>
        </div>
        {!cfg.pass && <div className="note">Stays on this device only. It is never built into the app.</div>}
        <div className="lab">Appearance</div>
        <Seg value={theme} onChange={setTheme} label="Appearance"
          options={[...(desk ? [['auto', 'Desktop', 'monitor']] : []), ['dark', 'Dark', 'moon'], ['light', 'Light', 'sun']]} />
        {theme === 'auto' && desk && <div className="note">Following the desktop theme{desk.name ? ' · ' + desk.name : ''}.</div>}
      </div>

      {(ts || IS_DESKTOP) && <div className="h3">Tailscale</div>}
      {(ts || IS_DESKTOP) && (
        <div className="card">
          {!ts && <div className="note">The Tailscale command was not found on this device. Type the server address above instead.</div>}
          {ts && (
            <>
              <div className="note">Network <b>{ts.tailnet}</b> · this device <b>{ts.self}</b> ({ts.selfIp}) · {ts.state}</div>
              <div className="lab">Use a device as the server</div>
              {ts.peers.map(p => (
                <button key={p.ip} className="peer hud" onClick={() => { const b = `http://${p.ip}:${cfg.port}${cfg.davPath}`; setUrl(b); test(b) }}>
                  <span className={'st' + (p.online ? ' up' : '')} />
                  <span className="grow">{p.host.split('.')[0]}</span>
                  <span className="tag-n">{p.online ? 'online' : 'offline'} · {p.ip}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      <div className="h3">Disk use</div>
      <DiskUse chats={chats} />

      <div className="h3">Storage and backup</div>
      <Storage say={say} status={status} />

      {IS_DESKTOP && (
        <>
          <div className="h3">Shortcut</div>
          <div className="note">
            Ctrl+Insert shows and hides the window, which opens at the tray icon.
            On KDE Wayland, bind Ctrl+Insert to the <b>tsdrop</b> command in System Settings, Shortcuts.
          </div>
        </>
      )}
    </Dialog>
  )
}
