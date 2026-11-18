import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'

const ROW = 30

/** Right-click on desktop, long-press on android. items = [label, fn, danger?, icon?][]
    A dangerous item is set apart by a rule and drawn in brick. */
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
  const h = list.length * ROW + 10 + (list.some(x => x[2]) ? 9 : 0)
  return createPortal((
    <div className="cmenu hud" role="menu" style={{
      left: Math.max(4, Math.min(at.x, window.innerWidth - 190)),
      top: Math.max(4, Math.min(at.y, window.innerHeight - 8 - h)),
    }}>
      {list.map(([label, fn, danger, icon], i) => (
        <div key={label}>
          {danger && i > 0 && <hr />}
          <button role="menuitem" className={danger ? 'x' : ''} onClick={() => { close(); fn() }}>
            {icon && <Icon n={icon} size={15} />}{label}
          </button>
        </div>
      ))}
    </div>
  ), document.body)
}
