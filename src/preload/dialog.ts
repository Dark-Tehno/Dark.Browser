import { contextBridge, ipcRenderer } from 'electron';

const api: BrowserDialogApi = {
  onShow: (cb) => {
    ipcRenderer.on('browser-dialog:show', (_event, data: BrowserDialogData) => cb(data));
  },
  respond: (id, response, value) => {
    ipcRenderer.send('browser-dialog:response', id, response, value);
  },
};

contextBridge.exposeInMainWorld('darkDialog', api);