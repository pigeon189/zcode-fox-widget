const path = require('node:path')
const { app, BrowserWindow } = require('electron')

// 测试用的「假 agent」：一个普通窗口，标题固定 FakeAgent，供浮层命中与绑定。
app.disableHardwareAcceleration()

console.log('FAKE_MAIN_RAN')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: 300,
    y: 180,
    width: 420,
    height: 320,
    title: 'FakeAgent',
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  console.log('FAKE_WINDOW_CREATED')
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => console.log('FAKE_READY_TO_SHOW'))
})

app.on('window-all-closed', () => app.quit())
