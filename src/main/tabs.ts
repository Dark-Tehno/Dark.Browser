import { BrowserWindow, Menu, WebContentsView, clipboard } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

/** Высота интерфейса браузера: полоса вкладок (40) + панель навигации (48). */
export const CHROME_HEIGHT = 88;

export const isInternal = (u: string): boolean => u.startsWith('dark://');
export const isNavigable = (u: string): boolean => /^(https?:|dark:)/i.test(u) || u === 'about:blank';

export interface TabHooks {
  changed(): void;
  visited(url: string, title: string): void;
  searchUrl(text: string): string;
  focusOmnibox(): void;
  /** Ссылка на внешнюю схему (tg://, mailto: …): откроет приложение после подтверждения. */
  external(url: string, from: string): void;
  empty(): void;
}

class Tab {
  title = '';
  url = '';
  favicon: string | null = null;
  loading = false;
  constructor(readonly id: number, readonly view: WebContentsView) {}
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private htmlFullscreen = false;

  constructor(
    private readonly win: BrowserWindow,
    private readonly preload: string,
    private readonly partition: string,
    private readonly hooks: TabHooks,
  ) {}

  all(): Tab[] {
    return this.tabs;
  }

  active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  urls(): string[] {
    return this.tabs.map((t) => t.url).filter((u) => u && u !== 'about:blank' && !u.startsWith('dark://error'));
  }

  create(url: string, activate = true): Tab | null {
    if (!isNavigable(url)) return null;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preload,
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
      },
    });
    const tab = new Tab(this.nextId++, view);
    tab.url = url;
    this.tabs.push(tab);
    this.bind(tab);
    void view.webContents.loadURL(url).catch(() => undefined);
    if (activate) {
      this.activate(tab.id);
      if (url.startsWith('dark://home')) this.hooks.focusOmnibox();
    }
    this.hooks.changed();
    return tab;
  }

  /** Открывает внутреннюю страницу: активирует уже открытую вкладку или создаёт новую. */
  openInternal(url: string): void {
    const existing = this.tabs.find((t) => t.url.replace(/\/$/, '') === url.replace(/\/$/, ''));
    if (existing) this.activate(existing.id);
    else this.create(url);
  }

  activate(id: number): void {
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    const prev = this.active();
    if (prev && prev !== next) this.win.contentView.removeChildView(prev.view);
    this.activeId = id;
    this.win.contentView.addChildView(next.view);
    this.layout();
    next.view.webContents.focus();
    this.hooks.changed();
  }

  activateRelative(delta: number): void {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id);
  }

  close(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!this.tabs.length) {
      this.activeId = null;
      this.hooks.empty();
      return;
    }
    if (this.activeId === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.hooks.changed();
  }

  navigate(url: string): void {
    const t = this.active();
    if (!t || !isNavigable(url)) return;
    void t.view.webContents.loadURL(url).catch(() => undefined);
  }

  back(): void {
    this.active()?.view.webContents.navigationHistory.goBack();
  }
  forward(): void {
    this.active()?.view.webContents.navigationHistory.goForward();
  }
  reload(): void {
    this.active()?.view.webContents.reload();
  }
  stop(): void {
    this.active()?.view.webContents.stop();
  }

  zoom(delta: number | 'reset'): void {
    const wc = this.active()?.view.webContents;
    if (!wc) return;
    wc.setZoomLevel(delta === 'reset' ? 0 : Math.max(-3, Math.min(5, wc.getZoomLevel() + delta)));
  }

  layout(): void {
    const t = this.active();
    if (!t) return;
    const [width, height] = this.win.getContentSize();
    const top = this.htmlFullscreen ? 0 : CHROME_HEIGHT;
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  snapshot(): { tabs: TabInfo[]; activeId: number | null; canGoBack: boolean; canGoForward: boolean } {
    const act = this.active();
    const nav = act?.view.webContents.navigationHistory;
    return {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        title: this.titleOf(t),
        url: t.url,
        displayUrl: this.displayUrl(t.url),
        favicon: t.favicon,
        loading: t.loading,
        active: t.id === this.activeId,
      })),
      activeId: this.activeId,
      canGoBack: !!nav?.canGoBack(),
      canGoForward: !!nav?.canGoForward(),
    };
  }

  private titleOf(t: Tab): string {
    const raw = t.title.replace(/ — Dark\.Browser$/, '');
    return raw || (isInternal(t.url) || !t.url ? 'Новая вкладка' : t.url);
  }

  private displayUrl(url: string): string {
    if (/^dark:\/\/home\/?$/.test(url) || url === 'about:blank') return '';
    return isInternal(url) ? url.replace(/\/$/, '') : url;
  }

  private bind(tab: Tab): void {
    const wc = tab.view.webContents;
    const changed = (): void => this.hooks.changed();

    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigable(url) && url !== 'about:blank') this.create(url, true);
      else this.hooks.external(url, wc.getURL());
      return { action: 'deny' };
    });

    wc.on('will-navigate', (e, url) => {
      if (isNavigable(url)) return;
      e.preventDefault();
      this.hooks.external(url, wc.getURL());
    });
    wc.on('will-redirect', (e, url) => {
      if (isNavigable(url)) return;
      e.preventDefault();
      this.hooks.external(url, wc.getURL());
    });

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      changed();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons.find((i) => /^https?:/i.test(i)) ?? null;
      changed();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      changed();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      changed();
    });
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.favicon = null;
      changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (isMain) {
        tab.url = url;
        changed();
      }
    });
    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      if (/^https?:/i.test(url)) this.hooks.visited(url, wc.getTitle());
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || url.startsWith('dark://error')) return;
      if (desc === 'ERR_UNKNOWN_URL_SCHEME') {
        this.hooks.external(url, wc.getURL());
        return;
      }
      const q = new URLSearchParams({ code: String(code), desc, url });
      void wc.loadURL(`dark://error/?${q.toString()}`).catch(() => undefined);
    });

    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.win.setFullScreen(true);
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.win.setFullScreen(false);
      this.layout();
    });

    wc.on('context-menu', (_e, p) => {
      const nav = wc.navigationHistory;
      const items: MenuItemConstructorOptions[] = [];
      if (p.linkURL && isNavigable(p.linkURL)) {
        items.push(
          { label: 'Открыть ссылку в новой вкладке', click: () => void this.create(p.linkURL, false) },
          { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(p.linkURL) },
          { type: 'separator' },
        );
      }
      if (p.mediaType === 'image' && /^https?:/i.test(p.srcURL)) {
        items.push(
          { label: 'Открыть изображение в новой вкладке', click: () => void this.create(p.srcURL, false) },
          { label: 'Копировать адрес изображения', click: () => clipboard.writeText(p.srcURL) },
          { type: 'separator' },
        );
      }
      if (p.isEditable) {
        items.push(
          { role: 'cut', label: 'Вырезать' },
          { role: 'copy', label: 'Копировать' },
          { role: 'paste', label: 'Вставить' },
          { role: 'selectAll', label: 'Выделить всё' },
        );
      } else if (p.selectionText) {
        const short = p.selectionText.length > 28 ? `${p.selectionText.slice(0, 28)}…` : p.selectionText;
        items.push(
          { role: 'copy', label: 'Копировать' },
          { label: `Искать «${short}»`, click: () => void this.create(this.hooks.searchUrl(p.selectionText), true) },
        );
      } else if (!p.linkURL) {
        items.push(
          { label: 'Назад', enabled: nav.canGoBack(), click: () => nav.goBack() },
          { label: 'Вперёд', enabled: nav.canGoForward(), click: () => nav.goForward() },
          { label: 'Обновить', click: () => wc.reload() },
        );
      }
      items.push({ type: 'separator' }, { label: 'Просмотреть код элемента', click: () => wc.inspectElement(p.x, p.y) });
      Menu.buildFromTemplate(items).popup({ window: this.win });
    });
  }
}
