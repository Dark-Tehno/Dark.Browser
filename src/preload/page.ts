import { contextBridge, ipcRenderer, webFrame } from 'electron';

// Preload вкладок. API раскрывается ТОЛЬКО внутренним страницам dark://.
// Обычные сайты не получают ничего, а основной процесс дополнительно
// проверяет адрес отправителя в каждом обработчике.
function installNotificationShim(): void {
  const NativeNotification = window.Notification;
  if (!NativeNotification || !NativeNotification.requestPermission) return;

  type NotificationAction = { action: string; title: string; icon?: string };
  type NotificationOptions = {
    body?: string;
    icon?: string;
    badge?: string;
    image?: string;
    tag?: string;
    data?: unknown;
    dir?: NotificationDirection;
    lang?: string;
    timestamp?: number;
    requireInteraction?: boolean;
    silent?: boolean;
    renotify?: boolean;
    actions?: NotificationAction[];
  };

  let host: HTMLElement | null = null;
  let stack: HTMLElement | null = null;
  const tagged = new Map<string, BrowserNotification>();

  function getStack(): HTMLElement {
    if (stack) return stack;
    host = document.createElement('div');
    host.setAttribute('aria-live', 'polite');
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;width:min(360px,calc(100vw - 40px));z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .stack{display:flex;flex-direction:column;gap:10px}
      .toast{position:relative;overflow:hidden;padding:14px 16px;border:1px solid #262d4d;border-radius:14px;background:radial-gradient(300px 140px at 100% 0,rgba(124,92,255,.16),transparent 72%),#0d1120;color:#e8eaf6;box-shadow:0 12px 38px rgba(0,0,0,.42);font:14px/1.45 "Segoe UI",sans-serif;pointer-events:auto;animation:enter .18s ease-out}
      .head{display:flex;align-items:center;gap:10px;padding-right:24px}
      .icon{width:30px;height:30px;flex:0 0 30px;object-fit:cover;border-radius:8px;background:#161c33}
      .brand{display:grid;place-items:center;border:1px solid #22d3e8;border-radius:50%;color:#22d3e8;font-weight:700}
      .title{min-width:0;overflow:hidden;color:#e8eaf6;font-weight:700;text-overflow:ellipsis;white-space:nowrap}
      .close{position:absolute;top:8px;right:8px;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:#9aa2c7;font:20px/1 "Segoe UI",sans-serif;cursor:pointer}
      .close:hover{background:#1d2440;color:#fff}
      .body{margin:8px 0 0 40px;color:#b1b8d5;overflow-wrap:anywhere;white-space:pre-wrap}
      .image{display:block;width:100%;max-height:150px;margin-top:10px;border-radius:9px;object-fit:cover}
      .actions{display:flex;justify-content:flex-end;gap:7px;margin:12px 0 0 40px}
      .action{padding:6px 11px;border:1px solid #262d4d;border-radius:8px;background:#161c33;color:#e8eaf6;font:600 12px "Segoe UI",sans-serif;cursor:pointer}
      .action:hover{background:#1d2440}
      @keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @media(prefers-reduced-motion:reduce){.toast{animation:none}}
    `;
    stack = document.createElement('div');
    stack.className = 'stack';
    shadow.append(style, stack);
    document.documentElement.append(host);
    return stack;
  }

  class BrowserNotification extends EventTarget {
    static get permission(): NotificationPermission {
      return NativeNotification.permission;
    }

    static get maxActions(): number {
      return 2;
    }

    static requestPermission(callback?: (permission: NotificationPermission) => void): Promise<NotificationPermission> {
      const request = NativeNotification.requestPermission();
      if (callback) void request.then(callback);
      return request;
    }

    readonly title: string;
    readonly body: string;
    readonly icon: string;
    readonly badge: string;
    readonly image: string;
    readonly tag: string;
    readonly data: unknown;
    readonly dir: NotificationDirection;
    readonly lang: string;
    readonly timestamp: number;
    readonly requireInteraction: boolean;
    readonly silent: boolean;
    readonly renotify: boolean;
    readonly actions: NotificationAction[];
    onshow: ((event: Event) => void) | null = null;
    onclick: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private element: HTMLElement | null = null;
    private timer: number | null = null;
    private closed = false;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      if (BrowserNotification.permission !== 'granted') {
        throw new DOMException('Notifications are not permitted for this origin', 'NotAllowedError');
      }
      this.title = String(title);
      this.body = options.body ?? '';
      this.icon = options.icon ?? '';
      this.badge = options.badge ?? '';
      this.image = options.image ?? '';
      this.tag = options.tag ?? '';
      this.data = structuredClone(options.data);
      this.dir = options.dir ?? 'auto';
      this.lang = options.lang ?? '';
      this.timestamp = options.timestamp ?? Date.now();
      this.requireInteraction = options.requireInteraction === true;
      this.silent = options.silent === true;
      this.renotify = options.renotify === true;
      this.actions = (options.actions ?? []).slice(0, BrowserNotification.maxActions).map((action) => ({
        action: String(action.action),
        title: String(action.title),
        ...(action.icon ? { icon: String(action.icon) } : {}),
      }));

      if (this.tag) tagged.get(this.tag)?.close();
      if (this.tag) tagged.set(this.tag, this);
      queueMicrotask(() => this.show());
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.element?.remove();
      this.element = null;
      if (this.tag && tagged.get(this.tag) === this) tagged.delete(this.tag);
      if (stack && !stack.childElementCount) {
        host?.remove();
        host = null;
        stack = null;
      }
      this.emit('close');
    }

    private emit(type: 'show' | 'click' | 'close' | 'error', action?: string): Event {
      const event = new Event(type, { cancelable: type === 'click' });
      if (action !== undefined) Object.defineProperty(event, 'action', { value: action });
      this.dispatchEvent(event);
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      return event;
    }

    private show(): void {
      if (this.closed) return;
      try {
        const card = document.createElement('article');
        card.className = 'toast';
        card.dir = this.dir;
        if (this.lang) card.lang = this.lang;

        const header = document.createElement('div');
        header.className = 'head';
        const icon = document.createElement('span');
        icon.className = 'icon brand';
        if (this.icon || this.badge) {
          const image = document.createElement('img');
          image.className = 'icon';
          image.alt = '';
          image.src = this.icon || this.badge;
          icon.replaceWith(image);
        } else {
          icon.textContent = 'D';
        }
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = this.title;
        const dismiss = document.createElement('button');
        dismiss.className = 'close';
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Закрыть уведомление');
        dismiss.textContent = '×';
        dismiss.addEventListener('click', (event) => {
          event.stopPropagation();
          this.close();
        });
        header.append(icon, title);
        card.append(header, dismiss);

        if (this.body) {
          const body = document.createElement('div');
          body.className = 'body';
          body.textContent = this.body;
          card.append(body);
        }
        if (this.image) {
          const image = document.createElement('img');
          image.className = 'image';
          image.alt = '';
          image.src = this.image;
          card.append(image);
        }
        if (this.actions.length) {
          const actions = document.createElement('div');
          actions.className = 'actions';
          for (const action of this.actions) {
            const button = document.createElement('button');
            button.className = 'action';
            button.type = 'button';
            button.textContent = action.title;
            button.addEventListener('click', (event) => {
              event.stopPropagation();
              this.emit('click', action.action);
              this.close();
            });
            actions.append(button);
          }
          card.append(actions);
        }

        card.addEventListener('click', () => {
          this.emit('click');
          this.close();
        });
        this.element = card;
        getStack().append(card);
        this.emit('show');
        if (!this.requireInteraction) this.timer = window.setTimeout(() => this.close(), 6000);
      } catch {
        this.emit('error');
        this.close();
      }
    }
  }

  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: BrowserNotification,
  });
}

// alert(), confirm() и prompt() сайтов показываются окном браузера в стиле Dark.Tehno.
// (prompt() в Электроне вообще не работает, а alert/confirm выглядят как системные.)
// Мост в основной процесс попадает в страницу через contextBridge под случайным именем.
function installDialogShims(bridgeName: string): void {
  type Bridge = (type: string, message: string, value: string) => string | boolean | null;
  const bridge = (window as unknown as Record<string, unknown>)[bridgeName] as Bridge | undefined;
  if (typeof bridge !== 'function') return;
  const text = (args: unknown[]): string => (args.length === 0 ? '' : String(args[0]));
  const define = (name: string, fn: unknown): void => {
    Object.defineProperty(window, name, { configurable: true, writable: true, value: fn });
  };
  define('alert', function alert(...args: unknown[]): void {
    bridge('alert', text(args), '');
  });
  define('confirm', function confirm(...args: unknown[]): boolean {
    return bridge('confirm', text(args), '') === true;
  });
  define('prompt', function prompt(...args: unknown[]): string | null {
    const answer = bridge('prompt', text(args), args.length > 1 && args[1] !== undefined && args[1] !== null ? String(args[1]) : '');
    return typeof answer === 'string' ? answer : null;
  });
}

const dialogBridgeName = `__darkDialog_${Math.random().toString(36).slice(2)}`;
contextBridge.exposeInMainWorld(dialogBridgeName, (type: unknown, message: unknown, value: unknown): string | boolean | null => {
  const answer: unknown = ipcRenderer.sendSync('browser-dialog-sync', {
    type: type === 'alert' || type === 'confirm' ? type : 'prompt',
    message: typeof message === 'string' ? message.slice(0, 2000) : '',
    value: typeof value === 'string' ? value.slice(0, 2000) : '',
  });
  return typeof answer === 'string' || typeof answer === 'boolean' ? answer : null;
});
void webFrame.executeJavaScript(`(${installDialogShims.toString()})(${JSON.stringify(dialogBridgeName)})`).catch((error: unknown) => {
  console.error('Не удалось установить окна alert/confirm/prompt:', error);
});

void webFrame.executeJavaScript(`(${installNotificationShim.toString()})()`).catch((error: unknown) => {
  console.error('Не удалось установить оформление уведомлений сайта:', error);
});

if (location.protocol === 'dark:') {
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>;

  const api: DarkApi = {
    account: {
      state: () => call('account:state'),
      login: (u, p) => call('account:login', u, p),
      verify: (id, code) => call('account:verify', id, code),
      resend: (id) => call('account:resend', id),
      register: (d) => call('account:register', d),
      logout: () => call('account:logout'),
      profile: () => call('account:profile'),
      updateProfile: (patch) => call('account:update-profile', patch),
      uploadAvatar: (file, access) => call('account:avatar', file, access),
      devices: () => call('account:devices'),
      updateDevice: (id, patch) => call('account:update-device', id, patch),
      deleteDevice: (id) => call('account:delete-device', id),
      loginHistory: () => call('account:login-history'),
      twoFactor: () => call('account:2fa'),
      setTwoFactor: (enabled) => call('account:set-2fa', enabled),
    },
    bookmarks: {
      list: () => call('bookmarks:list'),
      add: (title, url) => call('bookmarks:add', title, url),
      remove: (id) => call('bookmarks:remove', id),
    },
    history: {
      list: () => call('history:list'),
      remove: (url, visited) => call('history:remove', url, visited),
      clear: () => call('history:clear'),
    },
    downloads: {
      list: () => call('downloads:list'),
      remove: (id) => call('downloads:remove', id),
      clear: () => call('downloads:clear'),
      open: (id) => call('downloads:open', id),
      show: (id) => call('downloads:show', id),
      onChanged: (cb) => ipcRenderer.on('downloads:changed', (_e, entries: DownloadEntry[]) => cb(entries)),
    },
    settings: {
      get: () => call('settings:get'),
      set: (patch, pin) => call('settings:set', patch, pin),
    },
    proxy: { set: (config, pin) => call('proxy:set', config, pin) },
    parental: {
      configure: (config) => call('parental:configure', config),
      updateLists: (profiles, pin) => call('parental:update-lists', profiles, pin),
    },
    about: () => call('about'),
    resolve: (text) => call('nav:resolve', text),
    confirm: (message) => call('browser:confirm', message),
    onAccountChanged: (cb) => {
      ipcRenderer.on('account:changed', (_e, s: AccountState) => cb(s));
    },
  };

  contextBridge.exposeInMainWorld('dark', api);
}