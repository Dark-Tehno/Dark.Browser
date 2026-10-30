import { contextBridge, ipcRenderer } from 'electron';

const api: BrowserDialogApi = {
  onShow: (cb) => {
    ipcRenderer.on('browser-dialog:show', (_event, data: BrowserDialogData) => cb(data));
  },
  respond: (id, response) => {
    ipcRenderer.send('browser-dialog:response', id, response);
  },
};

contextBridge.exposeInMainWorld('darkDialog', api);
