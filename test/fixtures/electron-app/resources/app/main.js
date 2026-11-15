const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
function createWindow() {
  const win = new BrowserWindow({ width: 1100, height: 720, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.loadFile('renderer/index.html');
}
ipcMain.handle('notes:list', async () => []);
ipcMain.handle('notes:save', async (_e, note) => note);
ipcMain.handle('notes:delete', async (_e, id) => id);
ipcMain.handle('export:pdf', async () => dialog.showSaveDialog({}));
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [{ label: 'New Note', accelerator: 'CmdOrCtrl+N' }, { label: 'Export as PDF' }] }]));
app.whenReady().then(createWindow);
