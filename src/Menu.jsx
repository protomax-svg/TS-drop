import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/** Right-click on desktop, long-press on android. items = [label, fn, danger?][] */
export default function Menu ({ at, items, close }) {
  useEffect(() => {
    const off = e => { if (!(e.target.closest && e.target.closest('.cmenu'))) close() }
    window.addEventListener('pointerdown', off, true)
    window.addEventListener('scroll', off, true)
    return () => {
      window.removeEventListener('pointerdown', off, true)
      window.removeEventListener('scroll', off, true)
    }
  }, [close])
  const list = items.filter(Boolean)
  return createPortal((
    <div className="cmenu hud" style={{
      left: Math.min(at.x, window.innerWidth - 150),
      top: Math.min(at.y, Math.max(4, window.innerHeight - 12 - list.length * 23)),
    }}>
      {list.map(([label, fn, danger]) => (
        <button key={label} className={danger ? 'x' : ''} onClick={() => { close(); fn() }}>{label}</button>
      ))}
    </div>
  ), document.body)
}
