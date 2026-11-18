/* ---------------- Omarchy: the desktop tells us what to look like ----------------
   Omarchy keeps the theme the whole machine is wearing in
   ~/.local/state/omarchy/current/theme - a directory it rewrites every time
   `omarchy theme set` runs. colors.toml in there is the canonical palette, the
   same one the bar, the terminal and Neovim are drawing from. The monospace
   font is fontconfig's answer for `monospace`, which is what `omarchy font set`
   changes.

   We read both, and watch both, so TSDROP changes theme when the desktop does,
   without a restart and without a setting to keep in sync. Nothing here is
   required: on Windows, Android or a plain Linux box there is no state dir,
   theme() returns null and the app keeps its own palette. */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const STATE = path.join(os.homedir(), '.local', 'state', 'omarchy', 'current')
const THEME_DIR = path.join(STATE, 'theme')
const COLORS = path.join(THEME_DIR, 'colors.toml')
const NAME = path.join(STATE, 'theme.name')
// fontconfig is the source of truth for the monospace font; `omarchy font set` writes it.
const FONT_HINT = path.join(os.homedir(), '.config', 'alacritty', 'alacritty.toml')

const read = p => { try { return fs.readFileSync(p, 'utf8') } catch (_) { return null } }

/* colors.toml is flat - `key = "value"` lines and nothing else. A real TOML
   parser would be a dependency for one file shape we already know. */
function parseColors (txt) {
  const out = {}
  for (const line of txt.split('\n')) {
    const m = /^\s*([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"/i.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

let font = null          // last answer from fc-match, kept because theme() is sync
let onFont = null

function refreshFont () {
  execFile('fc-match', ['monospace', '-f', '%{family}'], (err, stdout) => {
    // fc-match hands back an alias list ("JetBrainsMono Nerd Font,JetBrainsMono NF")
    const f = err ? null : String(stdout).split(',')[0].trim()
    if (!f || f === font) return
    font = f
    if (onFont) onFont()
  })
}

/** The theme the desktop is wearing, or null when this is not an Omarchy box. */
function theme () {
  const txt = read(COLORS)
  if (!txt) return null
  const colors = parseColors(txt)
  if (!colors.background || !colors.foreground) return null
  return {
    name: (read(NAME) || '').trim() || 'omarchy',
    mode: colors.mode === 'light' ? 'light' : 'dark',
    font,
    colors,
  }
}

const present = () => !!read(COLORS)

/** Call back whenever the desktop's theme or font changes. Returns a stop(). */
function watch (cb) {
  if (!present()) return () => {}
  let last = JSON.stringify(theme())
  let timer = null
  let watchers = []
  let stopped = false

  const fire = () => {
    const now = JSON.stringify(theme())
    if (now === last) return
    last = now
    cb(theme())
  }
  // Theme files are rewritten in a burst; one callback at the end of it is enough.
  const ping = () => {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(() => { arm(); fire() }, 120)
  }

  /* `omarchy theme set` can replace the whole theme directory, which leaves a
     watch on it pointing at an inode nobody writes to again. Re-arm on every
     event rather than trusting the first set of handles. */
  const arm = () => {
    for (const w of watchers) { try { w.close() } catch (_) {} }
    watchers = []
    for (const p of [STATE, THEME_DIR, FONT_HINT]) {
      try { watchers.push(fs.watch(p, { persistent: false }, ping)) } catch (_) {}
    }
  }

  onFont = fire
  arm()
  refreshFont()
  return () => {
    stopped = true
    clearTimeout(timer)
    onFont = null
    for (const w of watchers) { try { w.close() } catch (_) {} }
    watchers = []
  }
}

refreshFont()

module.exports = { theme, watch, present }
