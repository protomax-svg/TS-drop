const { contextBridge, ipcRenderer, webUtils } = require('electron')
const { pathToFileURL } = require('url')

contextBridge.exposeInMainWorld('tsdrop', {
  platform: process.platform,
  req: o => ipcRenderer.invoke('dav:req', o),
  upload: o => ipcRenderer.invoke('dav:upload', o),
  download: o => ipcRenderer.invoke('dav:download', o),
  bytes: o => ipcRenderer.invoke('dav:bytes', o),
  read: p => ipcRenderer.invoke('read', p),
  fileUrl: p => { try { return pathToFileURL(p).href } catch (e) { return null } },
  og: u => ipcRenderer.invoke('og', u),
  copy: t => ipcRenderer.invoke('copy', t),
  copyImage: b => ipcRenderer.invoke('copyImage', b),
  pick: () => ipcRenderer.invoke('pick'),
  paste: () => ipcRenderer.invoke('paste'),
  serve: f => ipcRenderer.invoke('serve', f),
  unserve: t => ipcRenderer.invoke('unserve', t),
  stat: p => ipcRenderer.invoke('stat', p),
  hide: () => ipcRenderer.invoke('hide'),
  reveal: p => ipcRenderer.invoke('reveal', p),
  openPath: p => ipcRenderer.invoke('openPath', p),
  getDownloadDir: () => ipcRenderer.invoke('getDownloadDir'),
  setDownloadDir: p => ipcRenderer.invoke('setDownloadDir', p),
  pickDir: () => ipcRenderer.invoke('pickDir'),
  listDir: o => ipcRenderer.invoke('listDir', o),
  tailscale: () => ipcRenderer.invoke('tailscale'),
  qr: p => ipcRenderer.invoke('qr', p),
  pathOf: f => { try { return webUtils.getPathForFile(f) } catch (e) { return null } },
  onProgress: cb => ipcRenderer.on('progress', (_e, d) => cb(d)),
  // the desktop's current theme (Omarchy), and every change to it
  desktopTheme: () => ipcRenderer.invoke('omarchy:theme'),
  onDesktopTheme: cb => ipcRenderer.on('omarchy:theme', (_e, t) => cb(t)),
})
