import Icon from './Icon.jsx'

/* The handful of controls every screen shares, so a switch or a dialog looks and behaves the
   same wherever it appears. */

/** A modal sheet: title bar with a close button, then the body. Click outside closes it. */
export function Dialog ({ title, icon, close, children, className }) {
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className={'sheet hud' + (className ? ' ' + className : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="shead">
          {icon && <Icon n={icon} className="lead" size={16} />}
          <div className="h2">{title}</div>
          <button className="icobtn" onClick={close} title="Close" aria-label="Close"><Icon n="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** On/off for something that takes effect at once. `sub` says what each state means. */
export function Switch ({ on, onChange, label, sub, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={!!on} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="knob" />
      <span className="sl"><b>{label}</b>{sub && <span>{sub}</span>}</span>
    </label>
  )
}

/** One of a few options, all visible. options = [value, label, icon?][] */
export function Seg ({ value, options, onChange, label, keepFocus }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text, icon]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''}
          onMouseDown={keepFocus ? e => e.preventDefault() : undefined} onClick={() => onChange(v)}>
          {icon && <Icon n={icon} size={13} />}{text}
        </button>
      ))}
    </div>
  )
}

/** Which way a server address points: the Proxmox server or the laptop's fallback copy. */
export const serverOf = base => (!base ? '' : /:8081\//.test(base) ? 'laptop' : 'server')

/* Container colours: the six muted ones the design uses. Older containers saved one of the
   original bright accents in chat.json; those are shown as their muted counterpart, so no
   neon survives without anyone having to re-save a container. */
export const ACCENTS = ['#9a9a96', '#6f8296', '#7d8a5a', '#a8924f', '#9a5a4f', '#8a7690']
const LEGACY = { '#89e694': '#7d8a5a', '#22d3ee': '#6f8296', '#a3a3a3': '#9a9a96', '#fbbf24': '#a8924f', '#f87171': '#9a5a4f', '#c084fc': '#8a7690' }
export const accentOf = a => LEGACY[String(a || '').toLowerCase()] || a || ACCENTS[0]

/** The line icon that stands for a file name. */
export const iconOfName = (n, kind) => (kind === 'image' ? 'image' : kind === 'video' ? 'film' : kind === 'audio' ? 'audio'
  : /\.(xlsx|xlsm|csv|tsv)$/i.test(n || '') ? 'table' : 'file')
