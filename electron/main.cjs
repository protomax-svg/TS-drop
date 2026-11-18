const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, screen, clipboard, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { execFile } = require('child_process')
const os = require('os')
const crypto = require('crypto')
const { pipeline } = require('stream')
const zlib = require('zlib')

const { Seal, Open, keyBuf } = require('./gcm.cjs')
const { fetchHead } = require('./og.cjs')
const omarchy = require('./omarchy.cjs')

/* Wayland compositors place windows themselves and ignore setPosition, and they
   hand global hotkeys to the compositor, not to us. Both are the compositor's
   call, not a bug to work around here - see the Omarchy section of the README
   for the two lines of Hyprland config that do the same job. */
const WAYLAND = process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)

/* ---------------- direct mode: serve our own files over the tailnet ----------------
   The bytes never touch Nextcloud. They stay here until the other device pulls them.
   WireGuard already encrypts the hop; the token is the access control. */
const blobs = new Map()
let blobServer = null
let blobPort = 0
const BLOBS = () => path.join(app.getPath('userData'), 'blobs.json')
const loadBlobs = () => { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(BLOBS(), 'utf8')))) blobs.set(k, v) } catch (_) {} }
const saveBlobs = () => { try { fs.writeFileSync(BLOBS(), JSON.stringify(Object.fromEntries(blobs))) } catch (_) {} }

/** our 100.64.0.0/10 address - the tailnet one, whatever the interface is called */
function tailnetIp () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const p = a.address.split('.').map(Number)
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return a.address
    }
  }
  return null
}

function startBlobServer () {
  if (blobServer) return blobPort
  const ip = tailnetIp()
  if (!ip) return 0
  let retried = false
  blobServer = http.createServer((req, res) => {
    if (req.url === '/ping') { res.writeHead(200); return res.end('tsdrop') }
    const m = /^\/b\/([A-Za-z0-9_-]{8,64})$/.exec(req.url || '')
    const b = m && blobs.get(m[1])
    if (!b) { res.writeHead(404); return res.end() }
    let size
    try { size = fs.statSync(b.path).size } catch (_) { res.writeHead(410); return res.end('file moved or deleted') }
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' })
    if (req.method === 'HEAD') return res.end()
    const rs = fs.createReadStream(b.path)
    rs.on('error', () => res.destroy())
    rs.pipe(res)
  })
  blobServer.on('error', e => {
    if (e.code === 'EADDRINUSE' && !retried) { retried = true; blobServer.listen(0, ip) } else { blobServer = null; blobPort = 0 }
  })
  blobServer.on('listening', () => { blobPort = blobServer.address().port })
  blobServer.listen(8421, ip)
  return blobPort
}

const DEV = !!process.env.VITE_DEV_SERVER
/* widest the drawer breakpoint reaches (NARROW, 850px in App.jsx) plus room for the chat beside it */
const SIDEBAR_W = 900
let win = null
let tray = null
const lib = u => (u.startsWith('https') ? https : http)

const SIZE_FILE = () => path.join(app.getPath('userData'), 'window.json')
const readSize = () => { try { return JSON.parse(fs.readFileSync(SIZE_FILE(), 'utf8')) } catch (_) { return null } }
/* Wayland gives a frameless window a resize border of its own, so the surface
   comes out a little larger than the size we asked for - 12x22 px on Hyprland.
   Writing that back down would make the window grow by that much on every
   restart, so the margin is measured once and taken off again. */
let chrome = { w: 0, h: 0 }
/* And a tiling compositor resizes the window to fill its slot, which is the
   layout's idea rather than the user's: remembering it would turn the popup
   into a full-height column for good. Anything that fills the screen is taken
   as the compositor talking, and is not written down. */
const saveSize = () => {
  try {
    if (!win || win.isDestroyed()) return
    const [w, h] = win.getSize()
    const wa = screen.getDisplayNearestPoint(win.getBounds()).workArea
    if (w >= wa.width * 0.95 || h >= wa.height * 0.95) return
    fs.writeFileSync(SIZE_FILE(), JSON.stringify({ w: w - chrome.w, h: h - chrome.h }))
  } catch (_) {}
}

const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json')
let prefs = null
const readPrefs = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')) } catch (_) { return {} } }
const savePrefs = () => { try { fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs)) } catch (_) {} }
const isDir = p => { try { return fs.statSync(p).isDirectory() } catch (_) { return false } }
// a dir the user picked once can be an unplugged usb stick by now
const downloadDir = () => {
  if (!prefs) prefs = readPrefs()
  return prefs.downloadDir && isDir(prefs.downloadDir) ? prefs.downloadDir : app.getPath('downloads')
}

/** Put the popup on the tray icon, not in the middle of the screen. */
function place () {
  if (!win || WAYLAND) return   // Wayland: the compositor owns placement, a window rule does this
  const b = win.getBounds()
  const t = tray ? tray.getBounds() : null
  const anchored = !!(t && (t.width > 0 || t.height > 0))
  const probe = anchored ? { x: t.x + Math.round(t.width / 2), y: t.y + Math.round(t.height / 2) } : screen.getCursorScreenPoint()
  const wa = screen.getDisplayNearestPoint(probe).workArea
  let x, y
  if (anchored) {
    x = Math.round(t.x + t.width / 2 - b.width / 2)
    // taskbar on the bottom half -> pop up above the icon, otherwise below it
    y = t.y >= wa.y + wa.height / 2 ? t.y - b.height - 6 : t.y + t.height + 6
  } else {
    // no usable tray geometry (KDE/Wayland): sit in the tray corner anyway
    x = wa.x + wa.width - b.width - 10
    y = wa.y + wa.height - b.height - 10
  }
  win.setPosition(
    Math.round(Math.min(Math.max(x, wa.x + 6), Math.max(wa.x + 6, wa.x + wa.width - b.width - 6))),
    Math.round(Math.min(Math.max(y, wa.y + 6), Math.max(wa.y + 6, wa.y + wa.height - b.height - 6)))
  )
}

function toggle () {
  if (!win) return
  if (win.isVisible() && win.isFocused()) { win.hide(); return }
  place()
  win.show()
  win.focus()
}

function createWindow () {
  const wa = screen.getPrimaryDisplay().workAreaSize
  const saved = readSize() || {}
  const t = omarchy.theme()
  /* The container list is a drawer below 850px (NARROW in App.jsx) and a column above it. The window
     opens wide enough for the column whatever narrower size it was last left at, so the
     sidebar is simply there on every start; resizing down during a session still works. */
  const want = {
    w: Math.min(Math.max(saved.w || 0, SIDEBAR_W), wa.width - 20),
    h: Math.min(saved.h || 860, wa.height - 20),
  }
  win = new BrowserWindow({
    width: want.w,
    height: want.h,
    minWidth: 340, minHeight: 420,
    // the desktop's own background, so the first frame is not a black flash
    frame: false, backgroundColor: (t && t.colors.background) || '#0b0c0c', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  })
  win.once('ready-to-show', () => {
    place()
    win.show()
    /* The surface only takes its real size once the compositor has mapped it, a
       moment after show(), so the margin is measured then and not before. A
       window the compositor has tiled instead is much bigger than it asked for -
       that is the layout, not a frame, so the margin stays zero. */
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const [w, h] = win.getSize()
      const dw = w - want.w; const dh = h - want.h
      if (dw >= 0 && dw < 60 && dh >= 0 && dh < 60) chrome = { w: dw, h: dh }
    }, 500)
  })
  win.on('hide', saveSize)
  win.on('close', e => { if (!app.quitting) { e.preventDefault(); win.hide() } })
  if (DEV) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => toggle())

app.whenReady().then(() => {
  createWindow()
  loadBlobs()
  startBlobServer()
  // The desktop changed theme or font: repaint in the new colours, no restart.
  omarchy.watch(t => {
    if (!win || win.isDestroyed()) return
    if (t && t.colors.background) win.setBackgroundColor(t.colors.background)
    win.webContents.send('omarchy:theme', t)
  })
  // X11 + Windows only; on Wayland bind Ctrl+Insert to `tsdrop` in the compositor (relaunch toggles).
  if (!WAYLAND) globalShortcut.register('Control+Insert', toggle)
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
    // on Wayland the chord is the compositor's, and it is not ours to name
    tray.setToolTip(WAYLAND ? 'TSDROP' : 'TSDROP  ·  Ctrl+Insert')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: WAYLAND ? 'Show / hide' : 'Show / hide  (Ctrl+Insert)', click: toggle },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.quitting = true; app.quit() } },
    ]))
    tray.on('click', toggle)
  } catch (_) {}
})
app.on('before-quit', () => { app.quitting = true; saveSize() })
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {})

// ---- WebDAV over Node http: no CORS, no size limit ----
ipcMain.handle('dav:req', (_e, { method, url, headers, body, timeout }) => new Promise((res, rej) => {
  const b = body == null ? null : Buffer.from(typeof body === 'string' ? body : body.buffer, ...(typeof body === 'string' ? [] : [body.byteOffset, body.byteLength]))
  /* Listings and JSON compress ~10x and the server gzips them when asked. Node does not ask
     by itself (a browser and Android's OkHttp do), so ask here and unpack the reply. File
     transfers go through dav:upload / dav:download and are left alone - media is compressed. */
  const h = { 'Accept-Encoding': 'gzip', ...headers, ...(b ? { 'Content-Length': b.length } : {}) }
  const r = lib(url).request(url, { method, headers: h }, resp => {
    const c = []
    const gz = /gzip/i.test(resp.headers['content-encoding'] || '')
    const src = gz ? resp.pipe(zlib.createGunzip()) : resp
    src.on('data', d => c.push(d))
    src.on('end', () => res({ status: resp.statusCode, text: Buffer.concat(c).toString('utf8') }))
    src.on('error', e => rej(new Error(e.message)))
  })
  r.on('error', e => rej(new Error(e.message)))
  // A server that is switched off does not refuse, it just never answers; without this a
  // probe waits out the OS's TCP timeout (minutes) before the next endpoint gets a turn.
  if (timeout) r.setTimeout(timeout, () => r.destroy(new Error('timed out')))
  if (b) r.write(b)
  r.end()
}))

ipcMain.handle('dav:upload', (_e, { id, url, headers, filePath, key }) => new Promise((res, rej) => {
  let size
  try { size = fs.statSync(filePath).size } catch (e) { return rej(new Error('file gone: ' + filePath)) }
  const k = keyBuf(key)
  let sent = 0, last = 0
  const r = lib(url).request(url, { method: 'PUT', headers: { ...headers, 'Content-Length': size + (k ? 28 : 0) } }, resp => {
    const c = []
    resp.on('data', d => c.push(d))
    resp.on('end', () => res({ status: resp.statusCode, text: Buffer.concat(c).toString('utf8') }))
  })
  r.on('error', e => rej(new Error(e.message)))
  const rs = fs.createReadStream(filePath)
  rs.on('data', c => {
    sent += c.length
    const now = Date.now()
    if (now - last > 120 || sent === size) { last = now; win && win.webContents.send('progress', { id, loaded: sent, total: size }) }
  })
  const done = err => { if (err) rej(new Error(err.message)) }
  if (k) pipeline(rs, new Seal(k), r, done)
  else pipeline(rs, r, done)
}))

/* "save as" means the user picks the spot; everything else drops into the download folder
   next to a name that is still free. A cancelled dialog returns null and saves nothing. */
ipcMain.handle('dav:download', async (_e, o) => {
  if (!o.saveAs) return fetchTo(o, null)
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(downloadDir(), o.name) })
  return r.canceled || !r.filePath ? null : fetchTo(o, r.filePath)
})

const fetchTo = ({ id, url, headers, name, key, dir: into }, pick) => new Promise((res, rej) => {
  const dir = into && isDir(into) ? into : downloadDir()
  let out = pick || path.join(dir, name)
  let n = 1
  while (!pick && fs.existsSync(out)) { const x = path.parse(name); out = path.join(dir, `${x.name} (${n++})${x.ext}`) }
  const k = keyBuf(key)
  const r = lib(url).request(url, { method: 'GET', headers }, resp => {
    if (resp.statusCode >= 400) { resp.resume(); return rej(new Error('HTTP ' + resp.statusCode)) }
    const total = Math.max(0, Number(resp.headers['content-length'] || 0) - (k ? 28 : 0))
    let got = 0, last = 0
    resp.on('data', c => {
      got += c.length
      const now = Date.now()
      if (now - last > 120) { last = now; win && win.webContents.send('progress', { id, loaded: Math.min(got, total || got), total }) }
    })
    const ws = fs.createWriteStream(out)
    const done = err => (err ? rej(new Error(err.message)) : res(out))
    if (k) pipeline(resp, new Open(k), ws, done)
    else pipeline(resp, ws, done)
  })
  r.on('error', e => rej(new Error(e.message)))
  r.end()
})

/* Must always settle. A preview that never answers holds a slot in the renderer's queue,
   and four of those stop every other picture from loading. */
ipcMain.handle('dav:bytes', (_e, { url, headers }) => new Promise(res => {
  let done = false
  const end = o => { if (!done) { done = true; res(o) } }
  const r = lib(url).request(url, { method: 'GET', headers, timeout: 30000 }, resp => {
    if (resp.statusCode >= 400) { resp.resume(); return end({ status: resp.statusCode, data: null }) }
    const c = []
    resp.on('data', d => c.push(d))
    resp.on('end', () => end({ status: resp.statusCode, data: Buffer.concat(c) }))
    resp.on('error', e => end({ status: 0, data: null, error: e.message }))
  })
  r.on('timeout', () => r.destroy(new Error('timed out')))
  r.on('error', e => end({ status: 0, data: null, error: e.message }))
  r.end()
}))

ipcMain.handle('read', (_e, p) => fs.promises.readFile(p).catch(() => null))

ipcMain.handle('omarchy:theme', () => omarchy.theme())

ipcMain.handle('og', (_e, url) => fetchHead(url))
ipcMain.handle('copy', (_e, t) => clipboard.writeText(String(t)))
ipcMain.handle('copyImage', (_e, b) => {
  const img = nativeImage.createFromBuffer(Buffer.from(b))
  if (img.isEmpty()) return false
  clipboard.writeImage(img)
  return true
})

ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
  if (r.canceled) return []
  return r.filePaths.map(p => ({ name: path.basename(p), size: fs.statSync(p).size, path: p }))
})

ipcMain.handle('getDownloadDir', () => downloadDir())

ipcMain.handle('setDownloadDir', async (_e, p) => {
  if (!p) {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled) return downloadDir()
    p = r.filePaths[0]
  }
  if (!isDir(p)) return downloadDir()
  if (!prefs) prefs = readPrefs()
  prefs.downloadDir = p
  savePrefs()
  return p
})

ipcMain.handle('pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

/* ponytail: flat capped walk (5000 files / 400 dirs), no watcher, no incremental index -
   a folder past that needs fs.watch plus a persisted index, not a bigger cap */
ipcMain.handle('listDir', (_e, { path: dir, recurse }) => {
  const out = []
  const queue = [dir]
  let dirs = 0
  while (queue.length && out.length < 5000 && dirs < 400) {
    dirs++
    let ents
    const d = queue.shift()
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { continue }
    for (const e of ents) {
      // symlinks skipped: a loop would walk forever, and the target is listed on its own
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (recurse) queue.push(p); continue }
      if (!e.isFile()) continue
      try { const s = fs.statSync(p); out.push({ name: e.name, size: s.size, mtime: s.mtimeMs, path: p }) } catch (_) {}
      if (out.length >= 5000) break
    }
  }
  return out
})

ipcMain.handle('serve', (_e, f) => {
  startBlobServer()
  const ip = tailnetIp()
  if (!ip || !blobPort) return null
  const token = crypto.randomBytes(12).toString('base64url')
  blobs.set(token, { path: f.path, name: f.name, size: f.size })
  saveBlobs()
  return { ip, port: blobPort, token }
})
ipcMain.handle('unserve', (_e, token) => { blobs.delete(token); saveBlobs() })

ipcMain.handle('paste', () => {
  /* Wayland hands the clipboard over lazily: until the formats have been asked
     for, read() answers an empty string for a list of files that is plainly
     there. Asking is what fills Electron's copy of it. Cheap, and a no-op on
     Windows and X11. */
  const formats = clipboard.availableFormats()

  // a copied FILE keeps its original bytes - no re-encode, EXIF intact
  const paths = []
  try {
    // GNOME Files, which is Omarchy's, writes its own format: "copy\n<uri>\n<uri>"
    const uris = clipboard.read('text/uri-list') ||
      (formats.includes('x-special/gnome-copied-files')
        ? clipboard.read('x-special/gnome-copied-files').replace(/^(copy|cut)\r?\n/, '')
        : '')
    for (const line of String(uris || '').split(/\r?\n/)) {
      if (!line.startsWith('file://')) continue
      const p = decodeURIComponent(new URL(line).pathname)
      if (fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p)
    }
  } catch (_) {}
  if (!paths.length && process.platform === 'win32') {
    try {
      const b = clipboard.readBuffer('FileNameW')
      const p = b.toString('ucs2').replace(/\0+$/, '')
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) paths.push(p)
    } catch (_) {}
  }
  if (paths.length) return paths.map(p => ({ name: path.basename(p), size: fs.statSync(p).size, path: p }))

  // a raw bitmap (screenshot) has no original file, so PNG is the lossless choice
  const img = clipboard.readImage()
  if (img.isEmpty()) return []
  const buf = img.toPNG()
  const out = path.join(app.getPath('temp'), `pasted-${Date.now()}.png`)
  fs.writeFileSync(out, buf)
  return [{ name: path.basename(out), size: buf.length, path: out }]
})

ipcMain.handle('stat', (_e, p) => { try { const s = fs.statSync(p); return { name: path.basename(p), size: s.size, path: p } } catch (e) { return null } })
ipcMain.handle('hide', () => win && win.hide())
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p))
ipcMain.handle('openPath', (_e, p) => shell.openPath(p))

/* Reading a QR off a screenshot. Chromium has a decoder (BarcodeDetector) but not on
   linux, so the vault's import falls back here. zbar is a two-second pacman install and
   nothing else in the app needs it, so it stays optional and says so when it is absent. */
ipcMain.handle('qr', (_e, p) => new Promise(res => {
  execFile('zbarimg', ['-q', '--raw', p], { maxBuffer: 4e6 }, (err, stdout) => {
    if (err && err.code === 'ENOENT') return res({ err: 'no QR reader here — install zbar (sudo pacman -S zbar), or paste the otpauth:// link instead' })
    res({ text: String(stdout || '').trim() })
  })
}))

ipcMain.handle('tailscale', () => new Promise(res => {
  execFile('tailscale', ['status', '--json'], { maxBuffer: 16e6 }, (err, stdout) => {
    if (err) return res(null)
    try {
      const j = JSON.parse(stdout)
      res({
        state: j.BackendState,
        tailnet: (j.CurrentTailnet && j.CurrentTailnet.Name) || j.MagicDNSSuffix || '',
        self: ((j.Self && j.Self.DNSName) || '').replace(/\.$/, ''),
        selfIp: ((j.Self && j.Self.TailscaleIPs) || [])[0] || '',
        peers: Object.values(j.Peer || {}).map(p => ({
          host: (p.DNSName || '').replace(/\.$/, ''), ip: (p.TailscaleIPs || [])[0] || '',
          os: p.OS || '', online: !!p.Online,
        })).sort((a, b) => (b.online - a.online) || a.host.localeCompare(b.host)),
      })
    } catch (e) { res(null) }
  })
}))
