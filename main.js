const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
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
  win.loadFile('study-canvas.html')
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
