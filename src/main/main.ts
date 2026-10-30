import { BrowserWindow, Menu, app, ipcMain, net, protocol, safeStorage, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AccountService, API_BASE } from './account';
import { JsonStore } from './store';
import { CHROME_HEIGHT, TabManager, isInternal, isNavigable } from './tabs';
import { SEARCH_ENGINES, isExternalScheme, resolveInput, searchUrl } from '../shared/omnibox';

const PARTITION = 'persist:dark';
const DIST = path.join(__dirname, '..');
const PAGES = new Set(['home', 'account', 'settings', 'bookmarks', 'history', 'downloads', 'blocked', 'error']);
const ASSET_EXT = new Set(['.html', '.js', '.css', '.svg', '.png']);
const DEV = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([{ scheme: 'dark', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

interface Library {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadEntry[];
  lastTabs: string[];
}

let win: BrowserWindow | null = null;
let tabs: TabManager;
interface StoredBrowserSettings extends BrowserSettings {
  proxyPasswordEncrypted: string;
  parentalPinSalt: string;
  parentalPinHash: string;
  parentalLists: Record<ParentalProfile, string[]>;
}
let settings: JsonStore<StoredBrowserSettings>;
let library: JsonStore<Library>;
let account: AccountService;
let pushTimer: NodeJS.Timeout | null = null;
let downloadPushTimer: NodeJS.Timeout | null = null;
let pinFailures = 0;
let pinLockedUntil = 0;
let parentalDomainSet = new Set<string>();
let pageFindQuery = '';

const PARENTAL_LIST_SOURCES: Record<ParentalProfile, string> = {
  adult: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts',
  malware: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
};
const MAX_PARENTAL_LIST_BYTES = 12 * 1024 * 1024;
const MAX_PARENTAL_LIST_DOMAINS = 250_000;

type BrowserDialogOptions = Omit<BrowserDialogData, 'id'>;

type DialogResult = { response: number; value: string | null };

/** Показывает окно браузера и возвращает номер кнопки и (для prompt) введённый текст. */
function openBrowserDialog(options: Partial<BrowserDialogOptions> & Pick<BrowserDialogOptions, 'kind' | 'title' | 'message'>): Promise<DialogResult> {
  const parent = win;
  const buttons = options.buttons ?? ['Закрыть'];
  const cancelId = options.cancelId ?? Math.max(0, buttons.length - 1);
  if (!parent || parent.isDestroyed()) return Promise.resolve({ response: cancelId, value: null });

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
    ...(options.input ? { input: options.input } : {}),
  };
  let popup: BrowserWindow;
  try {
    popup = new BrowserWindow({
      width: 500,
      height: options.input ? 340 : 280,
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

  return new Promise<DialogResult>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      ipcMain.removeListener('browser-dialog:response', onResponse);
    };
    const finish = (response: number, value: string | null = null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ response, value });
      if (!popup.isDestroyed()) popup.close();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!popup.isDestroyed()) popup.close();
      reject(error);
    };
    const onResponse = (event: IpcMainEvent, dialogId: unknown, response: unknown, value?: unknown): void => {
      if (event.sender !== popup.webContents || dialogId !== id || !Number.isInteger(response)) return;
      const index = response as number;
      if (index >= 0 && index < buttons.length) finish(index, typeof value === 'string' ? value.slice(0, 2000) : null);
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

/** Обычное окно с кнопками: возвращает только номер нажатой кнопки. */
function showBrowserDialog(options: Partial<BrowserDialogOptions> & Pick<BrowserDialogOptions, 'kind' | 'title' | 'message'>): Promise<number> {
  return openBrowserDialog(options).then((r) => r.response);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const url = argv.find((a) => /^https?:\/\//i.test(a));
      if (url && tabs) tabs.create(url);
    }
  });
  void app.whenReady().then(start).catch((error: unknown) => {
    console.error('Не удалось запустить браузер:', error);
    app.quit();
  });
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

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  settings = new JsonStore<StoredBrowserSettings>(path.join(userData, 'settings.json'), {
    searchEngine: 'duckduckgo',
    homepage: 'dark://home',
    restoreTabs: true,
    proxyEnabled: false,
    proxyServer: '',
    proxyUsername: '',
    proxyAuthConfigured: false,
    proxyPasswordEncrypted: '',
    parentalEnabled: false,
    blockedDomains: [],
    parentalProfiles: [],
    parentalListCounts: { adult: 0, malware: 0 },
    parentalListsUpdatedAt: null,
    parentalPinConfigured: false,
    parentalPinSalt: '',
    parentalPinHash: '',
    parentalLists: { adult: [], malware: [] },
  });
  refreshParentalDomainCache();
  library = new JsonStore<Library>(path.join(userData, 'library.json'), { bookmarks: [], history: [], downloads: [], lastTabs: [] });
  account = new AccountService(userData);
  account.on('change', () => {
    broadcastAccount();
    pushState();
  });

  await setupSession();
  createWindow();
  registerIpc();
  buildMenu();
}

async function setupSession(): Promise<void> {
  const ses = session.fromPartition(PARTITION);
  const saved = settings.get();
  await ses.setProxy(saved.proxyEnabled ? { proxyRules: saved.proxyServer } : { mode: 'system' });
  if (saved.proxyEnabled) await ses.closeAllConnections();

  app.on('login', (event, webContents, _details, authInfo, callback) => {
    if (!webContents || webContents.session !== ses) return;
    const config = settings.get();
    if (!authInfo.isProxy || !config.proxyEnabled || !config.proxyUsername || !config.proxyPasswordEncrypted) return;
    try {
      const proxy = new URL(config.proxyServer);
      if (proxy.hostname.toLowerCase() !== authInfo.host.toLowerCase() ||
          authInfo.port !== Number(proxy.port || (proxy.protocol === 'https:' ? 443 : proxy.protocol === 'http:' ? 80 : 1080))) return;
      event.preventDefault();
      callback(config.proxyUsername, safeStorage.decryptString(Buffer.from(config.proxyPasswordEncrypted, 'base64')));
    } catch (error) {
      event.preventDefault();
      console.error('Не удалось обработать авторизацию прокси:', error);
      callback('', '');
    }
  });
  ses.on('will-download', (_event, item) => {
    const id = randomUUID();
    const blocked = isParentalDomainBlocked(item.getURL());
    const entry: DownloadEntry = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      path: item.getSavePath(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: 'progress',
      started: Date.now(),
      ended: null,
    };
    updateDownload(entry);
    item.on('updated', (_updateEvent, state) => {
      updateDownload({
        ...entry,
        filename: item.getFilename(),
        path: item.getSavePath(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: state === 'interrupted' ? 'interrupted' : 'progress',
      });
    });
    item.once('done', (_doneEvent, state) => {
      updateDownload({
        ...entry,
        filename: item.getFilename(),
        path: item.getSavePath(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
        ended: Date.now(),
      });
    });
    if (blocked) item.cancel();
  });
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ cancel: details.resourceType !== 'mainFrame' && isParentalDomainBlocked(details.url) });
  });

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
    blocked: isParentalDomainBlocked,
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

function updateDownload(entry: DownloadEntry): void {
  const downloads = library.get().downloads;
  const index = downloads.findIndex((item) => item.id === entry.id);
  const next = index < 0
    ? [entry, ...downloads].slice(0, 1000)
    : downloads.map((item) => item.id === entry.id ? entry : item);
  library.patch({ downloads: next });
  if (downloadPushTimer) return;
  downloadPushTimer = setTimeout(() => {
    downloadPushTimer = null;
    for (const tab of tabs?.all() ?? []) {
      if (tab.url.startsWith('dark://downloads') && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('downloads:changed', library.get().downloads);
      }
    }
  }, 250);
}

function isParentalDomainBlocked(url: string): boolean {
  if (!settings.get().parentalEnabled) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  let domain = hostname;
  while (domain) {
    if (parentalDomainSet.has(domain)) return true;
    const dot = domain.indexOf('.');
    if (dot < 0) break;
    domain = domain.slice(dot + 1);
  }
  return false;
}

function refreshParentalDomainCache(): void {
  const config = settings.get();
  parentalDomainSet = new Set(config.blockedDomains);
  for (const profile of config.parentalProfiles) {
    for (const domain of config.parentalLists[profile] ?? []) parentalDomainSet.add(domain);
  }
}

function enforceParentalBlockOnOpenTabs(): void {
  for (const tab of tabs.all()) {
    if (isParentalDomainBlocked(tab.url)) tabs.navigate(tab.url);
  }
}

function parseParentalList(content: string, profile: ParentalProfile): string[] {
  const domains = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const fields = line.split('#', 1)[0].trim().split(/\s+/);
    if (fields.length < 2 || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(fields[0]) && fields[0] !== '::') continue;
    for (const candidate of fields.slice(1)) {
      const domain = candidate.toLowerCase().replace(/\.$/, '');
      if (domain.length > 253 || !domain.includes('.') || /^\d+(?:\.\d+){3}$/.test(domain)) continue;
      const labels = domain.split('.');
      if (labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) continue;
      domains.add(domain);
      if (domains.size > MAX_PARENTAL_LIST_DOMAINS) {
        throw new Error('Список содержит слишком много доменов.');
      }
    }
  }
  if (domains.size < 1000) throw new Error(`Полученный список «${profile}» пуст или повреждён; сохранённая версия не изменена.`);
  return [...domains];
}

function normalizeParentalProfiles(input: unknown): ParentalProfile[] {
  if (!Array.isArray(input) || input.length > 2) throw new Error('Некорректный набор сценариев защиты.');
  const profiles: ParentalProfile[] = [];
  for (const profile of input) {
    if (profile !== 'adult' && profile !== 'malware') throw new Error('Некорректный набор сценариев защиты.');
    profiles.push(profile);
  }
  return [...new Set(profiles)];
}

async function fetchParentalList(profile: ParentalProfile): Promise<string[]> {
  const response = await net.fetch(PARENTAL_LIST_SOURCES[profile], {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Источник списка «${profile}» вернул HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_PARENTAL_LIST_BYTES) throw new Error(`Список «${profile}» превышает допустимый размер.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Источник списка «${profile}» вернул пустой ответ.`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PARENTAL_LIST_BYTES) {
        void reader.cancel();
        throw new Error(`Список «${profile}» превышает допустимый размер.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseParentalList(new TextDecoder().decode(bytes), profile);
}

function normalizeBlockedDomains(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Укажите не более 100 доменов.');
  const domains = new Set<string>();
  for (const value of input) {
    if (typeof value !== 'string' || value.length > 300) throw new Error('Некорректный домен в списке.');
    const raw = value.trim().toLowerCase();
    if (!raw) continue;
    let hostname: string;
    try {
      hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      throw new Error(`Некорректный домен: ${raw}`);
    }
    if (!hostname || !/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
      throw new Error(`Некорректный домен: ${raw}`);
    }
    domains.add(hostname);
  }
  return [...domains];
}

function publicSettings(): BrowserSettings {
  const current = settings.get();
  return {
    searchEngine: current.searchEngine,
    homepage: current.homepage,
    restoreTabs: current.restoreTabs,
    proxyEnabled: current.proxyEnabled,
    proxyServer: current.proxyServer,
    proxyUsername: current.proxyUsername,
    proxyAuthConfigured: !!current.proxyPasswordEncrypted,
    parentalEnabled: current.parentalEnabled,
    blockedDomains: [...current.blockedDomains],
    parentalProfiles: [...current.parentalProfiles],
    parentalListCounts: {
      adult: current.parentalLists.adult?.length ?? 0,
      malware: current.parentalLists.malware?.length ?? 0,
    },
    parentalListsUpdatedAt: current.parentalListsUpdatedAt,
    parentalPinConfigured: !!current.parentalPinSalt && !!current.parentalPinHash,
  };
}

function verifyParentalPin(pin: unknown): boolean {
  const current = settings.get();
  if (!current.parentalPinSalt || !current.parentalPinHash || typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) return false;
  const actual = scryptSync(pin, Buffer.from(current.parentalPinSalt, 'base64'), 64);
  const expected = Buffer.from(current.parentalPinHash, 'base64');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function requireParentalPin(pin: unknown): void {
  const remaining = pinLockedUntil - Date.now();
  if (remaining > 0) throw new Error(`Слишком много попыток. Повторите через ${Math.ceil(remaining / 1000)} сек.`);
  if (verifyParentalPin(pin)) {
    pinFailures = 0;
    return;
  }
  pinFailures++;
  if (pinFailures >= 5) {
    pinFailures = 0;
    pinLockedUntil = Date.now() + 60_000;
    throw new Error('Слишком много неверных PIN-кодов. Повторите через минуту.');
  }
  throw new Error('Неверный PIN-код родителя.');
}

function newParentalPin(pin: unknown): { salt: string; hash: string } {
  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) throw new Error('PIN-код должен содержать от 4 до 12 цифр.');
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: scryptSync(pin, salt, 64).toString('base64') };
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

function runPageFind(query: string, direction: 'first' | 'next' | 'prev' = 'first'): void {
  const active = tabs?.active();
  if (!active) return;
  const raw = str(query, 500).trim();
  if (!raw) {
    active.view.webContents.stopFindInPage('clearSelection');
    pageFindQuery = '';
    return;
  }
  pageFindQuery = raw;
  active.view.webContents.findInPage(raw, {
    findNext: direction !== 'first',
    forward: direction !== 'prev',
    matchCase: false,
  });
}

function openPageFindDialog(): void {
  const active = tabs?.active();
  if (!active || !win || win.isDestroyed()) return;
  void openBrowserDialog({
    kind: 'question',
    title: 'Поиск по странице',
    message: 'Введите текст, который нужно найти в текущей странице.',
    buttons: ['Найти', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    input: { value: pageFindQuery },
  })
    .then((result) => {
      const value = str(result.value, 500).trim();
      if (result.response === 0 && value) {
        pageFindQuery = value;
        runPageFind(value, 'first');
      } else {
        active.view.webContents.stopFindInPage('clearSelection');
        pageFindQuery = '';
      }
    })
    .catch((error: unknown) => {
      console.error('Не удалось открыть поиск по странице:', error);
    });
}

// ───────────────────────── IPC ─────────────────────────

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');

function fromInternalPage(e: IpcMainInvokeEvent): boolean {
  const f = e.senderFrame;
  if (!f || f !== e.sender.mainFrame) return false;
  try {
    const url = new URL(f.url);
    return url.protocol === 'dark:' && PAGES.has(url.hostname);
  } catch {
    return false;
  }
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
      case 'find-page':
        openPageFindDialog();
        break;
      case 'find-page-next':
        runPageFind(pageFindQuery, 'next');
        break;
      case 'find-page-prev':
        runPageFind(pageFindQuery, 'prev');
        break;
      case 'find-page-close':
        if (tabs.active()) tabs.active()!.view.webContents.stopFindInPage('clearSelection');
        pageFindQuery = '';
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
  page('downloads:list', () => library.get().downloads);
  page('downloads:remove', (id: unknown) => {
    library.patch({ downloads: library.get().downloads.filter((item) => item.id !== id) });
    return library.get().downloads;
  });
  page('downloads:clear', () => {
    library.patch({ downloads: [] });
    return [];
  });
  page('downloads:open', async (id: unknown) => {
    const item = library.get().downloads.find((entry) => entry.id === id);
    if (!item || item.state !== 'completed' || !item.path) throw new Error('Файл недоступен.');
    const error = await shell.openPath(item.path);
    if (error) throw new Error(`Не удалось открыть файл: ${error}`);
  });
  page('downloads:show', (id: unknown) => {
    const item = library.get().downloads.find((entry) => entry.id === id);
    if (!item || !item.path) throw new Error('Путь к файлу недоступен.');
    shell.showItemInFolder(item.path);
  });
  page('settings:get', () => publicSettings());
  page('settings:set', (patch: Partial<BrowserSettings>, pin: unknown) => {
    if (settings.get().parentalEnabled) requireParentalPin(pin);
    const next: Partial<BrowserSettings> = {};
    if (typeof patch?.searchEngine === 'string' && patch.searchEngine in SEARCH_ENGINES) next.searchEngine = patch.searchEngine;
    if (typeof patch?.restoreTabs === 'boolean') next.restoreTabs = patch.restoreTabs;
    if (typeof patch?.homepage === 'string') {
      const h = resolveInput(patch.homepage, settings.get().searchEngine, 'dark://home');
      next.homepage = /^(https?|dark):/i.test(h) && !/^https?:\/\/(duckduckgo|yandex|www\.google|www\.bing)/.test(h) ? h : 'dark://home';
    }
    settings.patch(next);
    return publicSettings();
  });
  page('proxy:set', async (config: ProxyConfig, pin: unknown) => {
    if (settings.get().parentalEnabled) requireParentalPin(pin);
    if (typeof config?.enabled !== 'boolean') throw new Error('Укажите состояние прокси.');
    let server = str(config.server, 500).trim();
    const username = str(config.username, 256).trim();
    const password = str(config.password, 1024);
    if (config.enabled) {
      let parsed: URL;
      try {
        parsed = new URL(server);
      } catch {
        throw new Error('Введите адрес прокси в формате http://host:port или socks5://host:port.');
      }
      if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname ||
          parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('Поддерживаются только http(s), socks4 и socks5 без логина и пароля в URL.');
      }
      server = `${parsed.protocol}//${parsed.host}`;
    }
    let proxyPasswordEncrypted = settings.get().proxyPasswordEncrypted;
    if (!username) {
      proxyPasswordEncrypted = '';
    } else if (password) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Безопасное хранилище системы недоступно: пароль прокси нельзя сохранить.');
      proxyPasswordEncrypted = safeStorage.encryptString(password).toString('base64');
    } else if (server !== settings.get().proxyServer || username !== settings.get().proxyUsername || !proxyPasswordEncrypted) {
      throw new Error('Введите пароль прокси или оставьте прежние адрес и логин.');
    }
    const ses = session.fromPartition(PARTITION);
    const previous = settings.get();
    try {
      await ses.setProxy(config.enabled ? { proxyRules: server } : { mode: 'system' });
      await ses.closeAllConnections();
    } catch (error) {
      try {
        await ses.setProxy(previous.proxyEnabled ? { proxyRules: previous.proxyServer } : { mode: 'system' });
        await ses.closeAllConnections();
      } catch (rollbackError) {
        console.error('Не удалось восстановить прежние настройки прокси:', rollbackError);
        throw new Error('Не удалось применить прокси и восстановить прежнее подключение.');
      }
      throw error;
    }
    settings.patch({
      proxyEnabled: config.enabled,
      proxyServer: server,
      proxyUsername: username,
      proxyAuthConfigured: !!proxyPasswordEncrypted,
      proxyPasswordEncrypted,
    });
    return publicSettings();
  });
  page('parental:update-lists', async (profiles: unknown, pin: unknown) => {
    const selected = normalizeParentalProfiles(profiles);
    const current = settings.get();
    if (current.parentalPinSalt && current.parentalPinHash) requireParentalPin(pin);
    if (!selected.length) {
      settings.patch({ parentalProfiles: [] });
      refreshParentalDomainCache();
      return publicSettings();
    }
    const fetched = await Promise.all(selected.map(async (profile) => [profile, await fetchParentalList(profile)] as const));
    const parentalLists = { ...current.parentalLists };
    for (const [profile, domains] of fetched) parentalLists[profile] = domains;
    settings.patch({
      parentalProfiles: selected,
      parentalLists,
      parentalListCounts: {
        adult: parentalLists.adult.length,
        malware: parentalLists.malware.length,
      },
      parentalListsUpdatedAt: Date.now(),
    });
    refreshParentalDomainCache();
    enforceParentalBlockOnOpenTabs();
    return publicSettings();
  });
  page('parental:configure', (config: { enabled?: unknown; blockedDomains?: unknown; profiles?: unknown; pin?: unknown; newPin?: unknown; confirmPin?: unknown }) => {
    if (typeof config?.enabled !== 'boolean') throw new Error('Укажите состояние родительского контроля.');
    const current = settings.get();
    const pinConfigured = !!current.parentalPinSalt && !!current.parentalPinHash;
    if (pinConfigured) requireParentalPin(config.pin);
    const blockedDomains = normalizeBlockedDomains(config.blockedDomains);
    const profiles = config.profiles === undefined ? current.parentalProfiles : normalizeParentalProfiles(config.profiles);
    let pin = { salt: current.parentalPinSalt, hash: current.parentalPinHash };
    if (typeof config.newPin === 'string' && config.newPin) {
      if (config.newPin !== config.confirmPin) throw new Error('PIN-коды не совпадают.');
      pin = newParentalPin(config.newPin);
    }
    else if (!pinConfigured && config.enabled) throw new Error('Для включения родительского контроля задайте PIN-код.');
    if (config.enabled && !pin.salt) throw new Error('Для включения родительского контроля задайте PIN-код.');
    if (config.enabled && profiles.some((profile) => !current.parentalLists[profile]?.length)) {
      throw new Error('Сначала скачайте выбранные списки защиты.');
    }
    settings.patch({
      parentalEnabled: config.enabled,
      blockedDomains,
      parentalProfiles: profiles,
      parentalPinSalt: pin.salt,
      parentalPinHash: pin.hash,
      parentalPinConfigured: !!pin.salt && !!pin.hash,
    });
    refreshParentalDomainCache();
    enforceParentalBlockOnOpenTabs();
    return publicSettings();
  });
  page('about', (): AboutInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    apiBase: API_BASE,
    engines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
  }));
  // alert(), confirm() и prompt() сайтов. Электрон не умеет prompt() и показывает alert/confirm
  // системным окном, поэтому preload шлёт синхронный запрос сюда, а ответ даёт окно браузера.
  type SyncDialogType = 'alert' | 'confirm' | 'prompt';
  let syncDialogBusy = false;
  const recentDialogs = new Map<number, number[]>(); // время последних окон по вкладкам
  const blockedUntil = new Map<number, number>(); // вкладки, которым окна временно запрещены

  ipcMain.on('browser-dialog-sync', (event, payload: unknown) => {
    const p = payload && typeof payload === 'object' ? (payload as { type?: unknown; message?: unknown; value?: unknown }) : {};
    const type: SyncDialogType = p.type === 'alert' || p.type === 'confirm' ? p.type : 'prompt';
    // Что получит страница, если окно не показано или закрыто: alert — ничего, confirm — false, prompt — null.
    const fallback = (): string | boolean | null => (type === 'confirm' ? false : null);
    const reply = (value: string | boolean | null): void => {
      try {
        event.returnValue = value;
      } catch {
        /* вкладка уже закрыта */
      }
    };
    const tab = tabs?.all().find((t) => t.view.webContents === event.sender);
    if (!tab || syncDialogBusy || event.senderFrame !== event.sender.mainFrame) return reply(fallback());

    // Защита от бесконечных окон: больше 3 за 5 секунд — молчим 30 секунд.
    const id = event.sender.id;
    const now = Date.now();
    if ((blockedUntil.get(id) ?? 0) > now) return reply(fallback());
    const times = (recentDialogs.get(id) ?? []).filter((t) => now - t < 5000);
    if (times.length >= 3) {
      blockedUntil.set(id, now + 30000);
      recentDialogs.delete(id);
      return reply(fallback());
    }
    recentDialogs.set(id, [...times, now]);

    let host = '';
    try {
      host = new URL(event.sender.getURL()).host;
    } catch {
      /* без адреса */
    }
    syncDialogBusy = true;
    tabs.activate(tab.id);
    openBrowserDialog({
      kind: type === 'alert' ? 'info' : 'question',
      title: host ? `${host} ${type === 'alert' ? 'сообщает' : 'спрашивает'}` : type === 'alert' ? 'Страница сообщает' : 'Страница спрашивает',
      message: str(p.message, 2000),
      buttons: type === 'alert' ? ['ОК'] : ['ОК', 'Отмена'],
      defaultId: 0,
      cancelId: type === 'alert' ? 0 : 1,
      ...(type === 'prompt' ? { input: { value: str(p.value, 2000) } } : {}),
    })
      .then((r) => {
        if (type === 'prompt') return reply(r.response === 0 ? (r.value ?? '') : null);
        if (type === 'confirm') return reply(r.response === 0);
        return reply(null);
      })
      .catch(() => reply(fallback()))
      .finally(() => {
        syncDialogBusy = false;
      });
  });

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
    { label: 'Загрузки', accelerator: 'CmdOrCtrl+J', click: () => tabs.openInternal('dark://downloads') },
    { label: 'Поиск по странице', accelerator: 'CmdOrCtrl+F', click: () => openPageFindDialog() },
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
        { label: 'Поиск по странице', accelerator: 'CmdOrCtrl+F', click: () => openPageFindDialog() },
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
        { label: 'Загрузки', accelerator: 'CmdOrCtrl+J', click: () => tabs.openInternal('dark://downloads') },
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