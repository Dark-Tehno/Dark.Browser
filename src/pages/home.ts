(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let st: AccountState;
  let bookmarks: Bookmark[] = [];
  let about: AboutInfo;
  let engine = 'duckduckgo';

  const PROJECTS: { name: string; url: string; ver: string; desc: string }[] = [
    { name: 'Dark.Lang', url: 'https://vsp210.ru/dark-lang/', ver: 'версия: 0.4.0', desc: 'Язык программирования, основанный на Python.' },
    { name: 'Dark.Account', url: 'https://vsp210.ru/account/', ver: 'аккаунт', desc: 'Единый аккаунт Dark.Tehno. Браузер привязывается к нему.' },
    { name: 'Dark.News', url: 'https://vsp210.ru/news/', ver: 'версия: 1', desc: 'Сайт для прочтения новостей. От Dark.Tehno.' },
    { name: 'WeWeCraft', url: 'https://vsp210.ru/wewecraft/', ver: 'версия: 1.0.0', desc: 'Сайт майнкрафт сервера.' },
  ];

  function hero(): HTMLElement {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Поиск или адрес сайта', 'aria-label': 'Поиск или адрес сайта', autofocus: true });
    const form = h('form', { class: 'search', novalidate: true }, input, h('button', { class: 'btn grad', type: 'submit' }, 'Найти'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      location.href = await api.resolve(input.value);
    });

    const signed = st.signedIn && st.user;
    const links = h('div', { class: 'links' },
      signed
        ? h('a', { class: 'btn', href: 'dark://account' }, 'Аккаунт: ' + st.user!.username)
        : h('a', { class: 'btn grad', href: 'dark://account' }, 'Войти в Dark.Account'),
      h('a', { class: 'btn', href: 'dark://settings' }, 'Настройки'),
    );

    const who = h('div', { class: 'whoami' },
      h('div', { class: 'whoami-bar' }, h('i'), h('i'), h('i'), h('span', null, 'guest@dark-browser')),
      h('div', { class: 'whoami-body' },
        h('div', { class: 'cmd' }, '$ whoami --verbose', h('span', { class: 'cursor' })),
        h('div', { class: 'row' }, h('span', { class: 'k' }, 'аккаунт'), h('span', { class: 'v' }, signed ? st.user!.username : 'не выполнен вход')),
        h('div', { class: 'row' }, h('span', { class: 'k' }, 'привязка'), h('span', { class: 'v' }, signed ? 'устройство привязано' : 'не привязано')),
        h('div', { class: 'row' }, h('span', { class: 'k' }, 'версия'), h('span', { class: 'v' }, about.version)),
        h('div', { class: 'row' }, h('span', { class: 'k' }, 'движок'), h('span', { class: 'v' }, 'Chromium ' + about.chrome.split('.')[0])),
        h('div', { class: 'row' }, h('span', { class: 'k' }, 'поиск'), h('span', { class: 'v' }, about.engines.find((e) => e.id === engine)?.name ?? engine)),
      ),
    );

    return h('section', { class: 'hero' },
      h('div', null,
        h('div', { class: 'eyebrow' }, 'Dark.Tehno · браузер'),
        h('h1', null, 'Dark', h('span', { class: 'grad-text' }, '.Browser')),
        h('p', { class: 'role grad-text' }, 'Браузер с привязкой к аккаунту'),
        h('p', { class: 'tagline' }, 'Быстрый браузер организации Dark.Tehno. Войдите в Dark.Account, и этот компьютер появится в списке ваших устройств.'),
        form,
        links,
      ),
      who,
    );
  }

  function render(): void {
    clear(root);
    root.appendChild(h('div', { class: 'page-narrow' },
      hero(),
      h('section', { class: 'section' },
        h('h2', null, 'Проекты'),
        h('div', { class: 'projects' }, ...PROJECTS.map((p) =>
          h('div', { class: 'proj' }, h('h3', null, h('a', { href: p.url }, p.name)), h('span', { class: 'ver' }, p.ver), h('p', null, p.desc)))),
      ),
      bookmarks.length
        ? h('section', { class: 'section' },
            h('h2', null, 'Закладки'),
            h('div', { class: 'chips' }, ...bookmarks.slice(0, 12).map((b) => h('a', { class: 'chip', href: b.url, title: b.url }, b.title))),
            bookmarks.length > 12 ? h('p', { style: 'margin-top:14px' }, h('a', { href: 'dark://bookmarks' }, 'Все закладки')) : null)
        : null,
      h('section', { class: 'section' },
        h('h2', null, 'Связь'),
        h('div', { class: 'chips' },
          h('a', { class: 'chip', href: 'https://t.me/vsp210' }, 'Telegram'),
          h('a', { class: 'chip', href: 'https://t.me/vsp210_official' }, 'Telegram-канал'),
          h('a', { class: 'chip', href: 'https://github.com/vsp210' }, 'GitHub'),
          h('a', { class: 'chip', href: 'https://vk.com/vsp210' }, 'ВКонтакте')),
      ),
      h('footer', { class: 'foot' }, h('p', { style: 'margin:0' }, '© 2025-2026 Dark.Tehno. Все права защищены.')),
    ));
  }

  api.onAccountChanged((s) => { st = s; render(); });
  void Promise.all([api.account.state(), api.bookmarks.list(), api.about(), api.settings.get()]).then(([s, b, a, set]) => {
    st = s; bookmarks = b; about = a; engine = set.searchEngine;
    render();
  });
})();
