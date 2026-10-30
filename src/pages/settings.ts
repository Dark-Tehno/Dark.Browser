(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let st: AccountState;
  let set: BrowserSettings;
  let about: AboutInfo;
  let flash: { kind: 'success' | 'error' | 'info'; text: string } | null = null;

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : 'Не удалось сохранить изменения.';
  }

  async function save(patch: Partial<BrowserSettings>, pin: string, text = 'Настройки сохранены.'): Promise<void> {
    try {
      set = await api.settings.set(patch, pin);
      flash = { kind: 'success', text };
    } catch (error) {
      flash = { kind: 'error', text: errorText(error) };
    }
    render();
  }

  function general(): HTMLElement {
    const engine = select(about.engines.map((e): [string, string] => [e.id, e.name]), set.searchEngine, 's-engine');
    const home = h('input', { class: 'input', id: 's-home', value: set.homepage, spellcheck: false });
    const restore = h('input', { type: 'checkbox', id: 's-restore' });
    const pin = h('input', { class: 'input', id: 's-settings-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password' });
    restore.checked = set.restoreTabs;
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-row' },
        field('Поисковая система', engine, 'Используется в адресной строке и на главной странице.'),
        field('Домашняя страница', home, 'Адрес http(s):// или dark://home.')),
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: 's-restore' }, restore, 'При запуске открывать вкладки прошлого сеанса')),
      set.parentalEnabled ? field('PIN родителя', pin, 'Подтвердите PIN, чтобы изменить настройки браузера.') : null,
      h('button', { class: 'btn grad', type: 'submit' }, 'Сохранить изменения'),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void save({ searchEngine: engine.value, homepage: home.value.trim(), restoreTabs: restore.checked }, pin.value);
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Основные')), h('p', { class: 'section-note' }, 'Поведение адресной строки и запуска.'), form);
  }

  function proxyCard(): HTMLElement {
    const enabled = h('input', { type: 'checkbox', id: 's-proxy-enabled' });
    enabled.checked = set.proxyEnabled;
    const server = h('input', { class: 'input', id: 's-proxy-server', value: set.proxyServer, placeholder: 'http://127.0.0.1:8080', spellcheck: false });
    const username = h('input', { class: 'input', id: 's-proxy-username', value: set.proxyUsername, autocomplete: 'username' });
    const password = h('input', { class: 'input', id: 's-proxy-password', type: 'password', autocomplete: 'new-password' });
    const pin = h('input', { class: 'input', id: 's-proxy-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password' });
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: enabled.id }, enabled, 'Использовать прокси')),
      field('Адрес сервера', server, 'Формат: http://host:port, https://host:port или socks5://host:port.'),
      h('div', { class: 'form-row' },
        field('Логин (если требуется)', username, 'Поддерживается авторизация прокси.'),
        field('Пароль прокси', password, set.proxyAuthConfigured ? 'Оставьте пустым, чтобы сохранить текущий пароль.' : 'Пароль хранится в зашифрованном виде в хранилище ОС.')),
      set.parentalEnabled ? field('PIN родителя', pin, 'Подтвердите PIN, чтобы изменить прокси.') : null,
      h('button', { class: 'btn grad', type: 'submit' }, 'Сохранить прокси'),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void api.proxy.set({ enabled: enabled.checked, server: server.value.trim(), username: username.value.trim(), password: password.value }, pin.value)
        .then((value) => { set = value; flash = { kind: 'success', text: 'Настройки прокси сохранены.' }; })
        .catch((error: unknown) => { flash = { kind: 'error', text: errorText(error) }; })
        .finally(render);
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Прокси-сервер'), badge(set.proxyEnabled ? 'ok' : '', set.proxyEnabled ? 'включён' : 'выключен')),
      h('p', { class: 'section-note' }, 'Прокси применяется ко всему сетевому трафику браузера.'),
      form);
  }

  function parentalCard(): HTMLElement {
    const enabled = h('input', { type: 'checkbox', id: 's-parental-enabled' });
    enabled.checked = set.parentalEnabled;
    const adult = h('input', { type: 'checkbox', id: 's-parental-adult' });
    adult.checked = set.parentalProfiles.includes('adult');
    const malware = h('input', { type: 'checkbox', id: 's-parental-malware' });
    malware.checked = set.parentalProfiles.includes('malware');
    const domains = h('textarea', { class: 'input', id: 's-parental-domains', rows: 5, spellcheck: false, placeholder: 'example.com\nsocial.example' }, set.blockedDomains.join('\n'));
    const pin = h('input', { class: 'input', id: 's-parental-pin', type: 'password', inputmode: 'numeric', autocomplete: 'current-password' });
    const newPin = h('input', { class: 'input', id: 's-parental-new-pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password' });
    const confirmPin = h('input', { class: 'input', id: 's-parental-confirm-pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password' });
    const selectedProfiles = (): ParentalProfile[] => [
      ...(adult.checked ? ['adult' as const] : []),
      ...(malware.checked ? ['malware' as const] : []),
    ];
    const form = h('form', { novalidate: true },
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: enabled.id }, enabled, 'Включить родительский контроль')),
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: adult.id }, adult, 'Защита от сайтов для взрослых'),
        h('div', { class: 'help-text' },
          'Источник: ',
          h('a', { href: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts' }, 'StevenBlack/hosts · porn-only'),
          ` · ${set.parentalListCounts.adult.toLocaleString('ru-RU')} доменов`)),
      h('div', { class: 'form-group' }, h('label', { class: 'check', for: malware.id }, malware, 'Защита от известных рекламных и вредоносных сайтов'),
        h('div', { class: 'help-text' },
          'Источник: ',
          h('a', { href: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts' }, 'StevenBlack/hosts · malware/adware'),
          ` · ${set.parentalListCounts.malware.toLocaleString('ru-RU')} доменов`)),
      field('Запрещённые домены', domains, 'По одному домену в строке. Блокируются также его поддомены.'),
      set.parentalPinConfigured ? field('Текущий PIN', pin, 'Нужен для изменения списка, отключения защиты и смены PIN.') : null,
      field(set.parentalPinConfigured ? 'Новый PIN (необязательно)' : 'Создайте PIN', newPin, 'От 4 до 12 цифр. Сохранить PIN можно только в виде криптографического хеша.'),
      field('Повторите новый PIN', confirmPin, 'Для подтверждения нового PIN-кода.'),
      h('button', { class: 'btn grad', type: 'submit' }, 'Сохранить родительский контроль'),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void api.parental.configure({
        enabled: enabled.checked,
        blockedDomains: domains.value.split(/\r?\n/),
        profiles: selectedProfiles(),
        pin: pin.value,
        newPin: newPin.value,
        confirmPin: confirmPin.value,
      })
        .then((value) => { set = value; flash = { kind: 'success', text: 'Родительский контроль сохранён.' }; })
        .catch((error: unknown) => { flash = { kind: 'error', text: errorText(error) }; })
        .finally(render);
    });
    const updateButton = h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        updateButton.disabled = true;
        updateButton.textContent = 'Загрузка списков…';
        try {
          set = await api.parental.updateLists(selectedProfiles(), pin.value);
          const count = set.parentalProfiles.reduce((sum, profile) => sum + set.parentalListCounts[profile], 0);
          flash = { kind: 'success', text: count ? `Списки обновлены: ${count.toLocaleString('ru-RU')} доменов.` : 'Списки отключены.' };
        } catch (error) {
          flash = { kind: 'error', text: errorText(error) };
        }
        render();
      },
    }, 'Скачать / обновить выбранные списки');
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Родительский контроль'), badge(set.parentalEnabled ? 'ok' : '', set.parentalEnabled ? 'включён' : 'выключен')),
      h('p', { class: 'section-note' }, 'Профили блокируют домены и поддомены; можно дополнить своим списком. Изменение настроек и отключение защиты требуют PIN-код.'),
      form,
      h('div', { class: 'btn-row' }, updateButton),
      h('p', { class: 'help-text' },
        'Последнее обновление: ',
        set.parentalListsUpdatedAt ? fmtDate(set.parentalListsUpdatedAt) : 'ещё не загружались',
        '. Списки обновляются только по вашей команде. Категорийные фильтры не гарантируют блокировку каждого нежелательного сайта.'));
  }

  function accountCard(): HTMLElement {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Dark.Account'), badge(st.signedIn ? 'ok' : '', st.signedIn ? 'привязан' : 'не привязан')),
      h('p', { class: 'section-note' }, st.signedIn ? 'Браузер привязан к аккаунту ' + (st.user ? st.user.username : '') + '.' : 'Войдите в аккаунт, чтобы привязать этот браузер.'),
      h('a', { class: 'btn', href: 'dark://account' }, 'Открыть аккаунт'));
  }

  function dataCard(): HTMLElement {
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Данные')),
      h('p', { class: 'section-note' }, 'Закладки, история и загрузки хранятся только на этом компьютере.'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: 'dark://bookmarks' }, 'Закладки'),
        h('a', { class: 'btn', href: 'dark://history' }, 'История'),
        h('a', { class: 'btn', href: 'dark://downloads' }, 'Загрузки'),
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
      h('p', null, 'Поиск, запуск, прокси и родительский контроль.'),
    );
    if (flash) root.appendChild(h('div', { class: 'toast-stack' }, alertBox(flash.kind, flash.text)));
    root.append(general(), proxyCard(), parentalCard(), accountCard(), dataCard(), aboutCard());
    flash = null;
  }

  api.onAccountChanged((s) => { st = s; });
  void Promise.all([api.account.state(), api.settings.get(), api.about()]).then(([s, g, a]) => { st = s; set = g; about = a; render(); });
})();
