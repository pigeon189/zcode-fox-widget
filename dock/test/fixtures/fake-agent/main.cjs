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
  // 测试夹具必须稳定处于最前：否则桌面上别的窗口（ZCode/WorkBuddy/浏览器）
  // 一盖住它，拖拽命中的就是别人，测试会随机失败。dock 浮层是 screen-saver 级，
  // 仍然在它之上，命中测试本来就会排除浮层自己。
  win.setAlwaysOnTop(true, 'normal')
  win.moveTop()
  win.once('ready-to-show', () => console.log('FAKE_READY_TO_SHOW'))
})

app.on('window-all-closed', () => app.quit())
