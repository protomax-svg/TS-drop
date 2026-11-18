/* ---------------- wear whatever the desktop is wearing ----------------
   Omarchy hands us the palette the whole machine is themed with (see
   electron/omarchy.cjs). The HUD is built on a dozen CSS variables, so putting
   that palette on is a matter of mapping one onto the other.

   Two tokens do the heavy lifting. `background` is the surface the desktop
   paints bars and terminals with, and `lighter_background` is one step away
   from it - lighter in a dark theme, darker in a light one. Stepping between
   them keeps the panels readable in either, instead of trusting a token to be
   on the side of the colour we hoped. */

const hex = c => {
  const s = String(c || '').trim().replace('#', '')
  const f = s.length === 3 ? s.split('').map(x => x + x).join('') : s
  if (!/^[0-9a-f]{6}$/i.test(f)) return null
  return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16))
}

const str = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

/** t=0 is a, t=1 is b. */
const mix = (a, b, t) => {
  const x = hex(a); const y = hex(b)
  if (!x || !y) return x ? str(x) : null
  return str(x.map((v, i) => v + (y[i] - v) * t))
}

const rgba = (c, a) => {
  const x = hex(c)
  return x ? `rgba(${x[0]},${x[1]},${x[2]},${a})` : null
}

const lum = c => {
  const x = hex(c)
  if (!x) return 0
  const [r, g, b] = x.map(v => (v /= 255, v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratio = (a, b) => {
  const x = lum(a); const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/* A couple of themes pick a dim foreground that all but disappears on their own
   background - fine for a terminal's bright black, too thin for the timestamps
   and labels the HUD writes in it. Walk it toward the text colour until it
   clears `floor`, which keeps the theme's hue and only touches what needs it. */
const legible = (c, bg, fg, floor) => {
  if (!c) return fg
  if (ratio(c, bg) >= floor) return c
  for (let t = 0.1; t < 1; t += 0.1) {
    const v = mix(c, fg, t)
    if (ratio(v, bg) >= floor) return v
  }
  return fg
}

/** The glass variables, in the desktop's colours.
    The desktop palette is used for its hues, not its intensity: backdrop and glass come
    from background and foreground, and the theme's red/green/yellow/blue are mixed well
    toward the background before they colour anything, so a loud theme still ends up as
    muted fills. Text is checked against the backdrop and walked toward the foreground
    until it reads at 4.5:1. */
export function vars (theme) {
  if (!theme || !theme.colors) return null
  const c = theme.colors
  const bg = c.background
  const fg = c.foreground
  const light = theme.mode === 'light' || lum(bg) > 0.4
  const deep = c.darker_background || mix(bg, '#000000', light ? 0.12 : 0.3)
  const bd = light
    ? [mix(bg, '#ffffff', 0.5), mix(bg, '#ffffff', 0.3), bg, mix(bg, fg, 0.08), mix(bg, fg, 0.16)]
    : [mix(bg, fg, 0.3), mix(bg, fg, 0.22), mix(bg, fg, 0.15), mix(bg, fg, 0.07), deep]
  const ground = bd[2]
  const muted = (hue, fallback) => light ? mix(hue || fallback, fg, 0.28) : mix(hue || fallback, bg, 0.42)
  const line = (hue, fallback) => light ? mix(hue || fallback, fg, 0.38) : mix(hue || fallback, fg, 0.32)
  const w = light ? '#ffffff' : fg
  const out = {
    '--bd-a': bd[0], '--bd-b': bd[1], '--bd-c': bd[2], '--bd-d': bd[3], '--bd-e': bd[4],
    '--glass': rgba(w, light ? 0.36 : 0.075),
    '--glass-2': rgba(w, light ? 0.52 : 0.12),
    '--glass-3': rgba(w, light ? 0.72 : 0.19),
    '--content': light ? rgba('#ffffff', 0.28) : rgba(deep, 0.32),
    '--bubble': rgba(w, light ? 0.5 : 0.07),
    '--bubble-mine': rgba(w, light ? 0.74 : 0.125),
    '--field': rgba(w, light ? 0.5 : 0.06),
    // one solid colour behind everything, dialogs and menus included: nothing see-through
    '--bg': ground, '--sheet': ground, '--menu': ground,
    '--hair': rgba(fg, light ? 0.15 : 0.2),
    '--hair-2': rgba(fg, light ? 0.26 : 0.34),
    '--hair-3': rgba(fg, light ? 0.5 : 0.6),
    '--txt': legible(fg, ground, light ? '#000000' : '#ffffff', 7),
    '--dim': legible(mix(fg, ground, 0.26), ground, fg, 4.5),
    '--faint': mix(fg, ground, 0.5),
    '--accent': mix(fg, c.accent || fg, 0.35),
    '--link': mix(fg, c.blue || c.accent || fg, 0.35),
    '--info': muted(c.blue, '#56697b'), '--info-ln': line(c.blue, '#97abbe'),
    '--danger': muted(c.red, '#7e4439'), '--danger-ln': line(c.red, '#d39385'),
    '--ok': muted(c.green, '#5f6b47'), '--ok-ln': line(c.green, '#b0bf8f'),
    '--warn': muted(c.yellow, '#81703f'), '--warn-ln': line(c.yellow, '#d6c07f'),
    '--scrim': rgba(deep, light ? 0.28 : 0.45),
    '--lbox': rgba(deep, 0.93),
    '--drop': rgba(bg, 0.8),
  }
  if (theme.font) out['--mono'] = `"${theme.font}",ui-monospace,"JetBrains Mono","DejaVu Sans Mono",monospace`
  return out
}

const KEYS = ['--bg', '--bd-a', '--bd-b', '--bd-c', '--bd-d', '--bd-e', '--glass', '--glass-2', '--glass-3', '--content',
  '--bubble', '--bubble-mine', '--field', '--sheet', '--menu', '--hair', '--hair-2', '--hair-3', '--txt', '--dim',
  '--faint', '--accent', '--link', '--info', '--info-ln', '--danger', '--danger-ln', '--ok', '--ok-ln', '--warn',
  '--warn-ln', '--scrim', '--lbox', '--drop', '--mono']

/* Inline on <html>, so these win over both :root and :root.light in hud.css
   without the stylesheet having to know the desktop exists. */
export function apply (theme) {
  const el = document.documentElement
  const v = vars(theme)
  if (!v) { clear(); return false }
  for (const k of KEYS) {
    if (v[k]) el.style.setProperty(k, v[k])
    else el.style.removeProperty(k)
  }
  el.classList.toggle('light', theme.mode === 'light')
  return true
}

/** Back to the app's own palette. */
export function clear () {
  const el = document.documentElement
  for (const k of KEYS) el.style.removeProperty(k)
}
