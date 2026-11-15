const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notes', {
  list: () => ipcRenderer.invoke('notes:list'),
  save: (n) => ipcRenderer.invoke('notes:save', n),
  remove: (id) => ipcRenderer.invoke('notes:delete', id),
  exportPdf: () => ipcRenderer.invoke('export:pdf'),
});
