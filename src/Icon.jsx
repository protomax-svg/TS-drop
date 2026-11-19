/* The app's only icons: one line family, 24px grid, 1.6px round strokes in currentColor, so
   an icon always matches the text beside it and every theme gets it for free. No glyphs, no
   emoji - a font decides how those look (a gear became a colour emoji on some systems).

   Each icon is a list of shapes: a plain string is a path, "c x y r" a circle,
   "r x y w h rx" a rectangle. A path of "Mx yh.01" draws a dot (round cap). */
const I = {
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  chat: ['M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5V16.5h0a2 2 0 0 1-2-2z', 'M8.5 9h7', 'M8.5 12.2h4.5'],
  search: ['c 11 11 6.5', 'M20 20l-4.4-4.4'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  chevR: ['M9.5 6l6 6-6 6'],
  chevL: ['M14.5 6l-6 6 6 6'],
  chevD: ['M6 9.5l6 6 6-6'],
  settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'c 15 7 2', 'c 9 17 2'],
  shield: ['M12 3l7.5 3v5.2c0 4.6-3.1 8.5-7.5 9.8-4.4-1.3-7.5-5.2-7.5-9.8V6z', 'M8.8 12.2l2.2 2.2 4.3-4.4'],
  lock: ['r 5 11 14 9.5 2', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlock: ['r 5 11 14 9.5 2', 'M8 11V8a4 4 0 0 1 7.7-1.6'],
  cloud: ['M7.5 18.5h9.6a4 4 0 0 0 .5-7.97 5.6 5.6 0 0 0-10.8 1.2 3.4 3.4 0 0 0 .7 6.77z'],
  cloudUp: ['M7.5 18.5h9.6a4 4 0 0 0 .5-7.97 5.6 5.6 0 0 0-10.8 1.2 3.4 3.4 0 0 0 .7 6.77z', 'M12 16v-4.5', 'M9.8 13.6L12 11.4l2.2 2.2'],
  server: ['r 4 4 16 7 1.5', 'r 4 13 16 7 1.5', 'M8 7.5h.01', 'M8 16.5h.01'],
  laptop: ['r 5 5 14 10 1.5', 'M3 19h18'],
  direct: ['M5 8h13', 'M15 4.5L18.5 8 15 11.5', 'M19 16H6', 'M9 12.5L5.5 16 9 19.5'],
  clip: ['M19.5 11.2l-7.6 7.6a4.8 4.8 0 0 1-6.8-6.8l8.3-8.3a3.2 3.2 0 0 1 4.5 4.5l-8.3 8.3a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6'],
  paste: ['r 6 5 12 16 2', 'M9 5V4.2a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 4.2V5', 'M9 11h6', 'M9 15h4'],
  send: ['M4.5 12.2L19.5 5l-4.7 14.8-3.2-6.4z', 'M11.6 13.4L19.5 5'],
  reply: ['M9.5 7L4.5 12l5 5', 'M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19'],
  copy: ['r 8.5 8.5 11.5 11.5 2', 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5'],
  tag: ['M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.6 8.6a1.4 1.4 0 0 1 0 2l-6.8 6.8a1.4 1.4 0 0 1-2 0z', 'M8 8h.01'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.2 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.8a1.5 1.5 0 0 0 1.5-1.3L17.8 7', 'M10 11v5.5', 'M14 11v5.5'],
  pin: ['M9 3.5h6', 'M10 3.5v6L7 13.5h10l-3-4v-6', 'M12 13.5V20.5'],
  edit: ['M4.5 19.5h3.8L19 8.8a2 2 0 0 0 0-2.8l-1-1a2 2 0 0 0-2.8 0L4.5 15.7z', 'M14 6.2l3.8 3.8'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  play: ['M8 5.5v13l10.5-6.5z'],
  file: ['M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z', 'M13.5 3.5V9H19'],
  image: ['r 3.5 5 17 14 2', 'c 8.5 10 1.6', 'M20.5 15.5l-4.8-4.8L7 19'],
  film: ['r 3.5 6 12 12 2', 'M15.5 10.2l5-2.7v9l-5-2.7'],
  audio: ['M9 17.5V6.2l10.5-2.2v11.3', 'c 6.6 17.5 2.4', 'c 17.1 15.3 2.4'],
  table: ['r 3.5 4.5 17 15 1.8', 'M3.5 9.5h17', 'M3.5 14.5h17', 'M9.5 4.5v15'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7.5 13.5L12 9l4.5 4.5', 'M5 4h14'],
  share: ['c 17.5 5.5 2.4', 'c 6.5 12 2.4', 'c 17.5 18.5 2.4', 'M8.6 10.8l6.8-4', 'M8.6 13.2l6.8 4'],
  external: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  move: ['M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z', 'M9 13.2h6.5', 'M13.2 10.8l2.4 2.4-2.4 2.4'],
  warn: ['M12 4.2l8.6 15H3.4z', 'M12 10v4', 'M12 16.8h.01'],
  info: ['c 12 12 8.5', 'M12 11v5', 'M12 8h.01'],
  ok: ['c 12 12 8.5', 'M8.3 12.4l2.5 2.5 4.9-5'],
  refresh: ['M19.5 11.5a7.5 7.5 0 1 0-2.2 5.3', 'M19.5 5v6.5H13'],
  eye: ['M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z', 'c 12 12 2.8'],
  qr: ['r 4 4 6 6 1', 'r 14 4 6 6 1', 'r 4 14 6 6 1', 'M14 14h2.5v2.5H14z', 'M18 18h2', 'M20 14v1.5', 'M14 19.5h.01'],
  link: ['M10.2 13.8a3.9 3.9 0 0 0 5.5 0l3-3a3.9 3.9 0 0 0-5.5-5.5l-1 1', 'M13.8 10.2a3.9 3.9 0 0 0-5.5 0l-3 3a3.9 3.9 0 0 0 5.5 5.5l1-1'],
  select: ['r 4 4 16 16 2.5', 'M8.2 12.2l2.6 2.6 5-5.2'],
  sun: ['c 12 12 3.8', 'M12 2.8v1.8', 'M12 19.4v1.8', 'M2.8 12h1.8', 'M19.4 12h1.8', 'M5.5 5.5l1.3 1.3', 'M17.2 17.2l1.3 1.3', 'M5.5 18.5l1.3-1.3', 'M17.2 6.8l1.3-1.3'],
  moon: ['M19.8 14.6A8 8 0 1 1 9.4 4.2a6.4 6.4 0 0 0 10.4 10.4z'],
  monitor: ['r 3 4.5 18 12 1.8', 'M8.5 20h7', 'M12 16.5V20'],
  clock: ['c 12 12 8.5', 'M12 7.5V12l3 2'],
  key: ['c 8 15.5 3.5', 'M10.6 13L19.5 4', 'M16.5 7l2.4 2.4', 'M14.2 9.3l1.8 1.8'],
}

export const ICONS = Object.keys(I)

function shape (s, k) {
  if (s.startsWith('c ')) { const [x, y, r] = s.slice(2).split(' ').map(Number); return <circle key={k} cx={x} cy={y} r={r} /> }
  if (s.startsWith('r ')) { const [x, y, w, h, rx] = s.slice(2).split(' ').map(Number); return <rect key={k} x={x} y={y} width={w} height={h} rx={rx || 0} /> }
  return <path key={k} d={s} />
}

/** <Icon n="search" />. Decorative unless given a title, which then becomes its label. */
export default function Icon ({ n, size = 16, className, title, fill, style }) {
  const parts = I[n]
  if (!parts) return null
  return (
    <svg className={'ic' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} aria-label={title} style={style}>
      {title && <title>{title}</title>}
      {parts.map(shape)}
    </svg>
  )
}

/** The TSDROP mark, in the same colours as the app icon (build/logo.svg): a T, and an S whose
    lower bowl is half a cloud, in a see-through grey box. Fixed colours, not the theme's, so it
    looks the same here as in the launcher and the tray. */
export function Logo ({ size = 20, className }) {
  return (
    <svg className={'logo' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" style={{ flex: 'none', display: 'block' }}>
      <rect x="28" y="28" width="456" height="456" rx="30" fill="#6a6865" fillOpacity=".58" stroke="#e6e3df" strokeOpacity=".75" strokeWidth="22" />
      <g transform="translate(0 26)" fill="none" stroke="#f4f2ef" strokeWidth="46" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M430 100H340A50 50 0 0 0 290 150A50 50 0 0 0 340 200H350A80 80 0 0 1 430 280A80 80 0 0 1 350 360H128A48 48 0 0 1 128 264A56 56 0 0 1 212 215.5" />
        <path d="M84 100H244M164 100V140" />
      </g>
    </svg>
  )
}

/** A circle that empties as a TOTP step runs out. frac is what is left, 0..1. */
export function Ring ({ frac, size = 22, hot }) {
  const r = 9
  const len = 2 * Math.PI * r
  return (
    <svg className={'ring' + (hot ? ' hot' : '')} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} className="ring-track" />
      <circle cx="12" cy="12" r={r} className="ring-fill" strokeDasharray={len}
        strokeDashoffset={len * (1 - Math.max(0, Math.min(1, frac)))} transform="rotate(-90 12 12)" />
    </svg>
  )
}
