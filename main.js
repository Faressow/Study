const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

// UI zoom (Ctrl +/−/0) persisted across launches, like a browser remembers page zoom
const zoomFile = () => path.join(app.getPath('userData'), 'zoom.json')
function loadZoom() {
  try { return JSON.parse(fs.readFileSync(zoomFile(), 'utf8')).level || 0 } catch { return 0 }
}
function applyZoom(win, delta, reset) {
  const wc = win.webContents
  const level = reset ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta))
  wc.setZoomLevel(level)
  try { fs.writeFileSync(zoomFile(), JSON.stringify({ level })) } catch {}
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: false,                       // shown maximized in ready-to-show
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0e0f16',        // matches the app's dark boot background (no white flash)
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // This is a trusted local single-file app. Disabling webSecurity lets the
      // user's chosen AI endpoint be called without browser CORS blocking it.
      webSecurity: false
    }
  })

  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => { win.maximize(); win.show() })
  // no menu bar = no built-in accelerators, so provide them here:
  // F11 fullscreen; Ctrl +/−/0 = browser-style UI zoom (Alt must be up — AltGr
  // on European layouts reports as Ctrl+Alt and must not be hijacked)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen())
      e.preventDefault()
      return
    }
    if ((input.control || input.meta) && !input.alt) {
      if (input.key === '+' || input.key === '=') { applyZoom(win, +1); e.preventDefault() }
      else if (input.key === '-' || input.key === '_') { applyZoom(win, -1); e.preventDefault() }
      else if (input.key === '0') { applyZoom(win, 0, true); e.preventDefault() }
    }
  })
  win.webContents.on('did-finish-load', () => win.webContents.setZoomLevel(loadZoom()))
  win.loadFile('study-canvas.html')
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
