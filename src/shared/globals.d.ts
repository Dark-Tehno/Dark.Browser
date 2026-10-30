// Глобальные типы, общие для основного процесса, preload и страниц.
// Файл намеренно без import/export — он подключается как ambient.

interface AccountUser {
  id: number;
  username: string;
  email: string;
  avatar: string | null;
  info: string | null;
  date_of_birth: string | null;
  language: string;
  is_online: boolean;
  last_online: string;
  email_confirmed: boolean;
  two_factor_enabled: boolean;
  date_joined: string;
}

interface AccountDevice {
  id: string;
  user: number;
  device_id: string;
  name: string;
  device_type: string;
  operating_system: string;
  system_version: string;
  browser: string;
  browser_version: string;
  application: string;
  application_version: string;
  first_ip: string;
  last_ip: string;
  country: string;
  city: string;
  timezone: string;
  trusted: boolean;
  blocked: boolean;
  created_at: string;
  last_seen: string;
}

interface LoginRecord {
  id: number | string;
  device: string | null;
  device_name: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  status: 'success' | 'failed' | 'blocked';
  reason: string | null;
  created_at: string;
}

type ApiOk<T> = { ok: true; data: T; status: number };
type ApiErr = { ok: false; code: string; message: string; status: number };
type ApiResult<T> = ApiOk<T> | ApiErr;

type LoginOutcome =
  | { status: 'ok'; user: AccountUser }
  | { status: 'two_factor'; challengeId: string; expiresAt: string };

interface AccountState {
  signedIn: boolean;
  user: AccountUser | null;
  /** Аватар как data: URL (скачан основным процессом), либо null. */
  avatarData: string | null;
  /** Устройство, под которым браузер привязан к аккаунту. */
  currentDevice: AccountDevice | null;
  deviceId: string;
  /** Токен сохраняется в защищённом хранилище ОС (иначе — только в памяти). */
  persistent: boolean;
  /** Значение «приложение|версия» из заголовка DARK-TALK-SECRET-KEY. */
  application: string;
}

interface Bookmark { id: string; title: string; url: string; added: number }
interface HistoryEntry { url: string; title: string; visited: number }
type ParentalProfile = 'adult' | 'malware';
interface BrowserSettings {
  searchEngine: string;
  homepage: string;
  restoreTabs: boolean;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyUsername: string;
  proxyAuthConfigured: boolean;
  parentalEnabled: boolean;
  blockedDomains: string[];
  parentalProfiles: ParentalProfile[];
  parentalListCounts: { adult: number; malware: number };
  parentalListsUpdatedAt: number | null;
  parentalPinConfigured: boolean;
}

interface DownloadEntry {
  id: string;
  filename: string;
  url: string;
  path: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progress' | 'completed' | 'cancelled' | 'interrupted';
  started: number;
  ended: number | null;
}

interface ProxyConfig {
  enabled: boolean;
  server: string;
  username: string;
  password: string;
}

interface AboutInfo {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
  apiBase: string;
  engines: { id: string; name: string }[];
}

interface TabInfo {
  id: number;
  title: string;
  url: string;
  displayUrl: string;
  favicon: string | null;
  loading: boolean;
  active: boolean;
}

interface ChromeState {
  tabs: TabInfo[];
  activeId: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
  bookmarked: boolean;
  account: { signedIn: boolean; username: string | null; avatar: string | null };
}

interface DarkApi {
  account: {
    state(): Promise<AccountState>;
    login(username: string, password: string): Promise<ApiResult<LoginOutcome>>;
    verify(challengeId: string, code: string): Promise<ApiResult<LoginOutcome>>;
    resend(challengeId: string): Promise<ApiResult<{ challengeId: string; expiresAt: string }>>;
    register(data: { email: string; password: string; username?: string; language?: string }): Promise<ApiResult<LoginOutcome>>;
    logout(): Promise<ApiResult<null>>;
    profile(): Promise<ApiResult<AccountUser>>;
    updateProfile(patch: Record<string, unknown>): Promise<ApiResult<AccountUser>>;
    uploadAvatar(file: { name: string; type: string; bytes: ArrayBuffer }, avatarAccess?: string): Promise<ApiResult<AccountUser>>;
    devices(): Promise<ApiResult<AccountDevice[]>>;
    updateDevice(deviceId: string, patch: { name?: string; trusted?: boolean }): Promise<ApiResult<AccountDevice>>;
    deleteDevice(deviceId: string): Promise<ApiResult<null>>;
    loginHistory(): Promise<ApiResult<LoginRecord[]>>;
    twoFactor(): Promise<ApiResult<boolean>>;
    setTwoFactor(enabled: boolean): Promise<ApiResult<boolean>>;
    };
  bookmarks: {
    list(): Promise<Bookmark[]>;
    add(title: string, url: string): Promise<Bookmark[]>;
    remove(id: string): Promise<Bookmark[]>;
  };
  history: {
    list(): Promise<HistoryEntry[]>;
    remove(url: string, visited: number): Promise<HistoryEntry[]>;
    clear(): Promise<HistoryEntry[]>;
  };
  downloads: {
    list(): Promise<DownloadEntry[]>;
    remove(id: string): Promise<DownloadEntry[]>;
    clear(): Promise<DownloadEntry[]>;
    open(id: string): Promise<void>;
    show(id: string): Promise<void>;
    onChanged(cb: (entries: DownloadEntry[]) => void): void;
  };
  settings: {
    get(): Promise<BrowserSettings>;
    set(patch: Partial<BrowserSettings>, pin?: string): Promise<BrowserSettings>;
  };
  proxy: { set(config: ProxyConfig, pin?: string): Promise<BrowserSettings> };
  parental: {
    configure(config: { enabled: boolean; blockedDomains: string[]; profiles?: ParentalProfile[]; pin?: string; newPin?: string; confirmPin?: string }): Promise<BrowserSettings>;
    updateLists(profiles: ParentalProfile[], pin?: string): Promise<BrowserSettings>;
  };
  about(): Promise<AboutInfo>;
  confirm(message: string): Promise<boolean>;
  /** Превращает текст из строки поиска в адрес (как омнибокс). */
  resolve(text: string): Promise<string>;
  onAccountChanged(cb: (s: AccountState) => void): void;
}

interface ChromeApi {
  platform: string;
  ready(): void;
  newTab(): void;
  closeTab(id: number): void;
  activate(id: number): void;
  navigate(text: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  home(): void;
  toggleBookmark(): void;
  openAccount(): void;
  showMenu(x: number, y: number): void;
  findPage(query: string): void;
  findNext(): void;
  findPrev(): void;
  closeFind(): void;
  onState(cb: (s: ChromeState) => void): void;
  onFocusOmnibox(cb: () => void): void;
  onFocusSearch(cb: () => void): void;
}

interface BrowserDialogData {
  id: string;
  kind: 'info' | 'question' | 'warning';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** Если задано — в окне показывается поле ввода (для prompt()). */
  input?: { value: string };
}

interface BrowserDialogApi {
  onShow(cb: (data: BrowserDialogData) => void): void;
  respond(id: string, response: number, value?: string): void;
}

interface Window {
  dark: DarkApi;
  darkChrome: ChromeApi;
  darkDialog: BrowserDialogApi;
}