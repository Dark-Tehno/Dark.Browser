import { BrowserWindow, Menu, app, ipcMain, net, protocol, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccountService, API_BASE } from './account';
import { JsonStore } from './store';
import { CHROME_HEIGHT, TabManager, isInternal, isNavigable } from './tabs';
import { SEARCH_ENGINES, isExternalScheme, resolveInput, searchUrl } from '../shared/omnibox';

const PARTITION = 'persist:dark';
const DIST = path.join(__dirname, '..');
const PAGES = new Set(['home', 'account', 'settings', 'bookmarks', 'history', 'error']);
const ASSET_EXT = new Set(['.html', '.js', '.css', '.svg', '.png']);
const DEV = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([{ scheme: 'dark', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

interface Library {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  lastTabs: string[];
}

let win: BrowserWindow | null = null;
let tabs: TabManager;
let settings: JsonStore<BrowserSettings>;
let library: JsonStore<Library>;
let account: AccountService;
let pushTimer: NodeJS.Timeout | null = null;

type BrowserDialogOptions = Omit<BrowserDialogData, 'id'>;

function showBrowserDialog(options: Partial<BrowserDialogOptions> & Pick<BrowserDialogOptions, 'kind' | 'title' | 'message'>): Promise<number> {
  const parent = win;
  const buttons = options.buttons ?? ['Закрыть'];
  const cancelId = options.cancelId ?? Math.max(0, buttons.length - 1);
  if (!parent || parent.isDestroyed()) return Promise.resolve(cancelId);

  const id = randomUUID();
  const data: BrowserDialogData = {
    id,
    kind: options.kind,
    title: options.title,
    message: options.message,
    ...(options.detail ? { detail: options.detail } : {}),
    buttons,
    defaultId: options.defaultId ?? 0,
    cancelId,
  };
  let popup: BrowserWindow;
  try {
    popup = new BrowserWindow({
      width: 500,
      height: 280,
      parent,
      modal: true,
      frame: false,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#0a0d18',
      webPreferences: {
        preload: path.join(DIST, 'preload', 'dialog.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      ipcMain.removeListener('browser-dialog:response', onResponse);
    };
    const finish = (response: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
      if (!popup.isDestroyed()) popup.close();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!popup.isDestroyed()) popup.close();
      reject(error);
    };
    const onResponse = (event: IpcMainEvent, dialogId: unknown, response: unknown): void => {
      if (event.sender !== popup.webContents || dialogId !== id || !Number.isInteger(response)) return;
      const index = response as number;
      if (index >= 0 && index < buttons.length) finish(index);
    };

    ipcMain.on('browser-dialog:response', onResponse);
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.webContents.once('dom-ready', () => {
      if (!settled) popup.webContents.send('browser-dialog:show', data);
    });
    popup.webContents.once('did-fail-load', (_event, code, description) => {
      if (code !== -3) fail(new Error(`Не удалось открыть окно браузера: ${description} (${code})`));
    });
    popup.once('ready-to-show', () => {
      if (!settled) popup.show();
    });
    popup.once('closed', () => finish(cancelId));
    void popup.loadFile(path.join(DIST, 'chrome', 'dialog.html')).catch(fail);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const url = argv.find((a) => /^https?:\/\//i.test(a));
      if (url) tabs.create(url);
    }
  });
  void app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    library?.flush();
    settings?.flush();
    account?.flush();
  });
  // Жёстко запрещаем <webview> и неожиданные окна во всех webContents.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

// ───────────────────────── запуск ─────────────────────────

function start(): void {
  const userData = app.getPath('userData');
  settings = new JsonStore<BrowserSettings>(path.join(userData, 'settings.json'), {
    searchEngine: 'duckduckgo',
    homepage: 'dark://home',
    restoreTabs: true,
  });
  library = new JsonStore<Library>(path.join(userData, 'library.json'), { bookmarks: [], history: [], lastTabs: [] });
  account = new AccountService(userData);
  account.on('change', () => {
    broadcastAccount();
    pushState();
  });

  setupSession();
  createWindow();
  registerIpc();
  buildMenu();
}

function setupSession(): void {
  const ses = session.fromPartition(PARTITION);

  // Чистый UA как у обычного Chrome (без «Electron/…» и имени приложения):
  // с лишними токенами Google и часть других сайтов считают клиент ботом.
  const platform =
    process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const ua = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
  const langs = Array.from(new Set([...app.getPreferredSystemLanguages(), 'en-US'])).join(',');
  ses.setUserAgent(ua, langs);

  const decided = new Map<string, boolean>();
  const AUTO = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
  const ASK: Record<string, string> = { media: 'камере и микрофону', geolocation: 'геопозиции', notifications: 'уведомлениям' };
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (AUTO.has(permission)) return callback(true);
    const label = ASK[permission];
    const url = details.requestingUrl;
    if (!label || !/^https:/i.test(url)) return callback(false);
    const origin = new URL(url).origin;
    const key = `${origin}|${permission}`;
    const known = decided.get(key);
    if (known !== undefined) return callback(known);
    void showBrowserDialog({
      kind: 'question',
      title: 'Запрос разрешения',
      message: `${origin} запрашивает доступ к ${label}.`,
      buttons: ['Разрешить', 'Запретить'],
      defaultId: 1,
      cancelId: 1,
    })
      .then((response) => {
        decided.set(key, response === 0);
        callback(response === 0);
      })
      .catch((error: unknown) => {
        console.error('Не удалось показать запрос разрешения:', error);
        callback(false);
      });
  });

  // dark://<страница>/… → dist/pages, dark://assets/… → dist/static
  ses.protocol.handle('dark', (req) => {
    const u = new URL(req.url);
    const name = path.basename(decodeURIComponent(u.pathname));
    let file: string | null = null;
    if (u.hostname === 'assets') file = path.join(DIST, 'static', name);
    else if (PAGES.has(u.hostname)) file = path.join(DIST, 'pages', name || `${u.hostname}.html`);
    if (!file || !ASSET_EXT.has(path.extname(file))) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow(): void {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Dark Browser',
    backgroundColor: '#0a0d18',
    icon: path.join(DIST, '..', 'build', 'icon.png'),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(mac
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: '#0a0d18', symbolColor: '#9aa2c7', height: 40 } }),
    webPreferences: {
      preload: path.join(DIST, 'preload', 'chrome.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const w = win;
  w.setMenuBarVisibility(false);
  w.once('ready-to-show', () => w.show());
  void w.loadFile(path.join(DIST, 'chrome', 'index.html'));
  if (DEV) w.webContents.openDevTools({ mode: 'detach' });

  tabs = new TabManager(w, path.join(DIST, 'preload', 'page.js'), PARTITION, {
    changed: pushState,
    visited: addHistory,
    searchUrl: (text) => searchUrl(settings.get().searchEngine, text),
    external: openExternalLink,
    focusOmnibox: () => {
      w.webContents.focus();
      w.webContents.send('chrome:focus-omnibox');
    },
    empty: () => w.close(),
  });

  w.on('resize', () => tabs.layout());
  w.on('enter-full-screen', () => tabs.layout());
  w.on('leave-full-screen', () => tabs.layout());
  w.on('close', () => {
    library.patch({ lastTabs: tabs.urls() });
    library.flush();
  });
  w.on('closed', () => {
    win = null;
  });

  // Стартовые вкладки.
  const { restoreTabs, homepage } = settings.get();
  const cli = process.argv.filter((a) => /^https?:\/\//i.test(a));
  const initial = cli.length ? cli : restoreTabs && library.get().lastTabs.length ? library.get().lastTabs : [homepage];
  initial.forEach((u, i) => tabs.create(u, i === initial.length - 1));
}

// ───────────────────────── состояние интерфейса ─────────────────────────

function pushState(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!win || win.isDestroyed()) return;
    const snap = tabs.snapshot();
    const active = tabs.active();
    const acc = account.state();
    if (active) win.setTitle(`${snap.tabs.find((t) => t.active)?.title ?? ''} — Dark Browser`);
    const state: ChromeState = {
      ...snap,
      bookmarked: !!active && library.get().bookmarks.some((b) => b.url === active.url),
      account: {
        signedIn: acc.signedIn,
        username: acc.user?.username ?? null,
        avatar: acc.avatarData ?? acc.user?.avatar ?? null,
      },
    };
    win.webContents.send('chrome:state', state);
  }, 30);
}

function broadcastAccount(): void {
  const s = account.state();
  for (const t of tabs?.all() ?? []) {
    if (isInternal(t.url) && !t.view.webContents.isDestroyed()) t.view.webContents.send('account:changed', s);
  }
}

function addHistory(url: string, title: string): void {
  const h = library.get().history;
  const now = Date.now();
  if (h[0]?.url === url) {
    library.patch({ history: [{ url, title: title || h[0].title, visited: now }, ...h.slice(1)] });
    return;
  }
  library.patch({ history: [{ url, title, visited: now }, ...h].slice(0, 2000) });
}

function toggleBookmark(): void {
  const t = tabs.active();
  if (!t || !isNavigable(t.url) || t.url === 'about:blank' || t.url.startsWith('dark://error')) return;
  const list = library.get().bookmarks;
  if (list.some((b) => b.url === t.url)) library.patch({ bookmarks: list.filter((b) => b.url !== t.url) });
  else {
    const title = t.view.webContents.getTitle().replace(/ — Dark\.Browser$/, '') || t.url;
    library.patch({ bookmarks: [{ id: randomUUID(), title, url: t.url, added: Date.now() }, ...list] });
  }
  pushState();
}

const SCHEME_NAMES: Record<string, string> = {
  tg: 'Telegram', mailto: 'почтовую программу', tel: 'приложение для звонков', sms: 'приложение для сообщений',
  viber: 'Viber', whatsapp: 'WhatsApp', skype: 'Skype', discord: 'Discord', steam: 'Steam', spotify: 'Spotify',
  zoommtg: 'Zoom', zoomus: 'Zoom', msteams: 'Microsoft Teams', slack: 'Slack',
};
let externalBusy = false;

/** Открывает tg://, mailto: и т. п. во внешнем приложении. Ссылки со страниц — после подтверждения. */
function openExternalLink(url: string, from: string): void {
  if (!isExternalScheme(url) || externalBusy) return;
  if (DEV) console.log('[external]', url);
  const open = (): void => void shell.openExternal(url).catch(() => undefined);
  if (!from) return open(); // адрес ввёл сам пользователь
  externalBusy = true;
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
  let host = '';
  try {
    host = new URL(from).host;
  } catch {
    /* без адреса */
  }
  void showBrowserDialog({
    kind: 'question',
    title: 'Открыть во внешнем приложении',
    message: `Открыть ссылку в приложении: ${SCHEME_NAMES[scheme] ?? scheme}?`,
    detail: `${host ? `Сайт: ${host}\n` : ''}${url.slice(0, 300)}`,
    buttons: ['Открыть', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
  })
    .then((response) => {
      if (response === 0) open();
    })
    .catch((error: unknown) => {
      console.error('Не удалось показать подтверждение внешней ссылки:', error);
    })
    .finally(() => {
      externalBusy = false;
    });
}

const homepage = (): string => settings.get().homepage;
const resolve = (text: string): string => resolveInput(text, settings.get().searchEngine, homepage());

// ───────────────────────── IPC ─────────────────────────

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');

function fromInternalPage(e: IpcMainInvokeEvent): boolean {
  const f = e.senderFrame;
  return !!f && f === e.sender.mainFrame && f.url.startsWith('dark://');
}

function page<A extends unknown[], R>(channel: string, fn: (...a: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromInternalPage(e)) throw new Error('Доступ запрещён');
    return fn(...(args as A));
  });
}

function registerIpc(): void {
  // — интерфейс браузера —
  ipcMain.on('chrome:cmd', (e: IpcMainEvent, cmd: string, arg?: unknown) => {
    if (!win || e.sender !== win.webContents) return;
    switch (cmd) {
      case 'ready':
        pushState();
        break;
      case 'new-tab':
        tabs.create(homepage());
        break;
      case 'close-tab':
        if (typeof arg === 'number') tabs.close(arg);
        break;
      case 'activate':
        if (typeof arg === 'number') tabs.activate(arg);
        break;
      case 'navigate': {
        const url = resolve(str(arg, 4000));
        if (isExternalScheme(url)) {
          openExternalLink(url, '');
          break;
        }
        if (!tabs.active()) tabs.create(url);
        else tabs.navigate(url);
        break;
      }
      case 'back':
        tabs.back();
        break;
      case 'forward':
        tabs.forward();
        break;
      case 'reload':
        tabs.reload();
        break;
      case 'stop':
        tabs.stop();
        break;
      case 'home':
        tabs.navigate(homepage());
        break;
      case 'bookmark':
        toggleBookmark();
        break;
      case 'account':
        tabs.openInternal('dark://account');
        break;
      case 'menu': {
        const p = arg as { x?: number; y?: number } | undefined;
        Menu.buildFromTemplate(appMenuItems()).popup({ window: win, x: Math.round(p?.x ?? 0), y: Math.round(p?.y ?? 0) });
        break;
      }
    }
  });

  // — аккаунт —
  page('account:state', () => account.state());
  page('account:login', (u: unknown, p: unknown) => account.login(str(u, 150), str(p, 256)));
  page('account:verify', (id: unknown, code: unknown) => account.verify(str(id, 64), str(code, 16)));
  page('account:resend', (id: unknown) => account.resend(str(id, 64)));
  page('account:register', (d: { email?: unknown; password?: unknown; username?: unknown; language?: unknown }) =>
    account.register({
      email: str(d?.email, 254),
      password: str(d?.password, 256),
      username: str(d?.username, 150) || undefined,
      language: str(d?.language, 16) || undefined,
    }),
  );
  page('account:logout', () => account.logout());
  page('account:profile', () => account.profile());
  page('account:update-profile', (patch: Record<string, unknown>) => account.updateProfile(patch ?? {}));
  page('account:avatar', (f: { name?: unknown; type?: unknown; bytes?: unknown }, access: unknown) => {
    const bytes = f?.bytes;
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('Некорректный файл');
    const buf = bytes instanceof ArrayBuffer ? bytes : (bytes as ArrayBufferView).buffer.slice((bytes as ArrayBufferView).byteOffset, (bytes as ArrayBufferView).byteOffset + (bytes as ArrayBufferView).byteLength);
    return account.uploadAvatar({ name: str(f.name, 200), type: str(f.type, 50), bytes: buf as ArrayBuffer }, str(access, 20) || undefined);
  });
  page('account:devices', () => account.devices());
  page('account:update-device', (id: unknown, patch: { name?: unknown; trusted?: unknown }) =>
    account.updateDevice(str(id, 64), {
      ...(typeof patch?.name === 'string' ? { name: patch.name.slice(0, 100) } : {}),
      ...(typeof patch?.trusted === 'boolean' ? { trusted: patch.trusted } : {}),
    }),
  );
  page('account:delete-device', (id: unknown) => account.deleteDevice(str(id, 64)));
  page('account:login-history', () => account.loginHistory());
  page('account:2fa', () => account.twoFactor());
  page('account:set-2fa', (enabled: unknown) => account.setTwoFactor(enabled === true));

  // — закладки, история, настройки —
  page('bookmarks:list', () => library.get().bookmarks);
  page('bookmarks:add', (title: unknown, url: unknown) => {
    const u = resolve(str(url, 4000));
    const list = library.get().bookmarks;
    if (isNavigable(u) && !list.some((b) => b.url === u)) {
      library.patch({ bookmarks: [{ id: randomUUID(), title: str(title, 200).trim() || u, url: u, added: Date.now() }, ...list] });
      pushState();
    }
    return library.get().bookmarks;
  });
  page('bookmarks:remove', (id: unknown) => {
    library.patch({ bookmarks: library.get().bookmarks.filter((b) => b.id !== id) });
    pushState();
    return library.get().bookmarks;
  });
  page('history:list', () => library.get().history);
  page('history:remove', (url: unknown, visited: unknown) => {
    library.patch({ history: library.get().history.filter((h) => !(h.url === url && h.visited === visited)) });
    return library.get().history;
  });
  page('history:clear', () => {
    library.patch({ history: [] });
    return [];
  });
  page('settings:get', () => settings.get());
  page('settings:set', (patch: Partial<BrowserSettings>) => {
    const next: Partial<BrowserSettings> = {};
    if (typeof patch?.searchEngine === 'string' && patch.searchEngine in SEARCH_ENGINES) next.searchEngine = patch.searchEngine;
    if (typeof patch?.restoreTabs === 'boolean') next.restoreTabs = patch.restoreTabs;
    if (typeof patch?.homepage === 'string') {
      const h = resolveInput(patch.homepage, settings.get().searchEngine, 'dark://home');
      next.homepage = /^(https?|dark):/i.test(h) && !/^https?:\/\/(duckduckgo|yandex|www\.google|www\.bing)/.test(h) ? h : 'dark://home';
    }
    settings.patch(next);
    return settings.get();
  });
  page('about', (): AboutInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    apiBase: API_BASE,
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
  }));
  page('browser:confirm', (message: unknown) =>
    showBrowserDialog({
      kind: 'question',
      title: 'Подтвердите действие',
      message: str(message, 1000),
      buttons: ['Продолжить', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
    }).then((response) => response === 0),
  );
  page('nav:resolve', (text: unknown) => resolve(str(text, 4000)));
}

// ───────────────────────── меню ─────────────────────────

function appMenuItems(): MenuItemConstructorOptions[] {
  const v = app.getVersion();
  return [
    { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: () => tabs.create(homepage()) },
    { label: 'Закладки', accelerator: 'CmdOrCtrl+Shift+O', click: () => tabs.openInternal('dark://bookmarks') },
    { label: 'История', accelerator: 'CmdOrCtrl+H', click: () => tabs.openInternal('dark://history') },
    { label: 'Аккаунт', click: () => tabs.openInternal('dark://account') },
    { label: 'Настройки', accelerator: 'CmdOrCtrl+,', click: () => tabs.openInternal('dark://settings') },
    { type: 'separator' },
    { label: 'Увеличить масштаб', click: () => tabs.zoom(0.5) },
    { label: 'Уменьшить масштаб', click: () => tabs.zoom(-0.5) },
    { label: 'Сбросить масштаб', click: () => tabs.zoom('reset') },
    { type: 'separator' },
    {
      label: 'О Dark Browser',
      click: () =>
        void showBrowserDialog({
          kind: 'info',
          title: 'О Dark Browser',
          message: `Dark Browser ${v}`,
          detail: `Dark.Tehno\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
        }).catch((error: unknown) => console.error('Не удалось показать информацию о браузере:', error)),
    },
    { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ];
}

function buildMenu(): void {
  const t: MenuItemConstructorOptions[] = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: () => tabs.create(homepage()) },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: () => { const a = tabs.active(); if (a) tabs.close(a.id); } },
        { type: 'separator' },
        { label: 'Выход', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
      ],
    },
    {
      label: 'Навигация',
      submenu: [
        { label: 'Адресная строка', accelerator: 'CmdOrCtrl+L', click: () => { win?.webContents.focus(); win?.webContents.send('chrome:focus-omnibox'); } },
        { label: 'Назад', accelerator: 'Alt+Left', click: () => tabs.back() },
        { label: 'Вперёд', accelerator: 'Alt+Right', click: () => tabs.forward() },
        { label: 'Обновить', accelerator: 'CmdOrCtrl+R', click: () => tabs.reload() },
        { label: 'Обновить (F5)', accelerator: 'F5', visible: false, click: () => tabs.reload() },
        { label: 'Домашняя страница', accelerator: 'Alt+Home', click: () => tabs.navigate(homepage()) },
        { type: 'separator' },
        { label: 'Следующая вкладка', accelerator: 'Ctrl+Tab', click: () => tabs.activateRelative(1) },
        { label: 'Предыдущая вкладка', accelerator: 'Ctrl+Shift+Tab', click: () => tabs.activateRelative(-1) },
        { type: 'separator' },
        { label: 'Добавить в закладки', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
        { label: 'Закладки', accelerator: 'CmdOrCtrl+Shift+O', click: () => tabs.openInternal('dark://bookmarks') },
        { label: 'История', accelerator: 'CmdOrCtrl+H', click: () => tabs.openInternal('dark://history') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить масштаб', accelerator: 'CmdOrCtrl+=', click: () => tabs.zoom(0.5) },
        { label: 'Увеличить масштаб (+)', accelerator: 'CmdOrCtrl+Plus', visible: false, click: () => tabs.zoom(0.5) },
        { label: 'Уменьшить масштаб', accelerator: 'CmdOrCtrl+-', click: () => tabs.zoom(-0.5) },
        { label: 'Сбросить масштаб', accelerator: 'CmdOrCtrl+0', click: () => tabs.zoom('reset') },
        { type: 'separator' },
        { label: 'Полный экран', accelerator: 'F11', click: () => win?.setFullScreen(!win.isFullScreen()) },
        { label: 'Инструменты разработчика', accelerator: 'F12', click: () => tabs.active()?.view.webContents.toggleDevTools() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}
