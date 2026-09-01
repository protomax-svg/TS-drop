const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, screen, clipboard, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { execFile } = require('child_process')
const os = require('os')
const crypto = require('crypto')
const { pipeline } = require('stream')

const { Seal, Open, keyBuf } = require('./gcm.cjs')
const { fetchHead } = require('./og.cjs')

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
let win = null
let tray = null
let grown = 0        // px the file manager pane adds to the window width right now
let lastGrow = 380   // the width the pane had when last open, restored on reopen
let lastW = 0        // last width the resize watcher saw
/* With the file manager open the chat pane is pinned in CSS, so every manual width change
   the user makes belongs to that pane. Tracking it keeps closing the pane exact. */
const watchResize = () => {
  if (!win || win.isDestroyed()) return
  const [w] = win.getSize()
  if (lastW && grown > 0) { grown = Math.max(0, grown + (w - lastW)); if (grown > 0) lastGrow = grown }
  lastW = w
}

const lib = u => (u.startsWith('https') ? https : http)

const SIZE_FILE = () => path.join(app.getPath('userData'), 'window.json')
const readSize = () => { try { return JSON.parse(fs.readFileSync(SIZE_FILE(), 'utf8')) } catch (_) { return null } }
const saveSize = () => { try { if (win && !win.isDestroyed()) { const [w, h] = win.getSize(); fs.writeFileSync(SIZE_FILE(), JSON.stringify({ w: w - grown, h })) } } catch (_) {} }

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
  if (!win) return
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
  win = new BrowserWindow({
    width: Math.min(saved.w || 520, wa.width - 20),
    height: Math.min(saved.h || 860, wa.height - 20),
    minWidth: 340, minHeight: 420,
    frame: false, backgroundColor: '#0b0c0c', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  })
  win.once('ready-to-show', () => { place(); win.show() })
  win.on('hide', saveSize)
  win.on('resize', watchResize)
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
  // X11 + Windows only; on Wayland bind Ctrl+Insert to the app command in system settings (relaunch toggles).
  globalShortcut.register('Control+Insert', toggle)
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')))
    tray.setToolTip('TSDROP  ·  Ctrl+Insert')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / hide  (Ctrl+Insert)', click: toggle },
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
ipcMain.handle('dav:req', (_e, { method, url, headers, body }) => new Promise((res, rej) => {
  const b = body == null ? null : Buffer.from(typeof body === 'string' ? body : body.buffer, ...(typeof body === 'string' ? [] : [body.byteOffset, body.byteLength]))
  const r = lib(url).request(url, { method, headers: b ? { ...headers, 'Content-Length': b.length } : headers }, resp => {
    const c = []
    resp.on('data', d => c.push(d))
    resp.on('end', () => res({ status: resp.statusCode, text: Buffer.concat(c).toString('utf8') }))
  })
  r.on('error', e => rej(new Error(e.message)))
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

const fetchTo = ({ id, url, headers, name, key }, pick) => new Promise((res, rej) => {
  const dir = downloadDir()
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
  // a copied FILE keeps its original bytes - no re-encode, EXIF intact
  const paths = []
  try {
    const uris = clipboard.read('text/uri-list')
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
/* The file manager is a column to the LEFT, so the window grows leftwards: the right edge
   stays put and the chat panes never move under the cursor. */
ipcMain.handle('grow', (_e, px) => {
  if (!win || win.isDestroyed()) return 0
  const want = (Math.round(px) || 0) > 0 ? lastGrow : 0
  const b = win.getBounds()
  const base = b.width - grown
  const wa = screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y }).workArea
  const w = Math.max(base, Math.min(base + want, wa.width - 12))
  grown = w - base
  lastW = w                     // the resize this triggers is ours, not the user dragging
  const right = b.x + b.width
  win.setBounds({ x: Math.max(wa.x + 6, Math.min(right - w, wa.x + wa.width - w - 6)), y: b.y, width: w, height: b.height })
  return grown
})
ipcMain.handle('hide', () => win && win.hide())
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p))
ipcMain.handle('openPath', (_e, p) => shell.openPath(p))

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
