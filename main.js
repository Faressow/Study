const { app, BrowserWindow, Menu, session } = require('electron')
const path = require('path')

// Only ONE copy of the app may run at a time. IndexedDB (LevelDB) locks the
// database to a single process — a second instance can't open it and fails with
// "Storage unavailable (Internal error.) — sessions cannot be saved". So if an
// instance is already running, hand off to it (focus its window) and quit this one.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {

// Fixed UI zoom so the whole interface opens at a comfortable, zoomed-out size
// (no Ctrl +/- zoom — the level is locked here).
const UI_ZOOM_FACTOR = 0.75

// Strip CORS from the AI provider responses in the main process instead of
// disabling webSecurity in the renderer. Disabling webSecurity gives the
// file:// page an opaque origin, and IndexedDB refuses to open on an opaque
// origin ("Internal error.") — which broke session saving. This keeps
// webSecurity ON (IndexedDB works) while still letting the user's chosen AI
// endpoint be called without the browser blocking it on CORS.
function enableCorsBypass() {
  const filter = { urls: ['*://*/*'] }   // only real network requests, never file://

  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    const headers = details.responseHeaders || {}
    // drop any existing CORS headers so ours are the only ones
    for (const k of Object.keys(headers)) {
      if (/^access-control-/i.test(k)) delete headers[k]
    }
    headers['Access-Control-Allow-Origin'] = ['*']
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS']
    headers['Access-Control-Allow-Headers'] = ['*, Authorization, Content-Type']
    cb({ responseHeaders: headers })
  })
}

let mainWindow = null

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
      zoomFactor: UI_ZOOM_FACTOR
      // webSecurity stays ON (default) so IndexedDB works; CORS is handled above.
    }
  })

  Menu.setApplicationMenu(null)

  // Fullscreen: F11 toggles, Esc leaves it. There's no menu, so the usual F11
  // accelerator doesn't exist — bind it directly on the window's key events.
  // Fullscreen toggles. Two shortcuts so it works on laptops (e.g. ThinkPads)
  // where the F-key row is hardware-mapped and F11 may not reach the app:
  //   • F11
  //   • Alt+Enter   (function-key-independent)
  // Esc leaves fullscreen. There's no menu, so these are bound on key events.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isF11 = input.key === 'F11'
    const isAltEnter = input.alt && (input.key === 'Enter' || input.code === 'Enter' || input.code === 'NumpadEnter')
    if (isF11 || isAltEnter) {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    } else if (input.key === 'Escape' && win.isFullScreen()) {
      win.setFullScreen(false)
      event.preventDefault()
    }
  })

  win.once('ready-to-show', () => { win.maximize(); win.show() })
  // lock the zoom in after load (and keep it fixed if the page ever reloads)
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(UI_ZOOM_FACTOR))
  win.loadFile('study-canvas.html')
  mainWindow = win
}

// A second launch fires this in the FIRST (running) instance — focus its window
// instead of letting a competing copy open and fight over the database lock.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  enableCorsBypass()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

}   // end single-instance-lock guard
