import { useEffect, useState } from 'react'
import * as V from './vault'
import * as dav from './dav'
import * as T from './totp'
import Menu from './Menu.jsx'
import Icon, { Ring } from './Icon.jsx'
import { Dialog, Switch, Seg, ACCENTS } from './ui.jsx'
import { copyText, pickFiles, clipboardImage, decodeQr, IS_DESKTOP } from './bridge'

/* 123456 reads as a number, 123 456 reads as a code you are about to type. */
const spaced = c => (c.length === 6 ? c.slice(0, 3) + ' ' + c.slice(3) : c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c)
const title = e => (e.issuer && e.issuer !== e.name ? e.issuer : e.name)
const sub = e => (e.issuer && e.issuer !== e.name ? e.name : '')
const SOON = 5                                         // seconds before roll-over when the next code shows
/* An account's tile: up to two initials on one of the muted container colours, picked by
   the name so it stays the same on every device. */
const initials = n => (String(n || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase()
const tint = n => { let h = 0; for (const ch of String(n || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ACCENTS[1 + (h % (ACCENTS.length - 1))] }

export default function Vault ({ say, close }) {
  const [raw, setRaw] = useState(undefined)            // undefined = still asking the server
  const [open, setOpen] = useState(V.isOpen())
  const [tick, setTick] = useState(0)                  // bumped after every write
  const [now, setNow] = useState(Date.now())
  const [codes, setCodes] = useState({})
  const [nexts, setNexts] = useState({})
  const [q, setQ] = useState('')
  const [pane, setPane] = useState(null)               // 'add' | 'pass'
  const [edit, setEdit] = useState(null)
  const [menu, setMenu] = useState(null)
  const [work, setWork] = useState('')
  const [err, setErr] = useState('')
  const [again, setAgain] = useState(0)
  const [mega, setMega] = useState(undefined)          // undefined = not read yet
  const [copied, setCopied] = useState(null)           // { id, next } of the row that was just copied

  const redraw = () => setTick(n => n + 1)
  const items = open ? V.list() : []
  const hit = q.trim().toLowerCase()
  const shown = hit ? items.filter(e => (e.name + ' ' + (e.issuer || '')).toLowerCase().includes(hit)) : items

  /* raw: undefined while reading, null when there is no vault yet, false when the server
     would not say. Only null offers to create one — creating writes over that path. */
  useEffect(() => {
    if (open) return
    setErr(''); setRaw(undefined)
    V.load().then(setRaw).catch(e => { setRaw(false); setErr(String(e.message || e)) })
  }, [open, again])
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h) }, [])

  /* Codes are only recomputed when a step actually rolls over, not once a second per row.
     The next code is worked out only in a step's last five seconds, when it is shown. */
  const stamp = items.map(e => (e.type === 'hotp' ? `${e.id}:h${e.counter || 0}` : `${e.id}:${T.step(e, now)}:${T.remain(e, now) <= SOON}`)).join(',')
  useEffect(() => {
    if (!open) { setCodes({}); setNexts({}); return }
    let live = true
    ;(async () => {
      const out = {}
      const nx = {}
      for (const e of items) {
        out[e.id] = await T.code(e, now).catch(() => '')
        if (e.type !== 'hotp' && T.remain(e, now) <= SOON) nx[e.id] = await T.code(e, now + (e.period || 30) * 1000).catch(() => '')
      }
      if (live) { setCodes(out); setNexts(nx) }
    })()
    return () => { live = false }
  }, [stamp, open])

  /* Idle auto-lock, and a pull so a code added on the phone shows up here without a reopen. */
  useEffect(() => {
    if (!open) return
    const h = setInterval(() => {
      if (!V.isOpen()) { setOpen(false); return }        // the app-wide idle sweep got there first
      if (V.idle() > V.IDLE_MS) { V.lock(); setOpen(false); say('Authenticator locked after 5 minutes idle') }
      else V.refresh().then(ch => ch && redraw()).catch(() => {})
    }, 15000)
    return () => clearInterval(h)
  }, [open])

  const guard = async (label, fn) => {
    setWork(label)
    try { await fn(); redraw(); V.touch() } catch (e) { say(String(e.message || e), true) } finally { setWork('') }
  }

  /* The MEGA switch is a marker beside the vault, not a field inside it: the server's hourly
     job has to read it, and everything inside vault.json is ciphertext. */
  const MARK = V.DIR + '/.tsbackup'
  useEffect(() => {
    if (!open) return
    dav.getJson(MARK).then(x => setMega(!!x)).catch(() => setMega(false))
  }, [open])
  const setBackup = on => guard('mega', async () => {
    const r = on ? await dav.putJson(MARK, { on: true, ts: Date.now() }) : await dav.del(MARK)
    if (r.status >= 400 && !(r.status === 404 && !on)) throw new Error(`MEGA switch failed (HTTP ${r.status})`)
    setMega(on)
  })

  /* Copy confirms on the row itself, in olive, for a moment - no toast to look for. */
  const take = (e, next) => {
    const c = next ? nexts[e.id] : codes[e.id]
    if (!c) return
    V.touch()
    copyText(c).then(() => {
      setCopied({ id: e.id, next })
      setTimeout(() => setCopied(x => (x && x.id === e.id ? null : x)), 1600)
    }).catch(() => say('Copy failed', true))
  }

  const shut = () => { V.lock(); setOpen(false); setRaw(undefined); setPane(null); setEdit(null) }

  return (
    <div onPointerDown={V.touch}>
      <Dialog title="Authenticator" icon="shield" close={close} className="vault">
        {raw === undefined && !open && <div className="note">Reading the vault…</div>}

        {!open && raw === false && (
          <div className="lockpane">
            <div className="lockmark"><Icon n="warn" size={22} /></div>
            <div className="note">{err}</div>
            <div className="note">Nothing was changed. The vault is only ever read and written on the server you are connected to.</div>
            <button className="btn p" onClick={() => setAgain(n => n + 1)}><Icon n="refresh" size={14} />Try again</button>
          </div>
        )}

        {!open && raw === null && <Create say={say} onDone={() => { setOpen(true); redraw() }} />}

        {!open && raw && (V.exists(raw)
          ? <Unlock raw={raw} say={say} onDone={() => { setOpen(true); redraw() }} />
          : <div className="note">There is a file at {V.FILE} that is not a vault. Move it aside and reopen this.</div>)}

        {open && (
          <>
            <div className="vtools">
              <div className="q hud">
                <Icon n="search" size={15} />
                <input value={q} placeholder="Search codes" aria-label="Search codes" onChange={e => { setQ(e.target.value); V.touch() }} />
              </div>
              <button className="btn p" onClick={() => { setPane(pane === 'add' ? null : 'add'); V.touch() }}><Icon n="plus" size={14} />Add</button>
              <button className="icobtn" onClick={shut} title="Lock now" aria-label="Lock now"><Icon n="lock" size={17} /></button>
            </div>

            {pane === 'add' && <Add say={say} close={() => setPane(null)} onAdd={l => guard('saving', async () => {
              const r = await V.add(l)
              setPane(null)
              say(`${r.added} added${r.dupes ? `, ${r.dupes} already in the vault` : ''}`)
            })} />}

            {pane === 'pass' && <ChangePass say={say} close={() => setPane(null)} />}

            {!shown.length && (
              <div className="empty">
                <Icon n={items.length ? 'search' : 'key'} size={26} />
                {items.length ? 'Nothing matches.' : 'No codes yet. Add one from an otpauth link, a QR picture, a Google Authenticator export, or by typing the secret.'}
              </div>
            )}

            <div className="vlist">
              {shown.map(e => {
                const hotp = e.type === 'hotp'
                const left = hotp ? null : T.remain(e, now)
                const span = e.period || 30
                const hot = !hotp && left <= SOON
                const done = copied && copied.id === e.id
                return (
                  <div key={e.id} role="button" tabIndex={0} className={'vrow hud' + (done ? ' copied' : '')} title="Copy code"
                    onClick={() => take(e)} onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), take(e))}
                    onContextMenu={ev => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, e }) }}>
                    <span className="tile" style={{ background: tint(title(e)) }}>{initials(title(e))}</span>
                    <div className="vwho">
                      <b>{title(e)}</b>
                      {!!sub(e) && <span>{sub(e)}</span>}
                    </div>
                    <div className="vcodes">
                      <span className={'vcode' + (hot ? ' hot' : '')}>{spaced(codes[e.id] || '·'.repeat(e.digits || 6))}</span>
                      {done
                        ? <span className="vnext done">{copied.next ? 'Next code copied' : 'Copied'}</span>
                        : hot && nexts[e.id]
                          ? <button className="vnext" title="Copy the next code" onClick={ev => { ev.stopPropagation(); take(e, true) }}>Next {spaced(nexts[e.id])}</button>
                          : hotp ? <span className="vnext">Counter {e.counter || 0}</span> : null}
                    </div>
                    {hotp
                      ? <button className="icobtn" title="Next code (advance the counter)" onClick={ev => { ev.stopPropagation(); guard('', () => V.update(e.id, { counter: (e.counter || 0) + 1 })) }}><Icon n="refresh" size={16} /></button>
                      : <span title={`${Math.ceil(left)} s left`}><Ring frac={left / span} hot={hot} /></span>}
                    <button className="mb" title="More" aria-label="More" onClick={ev => { ev.stopPropagation(); setMenu({ x: ev.clientX, y: ev.clientY, e }) }}><Icon n="more" size={15} /></button>
                  </div>
                )
              })}
            </div>

            {edit && <Edit e={edit} close={() => setEdit(null)} say={say}
              onSave={p => guard('saving', async () => { await V.update(edit.id, p); setEdit(null) })} />}

            <div className="card">
              <Switch on={!!mega} disabled={mega === undefined || !!work} onChange={setBackup} label="Back up to MEGA"
                sub={mega
                  ? 'Hourly. The vault is already encrypted with your password, and the server encrypts it again before upload.'
                  : 'Off. Kept on the server, the laptop copy and the USB disk only. Recommended on: this is where your 2FA codes live.'} />
            </div>

            <div className="sfoot">
              <button className="btn ghost sm" onClick={() => setPane(pane === 'pass' ? null : 'pass')}><Icon n="key" size={13} />Change password</button>
              <span className="grow" />
              {!!work && <span className="vstat"><Icon n="clock" size={13} />{work}…</span>}
            </div>
            <div className="note">
              Secrets are encrypted with this password before they reach the server, and the key is held in memory only. Closing the app, or 5 idle minutes, locks the authenticator.
            </div>
          </>
        )}
      </Dialog>

      {menu && (
        <Menu at={menu} close={() => setMenu(null)} items={[
          ['Copy code', () => take(menu.e), false, 'copy'],
          ['Rename', () => setEdit(menu.e), false, 'edit'],
          ['Copy otpauth link', () => {
            if (!confirm('Copy the plain secret for ' + title(menu.e) + ' to the clipboard?\n\nAnything on the clipboard can be read by other apps.')) return
            copyText(T.toUri(menu.e)).then(() => say('Link copied. Paste it somewhere safe, then clear the clipboard.')).catch(() => {})
          }, false, 'link'],
          ['Delete', () => {
            if (!confirm(`Delete ${title(menu.e)}?\n\nIf this is your only copy of the code you lose access to that account.`)) return
            guard('deleting', () => V.remove(menu.e.id))
          }, true, 'trash'],
        ]} />
      )}
    </div>
  )
}

function Create ({ onDone, say }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    if (pw.length < 8) { say('Use at least 8 characters', true); return }
    if (pw !== pw2) { say('The two passwords differ', true); return }
    setWork(true)
    try { await V.create(pw); onDone() } catch (e) { say(String(e.message || e), true); setWork(false) }
  }
  return (
    <div className="lockpane">
      <div className="lockmark"><Icon n="shield" size={22} /></div>
      <div className="h2">Set up the authenticator</div>
      <div className="note">Your two-factor codes get a password of their own, not the server password and not a container one. Pick something you can type on a phone keyboard and will not forget.</div>
      <input className="field hud" type="password" autoFocus value={pw} placeholder="New password (8 or more characters)" onChange={e => setPw(e.target.value)} />
      <input className="field hud" type="password" value={pw2} placeholder="Repeat password" onChange={e => setPw2(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <div className="banner warn" style={{ margin: 0 }}><Icon n="warn" size={16} /><span><b>There is no recovery.</b> Lose this password and the codes are gone. Keep the one-time backup codes your accounts gave you somewhere outside this app.</span></div>
      <button className="btn p" disabled={work || !pw} onClick={go}>{work ? 'Creating…' : 'Create'}</button>
    </div>
  )
}

function Unlock ({ raw, onDone, say }) {
  const [pw, setPw] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    setWork(true)
    try {
      const ok = await V.open(raw, pw)
      if (!ok) { say('Wrong password', true); setPw(''); return }
      onDone()
    } catch (e) { say(String(e.message || e), true) } finally { setWork(false) }
  }
  return (
    <div className="lockpane">
      <div className="lockmark"><Icon n="lock" size={22} /></div>
      <div className="h2">Authenticator is locked</div>
      <input className="field hud" type="password" autoFocus value={pw} placeholder="Authenticator password" aria-label="Authenticator password"
        onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <button className="btn p" disabled={work || !pw} onClick={go}><Icon n="unlock" size={14} />{work ? 'Unlocking…' : 'Unlock'}</button>
      <div className="note">Locks again after 5 minutes without use. {V.ITER.toLocaleString()} key-derivation rounds make every wrong guess cost about half a second, on any machine.</div>
    </div>
  )
}

/** Paste a link, read a QR out of a picture, or type the secret the website printed. */
function Add ({ onAdd, close, say }) {
  const [txt, setTxt] = useState('')
  const [manual, setManual] = useState(false)
  const [m, setM] = useState({ name: '', issuer: '', secret: '', digits: 6, period: 30, algo: 'SHA1', type: 'totp' })

  const take = async f => {
    if (!f) return
    try {
      const got = await decodeQr(f)
      if (!got) { say('No QR code in that picture', true); return }
      setTxt(t => (t ? t + '\n' : '') + got)
      say('QR code read. Check the count, then Add.')
    } catch (e) { say(String(e.message || e), true) }
  }

  const go = () => {
    try {
      if (manual) {
        T.b32decode(m.secret)
        onAdd([{ ...m, name: m.name.trim() || m.issuer.trim() || 'account', issuer: m.issuer.trim(), secret: m.secret.replace(/\s/g, '').toUpperCase() }])
      } else onAdd(T.parseAny(txt))
    } catch (e) { say(String(e.message || e), true) }
  }

  let found = 0
  try { found = manual ? 0 : T.parseAny(txt).length } catch (_) {}

  return (
    <div className="vadd hud">
      <div className="row">
        <Seg value={manual ? 'type' : 'link'} onChange={v => setManual(v === 'type')} label="Add from"
          options={[['link', 'Link or QR', 'qr'], ['type', 'Type the secret', 'key']]} />
        <span className="grow" />
        <button className="icobtn" title="Close" aria-label="Close" onClick={close}><Icon n="x" size={15} /></button>
      </div>

      {!manual ? (
        <>
          <textarea className="medit hud" rows={3} value={txt} autoFocus
            placeholder="Paste an otpauth://totp/ link, or a Google Authenticator export link"
            onChange={e => setTxt(e.target.value)} />
          <div className="row">
            <button className="btn sm" onClick={() => pickFiles().then(f => take(f[0])).catch(() => {})}><Icon n="image" size={13} />QR from a picture</button>
            <button className="btn sm" onClick={() => clipboardImage().then(f => f.length ? take(f[0]) : say('No image on the clipboard')).catch(e => say(String(e.message || e), true))}><Icon n="paste" size={13} />QR from clipboard</button>
            <span className="grow" />
            {!!found && <span className="vstat"><Icon n="ok" size={13} />{found} found</span>}
          </div>
          <div className="note">
            From Google Authenticator: open its menu, <b>Transfer accounts</b>, <b>Export</b>. It shows one QR holding every account (several QRs for many accounts). Screenshot it{IS_DESKTOP ? ' or photograph the phone' : ''}, read it here, and repeat for each QR. Delete the screenshots afterwards: anyone with them can make your codes.
          </div>
        </>
      ) : (
        <>
          <input className="field hud" autoFocus placeholder="Account (you@example.com)" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} />
          <input className="field hud" placeholder="Issuer (GitHub)" value={m.issuer} onChange={e => setM({ ...m, issuer: e.target.value })} />
          <input className="field hud" placeholder="Secret (the code the site shows beside the QR)" value={m.secret}
            onChange={e => setM({ ...m, secret: e.target.value })} />
          <div className="row">
            <select className="field hud" style={{ width: 'auto' }} value={m.algo} onChange={e => setM({ ...m, algo: e.target.value })}>
              {T.ALGOS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select className="field hud" style={{ width: 'auto' }} value={m.digits} onChange={e => setM({ ...m, digits: Number(e.target.value) })}>
              {[6, 7, 8].map(d => <option key={d} value={d}>{d} digits</option>)}
            </select>
            <select className="field hud" style={{ width: 'auto' }} value={m.period} onChange={e => setM({ ...m, period: Number(e.target.value) })}>
              {[30, 60].map(p => <option key={p} value={p}>{p}s</option>)}
            </select>
          </div>
          <div className="note">Leave these three alone unless the site says otherwise. Almost every site uses SHA1, 6 digits, 30 seconds.</div>
        </>
      )}

      <div className="row">
        <span className="grow" />
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn p" disabled={manual ? !m.secret : !found} onClick={go}><Icon n="plus" size={14} />Add{found > 1 ? ` ${found}` : ''}</button>
      </div>
    </div>
  )
}

function Edit ({ e, onSave, close }) {
  const [name, setName] = useState(e.name)
  const [issuer, setIssuer] = useState(e.issuer || '')
  return (
    <div className="vadd hud">
      <div className="lab">Account</div>
      <input className="field hud" autoFocus value={name} onChange={ev => setName(ev.target.value)} />
      <div className="lab">Issuer</div>
      <input className="field hud" value={issuer} onChange={ev => setIssuer(ev.target.value)}
        onKeyDown={ev => ev.key === 'Enter' && onSave({ name: name.trim() || e.name, issuer: issuer.trim() })} />
      <div className="row">
        <span className="grow" />
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn p" onClick={() => onSave({ name: name.trim() || e.name, issuer: issuer.trim() })}>Save</button>
      </div>
    </div>
  )
}

function ChangePass ({ close, say }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [rep, setRep] = useState('')
  const [work, setWork] = useState(false)
  const go = async () => {
    if (next.length < 8) { say('Use at least 8 characters', true); return }
    if (next !== rep) { say('The two passwords differ', true); return }
    setWork(true)
    try {
      const ok = await V.changePassword(cur, next)
      say(ok ? 'Password changed. Other devices need it on their next unlock.' : 'The current password is wrong', !ok)
      if (ok) close()
    } catch (e) { say(String(e.message || e), true) } finally { setWork(false) }
  }
  return (
    <div className="vadd hud">
      <div className="lab">Change the authenticator password</div>
      <input className="field hud" type="password" autoFocus value={cur} placeholder="Current password" onChange={e => setCur(e.target.value)} />
      <input className="field hud" type="password" value={next} placeholder="New password" onChange={e => setNext(e.target.value)} />
      <input className="field hud" type="password" value={rep} placeholder="Repeat new password" onChange={e => setRep(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      <div className="note">Every secret is re-encrypted under the new password and written back as one file.</div>
      <div className="row">
        <span className="grow" />
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn p" disabled={work || !cur || !next} onClick={go}>{work ? 'Changing…' : 'Change password'}</button>
      </div>
    </div>
  )
}
