const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')

// Fixed UI zoom so the whole interface opens at a comfortable, zoomed-out size
// (no Ctrl +/- zoom — the level is locked here).
const UI_ZOOM_FACTOR = 0.75

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
      zoomFactor: UI_ZOOM_FACTOR,
      // This is a trusted local single-file app. Disabling webSecurity lets the
      // user's chosen AI endpoint be called without browser CORS blocking it.
      webSecurity: false
    }
  })

  Menu.setApplicationMenu(null)
  win.once('ready-to-show', () => { win.maximize(); win.show() })
  // lock the zoom in after load (and keep it fixed if the page ever reloads)
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(UI_ZOOM_FACTOR))
  win.loadFile('study-canvas.html')
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
