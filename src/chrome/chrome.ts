(function () {
  "use strict";
  const api = window.darkChrome;
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  document.body.classList.add('plat-' + api.platform);

  const tabsEl = $('tabs');
  const omni = $<HTMLInputElement>('omnibox');
  const sec = $('sec');
  const star = $<HTMLButtonElement>('star');
  const back = $<HTMLButtonElement>('back');
  const forward = $<HTMLButtonElement>('forward');
  const acct = $('account');
  const progress = $('progress');

  let lastActive: number | null = null;
  let lastUrl = '';

  function favicon(t: TabInfo): HTMLElement {
    if (t.loading) return h('span', { class: 'tab-spin', 'aria-hidden': 'true' });
    if (t.favicon) {
      const img = h('img', { class: 'tab-fav', src: t.favicon, alt: '', draggable: false });
      img.addEventListener('error', () => img.replaceWith(h('span', { class: 'tab-dot' })));
      return img;
    }
    return h('span', { class: 'tab-dot', 'aria-hidden': 'true' });
  }

  function renderTabs(s: ChromeState): void {
    clear(tabsEl);
    for (const t of s.tabs) {
      const el = h(
        'div',
        {
          class: 'tab' + (t.active ? ' active' : ''),
          role: 'tab',
          tabindex: 0,
          'aria-selected': String(t.active),
          title: t.title,
          onclick: () => api.activate(t.id),
          onauxclick: (e: MouseEvent) => {
            if (e.button === 1) api.closeTab(t.id);
          },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              api.activate(t.id);
            }
          },
        },
        favicon(t),
        h('span', { class: 'tab-title' }, t.title),
        h(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            tabindex: -1,
            'aria-label': 'Закрыть вкладку',
            onclick: (e: Event) => {
              e.stopPropagation();
              api.closeTab(t.id);
            },
          },
          '×',
        ),
      );
      tabsEl.appendChild(el);
    }
  }

  function renderSecurity(url: string): void {
    sec.className = 'sec';
    clear(sec);
    sec.title = '';
    if (/^https:/i.test(url)) {
      sec.classList.add('https');
      sec.title = 'Соединение защищено';
      sec.append(h('i'), 'https');
    } else if (/^http:/i.test(url)) {
      sec.classList.add('http');
      sec.title = 'Соединение не защищено';
      sec.append(h('i'), 'не защищено');
    } else if (/^dark:/i.test(url)) {
      sec.classList.add('dark');
      sec.title = 'Внутренняя страница Dark Browser';
      sec.append(h('i'), 'dark');
    }
  }

  function renderAccount(a: ChromeState['account']): void {
    clear(acct);
    acct.className = 'acct';
    if (a.signedIn && a.username) {
      acct.title = `Dark.Account · ${a.username}`;
      const av = a.avatar
        ? h('img', { class: 'av', src: a.avatar, alt: '' })
        : h('span', { class: 'av' }, a.username.charAt(0).toUpperCase());
      if (a.avatar) av.addEventListener('error', () => av.replaceWith(h('span', { class: 'av' }, a.username!.charAt(0).toUpperCase())));
      acct.append(av, h('span', { class: 'nm' }, a.username));
    } else {
      acct.classList.add('guest');
      acct.title = 'Войти в Dark.Account';
      acct.append(h('span', null, 'Войти'));
    }
  }

  api.onState((s) => {
    renderTabs(s);
    renderAccount(s.account);
    back.disabled = !s.canGoBack;
    forward.disabled = !s.canGoForward;

    const active = s.tabs.find((t) => t.active);
    const loading = !!active?.loading;
    progress.hidden = !loading;
    $('ic-reload').style.display = loading ? 'none' : '';
    $('ic-stop').style.display = loading ? '' : 'none';
    $('reload').setAttribute('aria-label', loading ? 'Остановить' : 'Обновить');

    star.classList.toggle('on', s.bookmarked);
    star.setAttribute('aria-label', s.bookmarked ? 'Убрать из закладок' : 'Добавить в закладки');

    // Не затираем адрес, пока пользователь печатает.
    const url = active?.displayUrl ?? '';
    if (document.activeElement !== omni || s.activeId !== lastActive || url !== lastUrl) {
      if (document.activeElement !== omni || s.activeId !== lastActive) omni.value = url;
    }
    lastActive = s.activeId;
    lastUrl = url;
    renderSecurity(active?.url ?? '');
  });

  api.onFocusOmnibox(() => {
    omni.focus();
    omni.select();
  });

  omni.addEventListener('focus', () => omni.select());
  omni.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      omni.value = lastUrl;
      omni.blur();
    }
  });
  $('omniform').addEventListener('submit', (e) => {
    e.preventDefault();
    api.navigate(omni.value);
    omni.blur();
  });

  $('newtab').addEventListener('click', () => api.newTab());
  back.addEventListener('click', () => api.back());
  forward.addEventListener('click', () => api.forward());
  $('reload').addEventListener('click', () => (progress.hidden ? api.reload() : api.stop()));
  $('home').addEventListener('click', () => api.home());
  star.addEventListener('click', () => api.toggleBookmark());
  acct.addEventListener('click', () => api.openAccount());
  $('menu').addEventListener('click', (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    api.showMenu(r.right - 4, r.bottom + 4);
  });

  api.ready();
})();
