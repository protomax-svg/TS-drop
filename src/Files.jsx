import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as C from './crypto'
import * as dav from './dav'
import Attachment, { dropCache } from './Media.jsx'
import Sheet, { isTable } from './Sheet.jsx'
import Menu from './Menu.jsx'
import { fmtSize, kindOf } from './store'
import { IS_DESKTOP, pickFiles, dropPaths } from './bridge'
import {
  ROOT, ensureFilesRoot, listDir, mkdir, rename, moveTo, remove, uploadTo, recent, clearRecent,
  parentOf, crumbs, safeSeg, vaultRootOf, readVault, makeVault, openVault,
} from './files'

const lsGet = (k, d) => { try { return localStorage.getItem('tsdrop.fm.' + k) || d } catch (_) { return d } }
const lsPut = (k, v) => { try { localStorage.setItem('tsdrop.fm.' + k, v) } catch (_) {} }
const json = (k, d) => { try { return JSON.parse(lsGet(k, '')) || d } catch (_) { return d } }
const num = (k, d) => { const v = parseFloat(lsGet(k, '')); return Number.isFinite(v) ? v : d }
const setVar = (k, v) => document.documentElement.style.setProperty(k, v)
const MAINW = 635        // px kept for the chat pane; the file manager takes whatever is left
const CHATMIN = 300
const FMROOM = 460       // px the file manager pane + container list need to stay usable

const day = t => (t ? new Date(t).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—')
const home = p => p.replace(ROOT, '~')
const glyph = r => (r.isDir ? '⌸' : isTable(r.name) ? '▦' : { image: '⊞', video: '▶', audio: '▶' }[kindOf(r.name)] || '◇')
// ponytail: Media.jsx caches 24 object URLs then revokes the oldest, so only the first
// tiles get a real thumbnail. Swap for an IntersectionObserver if that starts to annoy.
const THUMBS = 20
const thumb = (r, i) => i < THUMBS && !r.isDir && /^(image|video)$/.test(kindOf(r.name))

export default function Files ({ say, onBusy, ready, onClose }) {
  const [cwd, setCwd] = useState(() => lsGet('cwd', ROOT))
  const [mode, setMode] = useState('dir')                 // 'dir' | 'recent'
  const [open, setOpen] = useState(() => new Set(json('open', [])))
  const [kids, setKids] = useState({})                    // path -> Row[], the tree cache
  const [rows, setRows] = useState([])
  const [locks, setLocks] = useState({})                  // only truthiness matters: is this a vault
  const [keys, setKeys] = useState({})                    // vaultRoot -> raw key, memory only
  const [view, setView] = useState(() => lsGet('view', 'list'))
  const [sort, setSort] = useState(() => json('sort', { k: 'name', d: 1 }))
  const [sel, setSel] = useState([])
  const [menu, setMenu] = useState(null)
  const [ask, setAsk] = useState(null)
  const [drag, setDrag] = useState(false)
  const [prog, setProg] = useState(null)
  const [preview, setPreview] = useState(null)
  const [sheet, setSheet] = useState(null)
  const [tick, setTick] = useState(0)
  const [zoom, setZoom] = useState(() => num('zoom', 1))
  const hist = useRef([])
  const anchor = useRef(null)

  /* Drag the divider: the window keeps its size, so a wider file manager means a narrower
     chat. Drag the window edge instead and only the file manager grows. */
  const grip = e => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = num('mainw', MAINW)
    const at = ev => Math.max(CHATMIN, Math.min(w0 - (ev.clientX - x0), window.innerWidth - FMROOM))
    const move = ev => setVar('--mainw', at(ev) + 'px')
    const up = ev => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      lsPut('mainw', String(at(ev)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const oops = e => say(String((e && e.message) || e), true)
  const vr = mode === 'dir' ? vaultRootOf(cwd) : null
  const vkey = vr ? keys[vr] || null : null
  const shut = !!(vr && locks[vr] && !vkey)
  const keyFor = p => { const v = vaultRootOf(p); return (v && keys[v]) || null }
  /* Forget the key. Whatever it decrypted goes with it: the open table, the open preview, and
     below, every cached thumbnail once the lock pane has taken their place. */
  const lockVault = p => {
    setKeys(s => { const n = { ...s }; delete n[p]; return n })
    setPreview(null); setSheet(null); setSel([])
    dropCache()
    say('locked · ' + p.split('/').pop())
  }

  // the chat pane keeps a fixed width, so any width the window gains lands in this pane
  useEffect(() => { setVar('--mainw', num('mainw', MAINW) + 'px') }, [])
  useEffect(() => { setVar('--fmz', zoom); lsPut('zoom', String(zoom)) }, [zoom])
  useEffect(() => { lsPut('cwd', cwd) }, [cwd])
  useEffect(() => { lsPut('open', JSON.stringify([...open])) }, [open])
  useEffect(() => { lsPut('view', view) }, [view])
  useEffect(() => { lsPut('sort', JSON.stringify(sort)) }, [sort])
  // vkey is in here too: locking or unlocking a vault must not leave a decrypted table on screen
  useEffect(() => { setSel([]); setPreview(null); setSheet(null); anchor.current = null }, [cwd, mode, vkey])

  useEffect(() => { if (shut) dropCache() }, [shut])

  useEffect(() => {
    if (!ready) return
    ensureFilesRoot().then(() => listDir(ROOT)).then(l => setKids(k => ({ ...k, [ROOT]: l }))).catch(oops)
  }, [ready])

  // a vault is a top-level folder, so only those (plus the one we stand in) are ever probed
  useEffect(() => {
    const want = [...(kids[ROOT] || []).filter(r => r.isDir).map(r => r.path), ...(vr ? [vr] : [])]
      .filter(p => locks[p] === undefined)
    if (!want.length) return
    Promise.all(want.map(p => readVault(p).catch(() => null).then(l => [p, l])))
      .then(ps => setLocks(s => ({ ...s, ...Object.fromEntries(ps) })))
  }, [kids, vr, locks])

  useEffect(() => {
    if (!ready) return
    let live = true
    if (mode === 'recent') { recent().then(l => live && setRows(l)).catch(oops) }
    else if (shut) setRows([])
    else listDir(cwd).then(l => { if (live) { setRows(l); setKids(k => ({ ...k, [cwd]: l })) } }).catch(oops)
    return () => { live = false }
  }, [cwd, mode, shut, tick, ready])

  const shown = useMemo(() => {
    if (mode === 'recent') return rows
    const by = sort.k === 'size' ? (a, b) => (a.size || 0) - (b.size || 0)
      : sort.k === 'mtime' ? (a, b) => (a.mtime || 0) - (b.mtime || 0)
        : (a, b) => a.name.localeCompare(b.name)
    return rows.slice().sort((a, b) => (a.isDir === b.isDir ? by(a, b) * sort.d : a.isDir ? -1 : 1))
  }, [rows, sort, mode])

  const treeRows = (path, depth) => (kids[path] || []).filter(r => r.isDir)
    .flatMap(r => [{ r, depth }, ...(open.has(r.path) ? treeRows(r.path, depth + 1) : [])])

  const go = p => { hist.current.push(cwd); setMode('dir'); setCwd(p) }
  const back = () => { const p = hist.current.pop(); if (p) { setMode('dir'); setCwd(p) } }
  const expand = p => {
    setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })
    if (!kids[p]) listDir(p).then(l => setKids(k => ({ ...k, [p]: l }))).catch(oops)
  }

  const pick = (e, r, i) => {
    if (e.ctrlKey || e.metaKey) { anchor.current = i; setSel(s => (s.includes(r.path) ? s.filter(p => p !== r.path) : [...s, r.path])); return }
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [anchor.current, i].sort((x, y) => x - y)
      setSel(shown.slice(a, b + 1).map(x => x.path))
      return
    }
    anchor.current = i
    setSel([r.path])
  }
  const openRow = r => (r.isDir ? go(r.path) : isTable(r.name) ? setSheet(r) : setPreview(r))
  const selRows = () => shown.filter(r => sel.includes(r.path))

  const run = async (label, fn) => {
    if (onBusy) onBusy(label)
    try { await fn(); clearRecent(); setTick(t => t + 1) }
    catch (e) { oops(e) }
    finally { if (onBusy) onBusy(null); setProg(null) }
  }

  const up = async list => {
    if (!list.length) return
    if (mode !== 'dir' || shut) { say('open a folder first', true); return }
    const kb = vkey ? C.b64(vkey) : null
    await run('upload', async () => {
      for (let i = 0; i < list.length; i++) {
        const n = i + 1
        setProg({ n, m: list.length, pct: 0 })
        await uploadTo(cwd, list[i], (l, t) => setProg({ n, m: list.length, pct: t ? Math.round(l * 100 / t) : 0 }), kb)
      }
    })
  }
  const attach = () => pickFiles().then(up).catch(oops)

  const save = r => run(r.name, async () => {
    const k = keyFor(r.path)
    setProg({ n: 1, m: 1, pct: 0 })
    await dav.getFile(r, (l, t) => setProg({ n: 1, m: 1, pct: t ? Math.round(l * 100 / t) : 0 }), k ? C.b64(k) : null)
    say('saved · ' + r.name)
  })

  const doMk = () => setAsk({ label: 'new folder', val: '', fn: v => run('new folder', () => mkdir(cwd + '/' + safeSeg(v))) })
  const doRename = r => setAsk({ label: 'rename', val: r.name, fn: v => run('rename', () => rename(r.path, v)) })
  const doVault = r => setAsk({
    label: 'vault password', val: '', secret: true,
    fn: v => run('vault', async () => {
      const k = await makeVault(r.path, v)
      setKeys(s => ({ ...s, [r.path]: k }))
      setLocks(s => ({ ...s, [r.path]: true }))
    }),
  })
  const doDel = list => {
    if (!list.length) return
    if (!confirm(`delete ${list.length === 1 ? list[0].name : list.length + ' items'}?`)) return
    setSel([])
    run('delete', async () => { for (const r of list) await remove(r.path) })
  }
  /* Destinations come out of the tree cache, so the picker only ever offers folders that were
     already listed. ponytail: expand a branch to move into it, no server-wide folder search. */
  const doMove = (list, at) => {
    const dirs = [...new Set([ROOT, ...Object.values(kids).flat().filter(r => r.isDir).map(r => r.path)])]
      .filter(p => p !== cwd && !list.some(r => r.path === p || p.startsWith(r.path + '/')))
    if (!dirs.length) { say('expand a folder in the tree first', true); return }
    setMenu({ ...at, items: dirs.map(p => [home(p), () => run('move', async () => { for (const r of list) await moveTo(r.path, p) })]) })
  }

  const ctx = (e, r) => {
    e.preventDefault()
    const at = { x: e.clientX, y: e.clientY }
    if (r && !sel.includes(r.path)) setSel([r.path])
    const list = r ? (sel.includes(r.path) ? selRows() : [r]) : []
    const top = !!r && r.isDir && parentOf(r.path) === ROOT && !locks[r.path]
    setMenu({
      ...at,
      items: [
        r && !r.isDir && ['open', () => openRow(r)],
        r && !r.isDir && isTable(r.name) && ['open as file', () => setPreview(r)],
        r && !r.isDir && ['download', () => save(r)],
        r && ['rename', () => doRename(r)],
        !!list.length && ['move to…', () => doMove(list, at)],
        top && ['make this a vault', () => doVault(r)],
        r && r.isDir && !!keys[r.path] && ['lock now', () => lockVault(r.path)],
        ['upload files…', attach],
        ['new folder', doMk],
        !!list.length && ['delete', () => doDel(list), true],
      ],
    })
  }

  async function onDrop (e) {
    e.preventDefault(); setDrag(false)
    const list = [...e.dataTransfer.files]
    if (!list.length) return
    const got = IS_DESKTOP ? (await Promise.all(dropPaths(list))).filter(Boolean)
      : list.map(x => ({ name: x.name, size: x.size, blob: x }))
    up(got)
  }

  const bytes = shown.reduce((a, r) => a + (r.isDir ? 0 : r.size || 0), 0)
  const one = sel.length === 1 ? selRows()[0] : null

  return (
    <div className="fm">
      <aside className="fmtree hud">
        <div className="sec">quick</div>
        <button className={'fmq' + (mode === 'recent' ? ' on' : '')} onClick={() => setMode('recent')}>▼ recent</button>
        <button className={'fmq' + (mode === 'dir' && cwd === ROOT ? ' on' : '')} onClick={() => go(ROOT)}>⌸ home</button>
        <div className="sec">tree</div>
        <div className="fmtw">
          {treeRows(ROOT, 0).map(({ r, depth }) => (
            <div key={r.path} className={'fmt' + (mode === 'dir' && cwd === r.path ? ' on' : '')} style={{ paddingLeft: 2 + depth * 11 }}>
              <button className="fmtx" title="expand" onClick={() => expand(r.path)}>{open.has(r.path) ? '▾' : '▸'}</button>
              <button className="fmtn" title={r.name} onClick={() => go(r.path)} onContextMenu={e => ctx(e, r)}>{r.name}</button>
              {!!locks[r.path] && (keys[r.path]
                ? <button className="lk" title="lock this vault now" onClick={() => lockVault(r.path)}>◇</button>
                : <span className="lk" title="vault · locked">◆</span>)}
            </div>
          ))}
          {!(kids[ROOT] || []).length && <div className="empty">no folders</div>}
        </div>
      </aside>

      <section className="fmmain hud">
        <div className="fmbar">
          <button className="icobtn hud" title="back" onClick={back}>‹</button>
          <button className="icobtn hud" title="up" onClick={() => cwd !== ROOT && go(parentOf(cwd))}>↑</button>
          <div className="fmcrumb">
            {mode === 'recent'
              ? <span className="fmcr on">recent</span>
              : crumbs(cwd).map((c, i) => (
                <Fragment key={c.path}>
                  {i > 0 && <span className="sep">›</span>}
                  <button className={'fmcr' + (c.path === cwd ? ' on' : '')} onClick={() => go(c.path)}>{c.name}</button>
                </Fragment>
              ))}
          </div>
          <button className="icobtn hud" title={view === 'list' ? 'tiles' : 'list'}
            onClick={() => setView(v => (v === 'list' ? 'grid' : 'list'))}>{view === 'list' ? '⊞' : '≡'}</button>
          <select className="field hud fmsel" value={sort.k} onChange={e => setSort(s => ({ ...s, k: e.target.value }))}>
            <option value="name">name</option>
            <option value="size">size</option>
            <option value="mtime">date</option>
          </select>
          <button className="icobtn hud" title="direction" onClick={() => setSort(s => ({ ...s, d: -s.d }))}>{sort.d > 0 ? '▴' : '▾'}</button>
          <button className="btn hud" onClick={attach}>+ file</button>
          <button className="btn hud" onClick={doMk}>+ dir</button>
          {onClose && <button className="icobtn hud x" title="close files" onClick={onClose}>×</button>}
          {!!one && <button className="btn hud" onClick={() => doRename(one)}>ren</button>}
          {!!sel.length && <button className="btn hud" onClick={e => doMove(selRows(), { x: e.clientX, y: e.clientY })}>move</button>}
          {!!sel.length && <button className="btn hud x" onClick={() => doDel(selRows())}>del</button>}
        </div>

        {ask && <Ask key={ask.label + ask.val} ask={ask} close={() => setAsk(null)} />}

        {shut ? (
          <VaultLock vr={vr} say={say} onOpen={k => setKeys(s => ({ ...s, [vr]: k }))} />
        ) : (
          <>
            {view === 'list' && mode === 'dir' && (
              <div className="fmhead">
                {[['name', 'name'], ['size', 'size'], ['date', 'mtime']].map(([l, k]) => (
                  <button key={k} className={'fmh h-' + k + (sort.k === k ? ' on' : '')}
                    onClick={() => setSort(s => (s.k === k ? { k, d: -s.d } : { k, d: 1 }))}>
                    {l}{sort.k === k ? (sort.d > 0 ? ' ▴' : ' ▾') : ''}
                  </button>
                ))}
              </div>
            )}
            <div className={'fmlist' + (view === 'grid' ? ' grid' : '')}
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false) }}
              onDrop={onDrop}
              onContextMenu={e => { if (e.target === e.currentTarget) ctx(e, null) }}>
              {!shown.length && <div className="empty">{mode === 'recent' ? 'nothing yet' : 'empty folder'}</div>}
              {shown.map((r, i) => (view === 'grid' ? (
                <div key={r.path} className={'fmtile hud' + (sel.includes(r.path) ? ' on' : '')} title={r.name}
                  onClick={e => pick(e, r, i)} onDoubleClick={() => openRow(r)} onContextMenu={e => ctx(e, r)}>
                  {thumb(r, i)
                    ? <div className="fmthumb"><Attachment f={r} chatKey={keyFor(r.path)} onSave={save} /></div>
                    : <span className="tg">{glyph(r)}</span>}
                  <span className="nm">{r.name}</span>
                </div>
              ) : (
                <button key={r.path} className={'fmrow hud' + (sel.includes(r.path) ? ' on' : '')}
                  onClick={e => pick(e, r, i)} onDoubleClick={() => openRow(r)} onContextMenu={e => ctx(e, r)}>
                  <span className="fmg">{glyph(r)}</span>
                  <span className="nmw">
                    <span className="nm">{r.name}</span>
                    {mode === 'recent' && <span className="pth">{home(parentOf(r.path))}</span>}
                  </span>
                  <span className="sz">{r.isDir ? '—' : fmtSize(r.size)}</span>
                  <span className="dt">{day(r.mtime)}</span>
                </button>
              )))}
            </div>

            <div className="fmfoot">
              {prog && <i className="fmbarp" style={{ width: prog.pct + '%' }} />}
              <button className="fmz" title="smaller" onClick={() => setZoom(z => Math.max(0.7, +(z - 0.1).toFixed(2)))}>−</button>
              <span title="element size">{Math.round(zoom * 100)}%</span>
              <button className="fmz" title="bigger" onClick={() => setZoom(z => Math.min(1.8, +(z + 0.1).toFixed(2)))}>+</button>
              <span>{shown.length} item{shown.length === 1 ? '' : 's'}</span>
              <span>{fmtSize(bytes)}</span>
              {!!sel.length && <span className="fmn">{sel.length} sel</span>}
              <span className="grow" />
              {prog && <span className="fmn">{prog.n}/{prog.m} · {prog.pct}%</span>}
              {!!vkey && <button className="lk" title="lock this vault now" onClick={() => lockVault(vr)}>◇ lock</button>}
            </div>
          </>
        )}

        {drag && <div className="fmdrop">release to upload</div>}
        {preview && (
          <div className="fmprev hud">
            <div className="fmbar">
              <span className="lab grow">{preview.name}</span>
              <button className="icobtn hud" title="close" onClick={() => setPreview(null)}>×</button>
            </div>
            <Attachment f={preview} chatKey={keyFor(preview.path)} onSave={save} />
          </div>
        )}
        {sheet && !shut && (
          <Sheet f={sheet} chatKey={keyFor(sheet.path)} say={say}
            onClose={() => setSheet(null)} onSaved={() => setTick(t => t + 1)} />
        )}
      </section>

      {menu && <Menu at={menu} items={menu.items} close={() => setMenu(null)} />}
      <div className="fmgrip" title="drag to resize" onPointerDown={grip} />
    </div>
  )
}

/** One inline field. Electron has no window.prompt, so names are asked for here. */
function Ask ({ ask, close }) {
  const [v, setV] = useState(ask.val)
  const go = () => { const t = v.trim(); close(); if (t) ask.fn(t) }
  return (
    <div className="fmask">
      <span className="lab">{ask.label}</span>
      <input className="field hud" autoFocus type={ask.secret ? 'password' : 'text'} value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close() }} />
      <button className="btn hud p" onClick={go}>ok</button>
      <button className="icobtn hud" onClick={close}>×</button>
    </div>
  )
}

function VaultLock ({ vr, say, onOpen }) {
  const [pw, setPw] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    setWork(true)
    try {
      const k = await openVault(vr, pw)
      if (!k) { say('wrong password', true); return }
      setPw('')
      onOpen(k)
    } catch (e) { say(String((e && e.message) || e), true) } finally { setWork(false) }
  }
  return (
    <div className="lockpane">
      <div className="h2">vault · {vr.split('/').pop()}</div>
      <div className="note">Everything under this folder is AES-256-GCM encrypted before it leaves this device. Nextcloud sees ciphertext — file names stay readable.</div>
      <input className="field hud" type="password" autoFocus value={pw} placeholder="password"
        onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <div className="note">The key is never written to this device. Close the app and it is gone.</div>
      <button className="btn hud p" disabled={work || !pw} onClick={go}>{work ? 'deriving key…' : 'unlock'}</button>
    </div>
  )
}
