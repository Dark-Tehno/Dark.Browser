import { contextBridge, ipcRenderer } from 'electron';

// Preload интерфейса браузера (полоса вкладок и адресная строка).
// Sandbox: можно импортировать только 'electron', без локальных модулей.
const cmd = (name: string, arg?: unknown): void => ipcRenderer.send('chrome:cmd', name, arg);

const api: ChromeApi = {
  platform: process.platform,
  ready: () => cmd('ready'),
  newTab: () => cmd('new-tab'),
  closeTab: (id) => cmd('close-tab', id),
  activate: (id) => cmd('activate', id),
  navigate: (text) => cmd('navigate', text),
  back: () => cmd('back'),
  forward: () => cmd('forward'),
  reload: () => cmd('reload'),
  stop: () => cmd('stop'),
  home: () => cmd('home'),
  toggleBookmark: () => cmd('bookmark'),
  openAccount: () => cmd('account'),
  showMenu: (x, y) => cmd('menu', { x, y }),
  onState: (cb) => {
    ipcRenderer.on('chrome:state', (_e, s: ChromeState) => cb(s));
  },
  onFocusOmnibox: (cb) => {
    ipcRenderer.on('chrome:focus-omnibox', () => cb());
  },
};

contextBridge.exposeInMainWorld('darkChrome', api);
