import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as dav from './dav'
import * as C from './crypto'
import { putBytes } from './bridge'
import { parseCsv, toCsv, sepOf } from './csv'

export const isTable = n => /\.(xlsx|xlsm|csv|tsv)$/i.test(n || '')
const isCsv = n => /\.(csv|tsv)$/i.test(n)

const MAXB = 20 << 20            // a spreadsheet this side of 20MB is a spreadsheet; past that it is a database
/* ponytail: the whole grid renders at once, no windowing, so a very wide or very tall sheet is
   clipped to what stays responsive. Virtualise the rows if a real file ever hits these. */
const MAXR = 4000, MAXC = 200
const PADR = 12, PADC = 3        // blank rows/columns kept below and right, so there is room to type
const MINR = 24, MINC = 8

export const colName = n => {
  let s = ''
  for (let x = n + 1; x > 0;) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = (x - 1 - m) / 26 }
  return s
}

const cell = (v = '', bg = '', fg = '') => ({ v, bg, fg })
/** Grow a parsed grid into a rectangle with room to spare. */
const pad = g => {
  const cols = Math.min(MAXC, Math.max(MINC, ...g.map(r => r.length)) + PADC)
  const rows = Math.min(MAXR, Math.max(MINR, g.length) + PADR)
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (g[r] && g[r][c]) || cell()))
}
/** Drop the padding again: trailing rows and columns holding nothing. */
const trim = g => {
  const rows = g.map(r => { let last = -1; r.forEach((x, i) => { if (x.v !== '') last = i }); return r.slice(0, last + 1) })
  let last = -1
  rows.forEach((r, i) => { if (r.length) last = i })
  return rows.slice(0, last + 1)
}

// exceljs keeps colours as AARRGGBB; a theme or gradient colour has no plain hex to show
const hexOf = c => { const a = c && c.argb; return a && a.length === 8 ? '#' + a.slice(2).toLowerCase() : '' }
const argbOf = hex => ({ argb: 'FF' + hex.slice(1).toUpperCase() })
const bgOf = f => (f && f.type === 'pattern' ? hexOf(f.fgColor) : '')
const fillOf = bg => (bg ? { type: 'pattern', pattern: 'solid', fgColor: argbOf(bg) } : { type: 'pattern', pattern: 'none' })
/** Keep bold, size and typeface; only the colour is ours to set or drop. */
const fontOf = (font, fg) => { const { color, ...rest } = font || {}; return fg ? { ...rest, color: argbOf(fg) } : rest }

const readSheet = ws => {
  const rows = Math.min(ws.rowCount || 0, MAXR)
  const cols = Math.min(ws.columnCount || 0, MAXC)
  return pad(Array.from({ length: rows }, (_, r) => {
    const row = ws.getRow(r + 1)
    return Array.from({ length: cols }, (_, c) => {
      const x = row.getCell(c + 1)
      return cell(x.text || '', bgOf(x.fill), hexOf(x.font && x.font.color))
    })
  }))
}

const box = s => [Math.min(s.r1, s.r2), Math.max(s.r1, s.r2), Math.min(s.c1, s.c2), Math.max(s.c1, s.c2)]
const inBox = (s, r, c) => { if (!s) return false; const [a, b, d, e] = box(s); return r >= a && r <= b && c >= d && c <= e }

/**
 * Open one table straight off the server, edit text and cell colours, PUT it back to the same path.
 * Only the cells actually touched are written, so formulas and number formats elsewhere survive.
 */
export default function Sheet ({ f, chatKey, say, onClose, onSaved, float }) {
  const [grid, setGrid] = useState(null)
  const [tabs, setTabs] = useState([])
  const [at, setAt] = useState(0)
  const [sel, setSel] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState('opening…')
  const [dirty, setDirty] = useState(false)
  const [hue, setHue] = useState('#ffe08a')      // last fill colour picked
  const [ink, setInk] = useState('#f87171')      // last text colour picked
  const wb = useRef(null)                 // the exceljs workbook, null for csv
  const edits = useRef(new Set())         // "r,c" of every cell the user changed since the last save
  const opened = useRef()                 // the key this file was decrypted with, to notice it going away

  useEffect(() => {
    let live = true
    setGrid(null); setErr(null); setSel(null); setDirty(false); setBusy('opening…')
    edits.current = new Set()
    opened.current = chatKey
    ;(async () => {
      try {
        if (f.size > MAXB) throw new Error('file is too big to open here')
        let bytes = await dav.fileBytes(f)
        if (chatKey) bytes = await C.decryptBytes(chatKey, bytes)
        if (isCsv(f.name)) {
          wb.current = null
          const g = pad(parseCsv(new TextDecoder().decode(bytes), sepOf(f.name)).map(r => r.map(v => cell(v))))
          if (live) { setTabs([]); setGrid(g) }
        } else {
          // exceljs is ~900KB: it only loads when a spreadsheet is actually opened
          const { default: ExcelJS } = await import('exceljs')
          const book = new ExcelJS.Workbook()
          await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          if (!book.worksheets.length) throw new Error('no sheets in this file')
          wb.current = book
          if (live) { setTabs(book.worksheets.map(w => w.name)); setAt(0); setGrid(readSheet(book.worksheets[0])) }
        }
      } catch (e) { if (live) setErr(String((e && e.message) || e)) } finally { if (live) setBusy(null) }
    })()
    return () => { live = false }
  }, [f.path])

  /* Edits live in the grid until they are pushed back into the workbook - on save, and on a
     sheet switch, which would otherwise drop everything typed on the sheet being left. */
  const apply = () => {
    const ws = wb.current && wb.current.worksheets[at]
    if (!ws || !grid) return
    for (const k of edits.current) {
      const [r, c] = k.split(',').map(Number)
      const src = grid[r][c]
      const x = ws.getRow(r + 1).getCell(c + 1)
      const n = Number(src.v)
      x.value = src.v === '' ? null : (src.v.trim() !== '' && Number.isFinite(n) ? n : src.v)
      x.fill = fillOf(src.bg)
      x.font = fontOf(x.font, src.fg)
    }
    edits.current.clear()
  }

  const pickSheet = i => {
    if (i === at) return
    apply()
    setAt(i); setSel(null); setGrid(readSheet(wb.current.worksheets[i]))
  }

  const write = (list, patch) => {
    setGrid(g => {
      const n = g.slice()
      for (const [r, c] of list) { n[r] = n[r].slice(); n[r][c] = { ...n[r][c], ...patch }; edits.current.add(r + ',' + c) }
      return n
    })
    setDirty(true)
  }
  const selected = () => {
    if (!sel) return []
    const [r1, r2, c1, c2] = box(sel)
    const out = []
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push([r, c])
    return out
  }

  const save = async () => {
    if (chatKey !== opened.current) { say('the key changed, this file can no longer be saved', true); return }
    setBusy('saving…')
    try {
      let out
      if (wb.current) { apply(); out = new Uint8Array(await wb.current.xlsx.writeBuffer()) }
      else out = new TextEncoder().encode(toCsv(trim(grid).map(r => r.map(x => x.v)), sepOf(f.name)))
      const r = await putBytes(dav.url(f.path), dav.authHeaders(), chatKey ? await C.encryptBytes(chatKey, out) : out)
      if (!r || r.status >= 400) throw new Error('save failed (HTTP ' + ((r && r.status) || '?') + ')')
      setDirty(false)
      say('saved · ' + f.name)
      if (onSaved) onSaved()
    } catch (e) { say(String((e && e.message) || e), true) } finally { setBusy(null) }
  }

  /* The plaintext must not outlive the key that produced it: locking the vault or the container,
     or stepping into another one, drops the grid and the workbook on the spot. Saving on with a
     key that no longer matches would encrypt the file to the wrong password, or to none at all. */
  useEffect(() => {
    if (opened.current === undefined || chatKey === opened.current) return
    wb.current = null
    if (dirty) say('locked · unsaved table changes dropped', true)
    onClose()
  }, [chatKey])

  // and nothing decrypted is left behind on the way out either
  useEffect(() => () => { wb.current = null; edits.current = new Set() }, [])

  useEffect(() => {
    const h = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!busy) save() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const csv = isCsv(f.name)
  const some = !!sel
  const rows = grid ? grid.length : 0
  const cols = grid && grid[0] ? grid[0].length : 0
  /* A header click takes the whole row or column, and shift-click walks from the last one
     clicked to this one, so several rows or columns come along in a single block. */
  const takeRow = (r, e) => setSel(s => ({ r1: e.shiftKey && s ? s.r1 : r, c1: 0, r2: r, c2: cols - 1 }))
  const takeCol = (c, e) => setSel(s => ({ r1: 0, c1: e.shiftKey && s ? s.c1 : c, r2: rows - 1, c2: c }))
  const takeAll = () => setSel({ r1: 0, c1: 0, r2: rows - 1, c2: cols - 1 })
  const spanRow = r => { if (!sel) return false; const [a, b] = box(sel); return r >= a && r <= b }
  const spanCol = c => { if (!sel) return false; const [, , a, b] = box(sel); return c >= a && c <= b }

  const pane = (
    <div className={'fmsheet hud' + (float ? ' float' : '')}>
      <div className="fmbar">
        <span className="lab grow">{f.name}{dirty ? ' •' : ''}</span>
        {tabs.length > 1 && tabs.map((t, i) => (
          <button key={t} className={'fmcr' + (i === at ? ' on' : '')} onClick={() => pickSheet(i)}>{t}</button>
        ))}
        {csv && <span className="shnote" title="a csv file stores text only">no colours in csv</span>}
        <input className="shpick" type="color" disabled={!some} value={hue}
          title={csv ? 'csv keeps no colours, they are lost on save' : 'fill colour of the selected cells'}
          onChange={e => { setHue(e.target.value); write(selected(), { bg: e.target.value }) }} />
        <input className="shpick ink" type="color" disabled={!some} value={ink}
          title={csv ? 'csv keeps no colours, they are lost on save' : 'text colour of the selected cells'}
          onChange={e => { setInk(e.target.value); write(selected(), { fg: e.target.value }) }} />
        <button className="btn hud" disabled={!some} title="no colour" onClick={() => write(selected(), { bg: '', fg: '' })}>◻</button>
        <button className="btn hud" disabled={!some} title="empty the selected cells" onClick={() => write(selected(), { v: '', bg: '', fg: '' })}>clear</button>
        <button className="btn hud p" disabled={!!busy || !dirty} onClick={save}>{busy || 'save'}</button>
        <button className="icobtn hud x" title="close" onClick={onClose}>×</button>
      </div>

      {err && <div className="empty">{err}</div>}
      {!err && !grid && <div className="empty">{busy || 'loading…'}</div>}
      {grid && (
        <div className="shwrap">
          <table className="sheet">
            <thead>
              <tr>
                <th className="shh pick" title="select everything" onClick={takeAll} />
                {grid[0].map((_, c) => (
                  <th key={c} className={'shh pick' + (spanCol(c) ? ' on' : '')} title="select this column"
                    onClick={e => takeCol(c, e)}>{colName(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, r) => (
                <tr key={r}>
                  <th className={'shh pick' + (spanRow(r) ? ' on' : '')} title="select this row"
                    onClick={e => takeRow(r, e)}>{r + 1}</th>
                  {row.map((x, c) => (
                    <td key={c} className={'shx' + (inBox(sel, r, c) ? ' on' : '')}
                      style={x.bg || x.fg ? { background: x.bg || undefined, color: x.fg || undefined } : null}
                      contentEditable suppressContentEditableWarning spellCheck={false}
                      onMouseDown={e => {
                        if (!e.shiftKey) { setSel({ r1: r, c1: c, r2: r, c2: c }); return }
                        e.preventDefault()
                        setSel(s => (s ? { ...s, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c }))
                      }}
                      onBlur={e => { const t = e.currentTarget.textContent; if (t !== x.v) write([[r, c]], { v: t }) }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() } }}>
                      {x.v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
  // in the chat pane there is no positioned box to sit in, so it floats over the window instead
  return float ? createPortal(pane, document.body) : pane
}
