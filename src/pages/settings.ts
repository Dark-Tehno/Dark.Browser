(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let st: AccountState;
  let set: BrowserSettings;
  let about: AboutInfo;
  let flash: { kind: 'success' | 'error' | 'info'; text: string } | null = null;

  async function save(patch: Partial<BrowserSettings>, text = 'Настройки сохранены.'): Promise<void> {
    set = await api.settings.set(patch);
    flash = { kind: 'success', text };
    render();
  }

  function general(): HTMLElement {
    const engine = select(about.engines.map((e): [string, string] => [e.id, e.name]), set.searchEngine, 's-engine');
    const home = h('input', { class: 'input', id: 's-home', value: set.homepage, spellcheck: false });
    const restore = h('input', { type: 'checkbox', id: 's-restore' });
    restore.checked = set.restoreTabs;
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-row' },
        field('Поисковая система', engine, 'Используется в адресной строке и на главной странице.'),
        field('Домашняя страница', home, 'Адрес http(s):// или dark://home.')),
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: 's-restore' }, restore, 'При запуске открывать вкладки прошлого сеанса')),
      h('button', { class: 'btn grad', type: 'submit' }, 'Сохранить изменения'),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void save({ searchEngine: engine.value, homepage: home.value.trim(), restoreTabs: restore.checked });
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Основные')), h('p', { class: 'section-note' }, 'Поведение адресной строки и запуска.'), form);
  }

  function accountCard(): HTMLElement {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Dark.Account'), badge(st.signedIn ? 'ok' : '', st.signedIn ? 'привязан' : 'не привязан')),
      h('p', { class: 'section-note' }, st.signedIn ? 'Браузер привязан к аккаунту ' + (st.user ? st.user.username : '') + '.' : 'Войдите в аккаунт, чтобы привязать этот браузер.'),
      h('a', { class: 'btn', href: 'dark://account' }, 'Открыть аккаунт'));
  }

  function dataCard(): HTMLElement {
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Данные')),
      h('p', { class: 'section-note' }, 'Закладки и история хранятся только на этом компьютере.'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: 'dark://bookmarks' }, 'Закладки'),
        h('a', { class: 'btn', href: 'dark://history' }, 'История'),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await api.confirm('Очистить всю историю просмотров?')) { await api.history.clear(); flash = { kind: 'success', text: 'История очищена.' }; render(); } } }, 'Очистить историю')));
  }

  function aboutCard(): HTMLElement {
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'О браузере')),
      h('dl', { class: 'kv' },
        h('dt', null, 'версия'), h('dd', null, h('code', null, about.version)),
        h('dt', null, 'chromium'), h('dd', null, h('code', null, about.chrome)),
        h('dt', null, 'electron'), h('dd', null, h('code', null, about.electron)),
        h('dt', null, 'система'), h('dd', null, h('code', null, about.platform)),
        h('dt', null, 'account api'), h('dd', null, h('code', null, about.apiBase)),
        h('dt', null, 'device_id'), h('dd', null, h('code', null, st.deviceId))));
  }

  function render(): void {
    clear(root);
    root.append(
      h('div', { class: 'eyebrow' }, 'Dark.Browser'),
      h('h1', null, 'Настройки'),
      h('p', null, 'Поиск, запуск и привязка к аккаунту Dark.Account.'),
    );
    if (flash) root.appendChild(h('div', { class: 'toast-stack' }, alertBox(flash.kind, flash.text)));
    root.append(general(), accountCard(), dataCard(), aboutCard());
    flash = null;
  }

  api.onAccountChanged((s) => { st = s; });
  void Promise.all([api.account.state(), api.settings.get(), api.about()]).then(([s, g, a]) => { st = s; set = g; about = a; render(); });
})();
