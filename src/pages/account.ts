(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;

  type View = 'profile' | 'security' | 'devices' | 'history';
  type Flash = { kind: 'success' | 'error' | 'warning' | 'info'; text: string };

  let st: AccountState;
  let view: View = 'profile';
  let mode: 'login' | 'register' = 'login';
  let challenge: { id: string; expires: string } | null = null;
  let flash: Flash | null = null;
  let editing: string | null = null;
  let devices: AccountDevice[] | null = null;
  let records: LoginRecord[] | null = null;

  const setFlash = (kind: Flash['kind'], text: string): void => {
    flash = { kind, text };
  };
  const errText = (r: ApiErr): string => r.message;

  async function guard<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T> {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ───────── вход / регистрация / 2FA ─────────

  function authCard(): HTMLElement {
    const box = h('div', { class: 'auth-wrap' });
    const card = h('div', { class: 'card auth-card' });
    box.appendChild(card);
    card.appendChild(h('div', { class: 'eyebrow' }, 'Dark.Account'));

    if (challenge) return twoFactorCard(box, card);

    card.append(
      h('h1', null, mode === 'login' ? 'Вход в аккаунт' : 'Создать аккаунт'),
      h('p', null, mode === 'login' ? 'Войдите, чтобы привязать этот браузер к аккаунту Dark.Account.' : 'Новый аккаунт Dark.Account. Браузер будет привязан к нему сразу после регистрации.'),
    );
    if (flash) card.appendChild(alertBox(flash.kind, flash.text));

    const err = h('div');
    const form = h('form', { novalidate: true });
    const submit = h('button', { class: 'btn grad block', type: 'submit' }, mode === 'login' ? 'Войти' : 'Зарегистрироваться');

    if (mode === 'login') {
      const u = h('input', { class: 'input', id: 'a-user', autocomplete: 'username', required: true });
      const p = h('input', { class: 'input', id: 'a-pass', type: 'password', autocomplete: 'current-password', required: true });
      form.append(field('Имя пользователя', u), field('Пароль', p), submit);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clear(err);
        flash = null;
        const r = await guard(submit, () => api.account.login(u.value.trim(), p.value));
        await afterAuth(r, err);
      });
      setTimeout(() => u.focus(), 0);
    } else {
      const em = h('input', { class: 'input', id: 'a-email', type: 'email', autocomplete: 'email', required: true });
      const u = h('input', { class: 'input', id: 'a-user', autocomplete: 'username' });
      const p = h('input', { class: 'input', id: 'a-pass', type: 'password', autocomplete: 'new-password', required: true });
      const lang = select([['Russian', 'Русский'], ['English', 'English']], 'Russian', 'a-lang');
      form.append(
        field('Email', em),
        field('Имя пользователя', u, 'Необязательно. По умолчанию — часть email до «@».'),
        field('Пароль', p),
        field('Язык', lang),
        submit,
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clear(err);
        const r = await guard(submit, () =>
          api.account.register({ email: em.value.trim(), password: p.value, username: u.value.trim() || undefined, language: lang.value }),
        );
        await afterAuth(r, err);
      });
      setTimeout(() => em.focus(), 0);
    }
    card.append(err, form);
    card.appendChild(
      h(
        'div',
        { class: 'auth-links' },
        h('a', { tabindex: 0, role: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; flash = null; render(); } }, mode === 'login' ? 'Создать аккаунт' : 'Уже есть аккаунт'),
        h('span', { class: 'sep' }, '·'),
        h('a', { href: 'https://vsp210.ru/account/', target: '_blank', rel: 'noopener' }, 'Dark.Account на сайте'),
      ),
    );
    return box;
  }

  async function afterAuth(r: ApiResult<LoginOutcome>, errBox: HTMLElement): Promise<void> {
    if (!r.ok) {
      errBox.appendChild(alertBox('error', errText(r)));
      errBox.style.marginBottom = '18px';
      return;
    }
    if (r.data.status === 'two_factor') {
      challenge = { id: r.data.challengeId, expires: r.data.expiresAt };
      flash = null;
    } else {
      setFlash('success', 'Браузер привязан к аккаунту.');
      st = await api.account.state();
    }
    render();
  }

  function twoFactorCard(box: HTMLElement, card: HTMLElement): HTMLElement {
    card.append(
      h('h1', null, 'Подтвердите вход'),
      h('p', null, `Мы отправили код на email аккаунта. Он действует до ${fmtDate(challenge!.expires)}.`),
    );
    if (flash) card.appendChild(alertBox(flash.kind, flash.text));
    const err = h('div');
    const code = h('input', { class: 'code-display', id: 'a-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, 'aria-label': 'Код из письма' });
    const submit = h('button', { class: 'btn grad block', type: 'submit', style: 'margin-top:16px' }, 'Подтвердить');
    const form = h('form', { novalidate: true }, code, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(err);
      const r = await guard(submit, () => api.account.verify(challenge!.id, code.value.trim()));
      if (!r.ok) {
        err.appendChild(alertBox('error', errText(r)));
        err.style.marginBottom = '18px';
        if (r.code === 'INVALID_OR_EXPIRED_TWO_FACTOR_CHALLENGE') {
          challenge = null;
          render();
        }
        return;
      }
      challenge = null;
      setFlash('success', 'Браузер привязан к аккаунту.');
      st = await api.account.state();
      render();
    });
    const resend = h('button', { class: 'btn block', type: 'button', style: 'margin-top:14px' }, 'Отправить код ещё раз');
    resend.addEventListener('click', async () => {
      const r = await guard(resend, () => api.account.resend(challenge!.id));
      if (!r.ok) {
        clear(err);
        err.appendChild(alertBox('error', errText(r)));
        return;
      }
      challenge = { id: r.data.challengeId, expires: r.data.expiresAt };
      setFlash('success', 'Новый код отправлен на email.');
      render();
    });
    card.append(err, form, resend);
    card.appendChild(
      h('div', { class: 'auth-links' }, h('a', { tabindex: 0, role: 'button', onclick: () => { challenge = null; flash = null; render(); } }, 'Вернуться ко входу')),
    );
    setTimeout(() => code.focus(), 0);
    return box;
  }

  // ───────── кабинет ─────────

  function nav(): HTMLElement {
    const link = (v: View, text: string): HTMLElement =>
      h('button', { class: 'tab-link' + (view === v ? ' active' : ''), type: 'button', onclick: () => go(v) }, h('span', { class: 'dot' }), text);
    return h(
      'nav',
      { class: 'dash-nav', 'aria-label': 'Разделы аккаунта' },
      h('div', { class: 'side-group-label' }, 'Аккаунт'),
      link('profile', 'Профиль'),
      link('security', 'Безопасность'),
      link('devices', 'Устройства'),
      link('history', 'История входов'),
      h('div', { class: 'side-group-label' }, 'Действия'),
      h('button', { class: 'tab-link', type: 'button', onclick: signOut }, h('span', { class: 'dot' }), 'Выйти'),
    );
  }

  function go(v: View): void {
    view = v;
    flash = null;
    editing = null;
    render();
    if (v === 'devices') void loadDevices();
    if (v === 'history') void loadHistory();
    if (v === 'profile') void refreshProfile();
  }

  async function signOut(): Promise<void> {
    await api.account.logout();
    devices = records = null;
    setFlash('info', 'Вы вышли из аккаунта. Браузер отвязан.');
    st = await api.account.state();
    render();
  }

  async function refreshProfile(): Promise<void> {
    const r = await api.account.profile();
    st = await api.account.state();
    if (!r.ok && !st.signedIn) setFlash('warning', errText(r));
    render();
  }

  function dashboard(): HTMLElement {
    const main = h('div', { class: 'dash-main' });
    if (flash) main.appendChild(h('div', { class: 'toast-stack' }, alertBox(flash.kind, flash.text)));
    if (view === 'profile') main.append(...profileCards());
    else if (view === 'security') main.append(...securityCards());
    else if (view === 'devices') main.append(devicesCard());
    else main.append(historyCard());
    return h('div', { class: 'dash-grid' }, nav(), main);
  }

  function profileCards(): HTMLElement[] {
    const u = st.user!;
    const initial = (u.username || '?').charAt(0).toUpperCase();
    let avatar: HTMLElement;
    const avatarSrc = st.avatarData || u.avatar;
    if (avatarSrc) {
      const img = h('img', { class: 'avatar-preview', src: avatarSrc, alt: 'Аватар' });
      img.addEventListener('error', () => img.replaceWith(h('div', { class: 'avatar-preview avatar-fallback' }, initial)));
      avatar = img;
    } else avatar = h('div', { class: 'avatar-preview avatar-fallback' }, initial);

    const head = h(
      'div',
      { class: 'card' },
      h('div', { class: 'profile-head' },
        avatar,
        h('div', { class: 'profile-head-meta' },
          h('div', { class: 'username' }, u.username),
          h('div', { class: 'sub' }, u.email || 'email не указан'),
          h('div', { class: 'badge-row' },
            badge(u.email_confirmed ? 'ok' : 'warn', u.email_confirmed ? 'почта подтверждена' : 'почта не подтверждена'),
            badge(u.two_factor_enabled ? 'ok' : '', u.two_factor_enabled ? '2FA включена' : '2FA выключена'),
            badge('info', u.language === 'English' ? 'English' : 'Русский'),
          ),
        ),
      ),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat-box' }, h('div', { class: 'num small' }, fmtDate(u.date_joined, false)), h('div', { class: 'label' }, 'в аккаунте с')),
        h('div', { class: 'stat-box' }, h('div', { class: 'num small' }, fmtDate(u.last_online)), h('div', { class: 'label' }, 'последняя активность')),
        h('div', { class: 'stat-box' }, h('div', { class: 'num small' }, '#' + u.id), h('div', { class: 'label' }, 'идентификатор')),
      ),
    );
    return [head, profileForm(u)];
  }

  function profileForm(u: AccountUser): HTMLElement {
    const username = h('input', { class: 'input', id: 'p-user', value: u.username, maxlength: 150, required: true });
    const info = h('textarea', { class: 'input', id: 'p-info', rows: 3 });
    info.value = u.info ?? '';
    const dob = h('input', { class: 'input', id: 'p-dob', type: 'date', value: u.date_of_birth ?? '' });
    const lang = select([['Russian', 'Русский'], ['English', 'English']], u.language, 'p-lang');
    const access = select([['', 'Не менять'], ['all', 'Все'], ['authenticated', 'Только вошедшие'], ['nobody', 'Никто']], '', 'p-access');
    const file = h('input', { type: 'file', id: 'p-file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    const err = h('div');
    const save = h('button', { class: 'btn grad', type: 'submit' }, 'Сохранить изменения');

    const form = h('form', { novalidate: true },
      h('div', { class: 'form-row' }, field('Имя пользователя', username), field('Язык', lang)),
      field('О себе', info),
      h('div', { class: 'form-row' }, field('Дата рождения', dob), field('Кто видит аватар', access)),
      field('Новый аватар', file, 'PNG, JPEG, WebP или GIF, до 5 МБ.'),
      err,
      save,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(err);
      const patch: Record<string, unknown> = {};
      if (username.value.trim() !== u.username) patch.username = username.value.trim();
      if ((info.value.trim() || null) !== (u.info || null)) patch.info = info.value.trim() || null;
      if ((dob.value || null) !== (u.date_of_birth || null)) patch.date_of_birth = dob.value || null;
      if (lang.value !== u.language) patch.language = lang.value;
      const picked = file.files && file.files[0];
      if (access.value && !picked) patch.avatar_access = access.value;

      const result = await guard(save, async (): Promise<ApiResult<AccountUser> | null> => {
        let last: ApiResult<AccountUser> | null = null;
        if (Object.keys(patch).length) {
          last = await api.account.updateProfile(patch);
          if (!last.ok) return last;
        }
        if (picked) last = await api.account.uploadAvatar({ name: picked.name, type: picked.type, bytes: await picked.arrayBuffer() }, access.value || undefined);
        return last;
      });
      if (result && !result.ok) {
        err.appendChild(alertBox('error', errText(result)));
        err.style.marginBottom = '18px';
        return;
      }
      setFlash(result ? 'success' : 'info', result ? 'Профиль обновлён.' : 'Изменений нет.');
      st = await api.account.state();
      render();
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Данные профиля')), h('p', { class: 'section-note' }, 'Изменения сохраняются в аккаунте Dark.Account на всех устройствах.'), form);
  }

  function securityCards(): HTMLElement[] {
    const u = st.user!;
    const toggle = h('button', { class: 'btn ' + (u.two_factor_enabled ? 'danger' : 'grad'), type: 'button' }, u.two_factor_enabled ? 'Отключить 2FA' : 'Включить 2FA');
    const err = h('div');
    toggle.addEventListener('click', async () => {
      if (u.two_factor_enabled && !(await api.confirm('Отключить двухфакторную аутентификацию?'))) return;
      clear(err);
      const r = await guard(toggle, () => api.account.setTwoFactor(!u.two_factor_enabled));
      if (!r.ok) {
        err.append(alertBox('error', errText(r)));
        return;
      }
      setFlash('success', r.data ? 'Двухфакторная аутентификация включена.' : 'Двухфакторная аутентификация отключена.');
      st = await api.account.state();
      render();
    });
    const twofa = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Двухфакторная аутентификация'), badge(u.two_factor_enabled ? 'ok' : '', u.two_factor_enabled ? 'включена' : 'выключена')),
      h('p', { class: 'section-note' }, 'При входе с нового устройства на email аккаунта приходит код подтверждения. Код действует 10 минут.'),
      err,
      toggle,
    );

    const dev = st.currentDevice;
    const bind = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Привязка браузера'), badge('ok', 'привязан')),
      h('p', { class: 'section-note' }, 'Этот браузер зарегистрирован как устройство аккаунта. Отвязав его, вы удалите токен на сервере и на этом компьютере.'),
      h('dl', { class: 'kv' },
        h('dt', null, 'устройство'), h('dd', null, dev?.name || 'Dark Browser'),
        h('dt', null, 'device_id'), h('dd', null, h('code', null, dev?.device_id || st.deviceId)),
        h('dt', null, 'приложение'), h('dd', null, h('code', null, st.application)),
        h('dt', null, 'токен'), h('dd', null, st.persistent ? badge('ok', 'в защищённом хранилище ОС') : badge('warn', 'только в памяти до закрытия')),
      ),
      st.persistent ? null : h('p', { class: 'help-text', style: 'margin-bottom:16px' }, 'Хранилище паролей ОС недоступно, поэтому после перезапуска потребуется войти заново.'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (await api.confirm('Отвязать этот браузер от аккаунта?')) await signOut(); } }, 'Отвязать браузер'),
    );
    return [twofa, bind];
  }

  async function loadDevices(): Promise<void> {
    const r = await api.account.devices();
    if (!r.ok) {
      st = await api.account.state();
      setFlash('error', errText(r));
      devices = [];
    } else devices = r.data;
    render();
  }

  function isCurrent(d: AccountDevice): boolean {
    const c = st.currentDevice;
    return d.device_id === st.deviceId || (!!c && (c.id === d.id || c.device_id === d.device_id));
  }

  function devicesCard(): HTMLElement {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Устройства'), h('button', { class: 'btn small', type: 'button', onclick: () => void loadDevices() }, 'Обновить')),
      h('p', { class: 'section-note' }, 'Все устройства, с которых выполнен вход. Удалите незнакомое — его токен перестанет работать.'),
    );
    if (devices === null) {
      card.appendChild(h('div', { class: 'empty-row' }, 'Загрузка…'));
      return card;
    }
    if (!devices.length) {
      card.appendChild(h('div', { class: 'empty-row' }, 'Устройств пока нет.'));
      return card;
    }
    for (const d of devices) {
      const cur = isCurrent(d);
      const place = [d.city, d.country].filter(Boolean).join(', ');
      const name = editing === d.device_id
        ? (() => {
            const input = h('input', { class: 'input', value: d.name, maxlength: 100, 'aria-label': 'Название устройства' });
            const form = h('form', { style: 'display:flex;gap:8px;margin-bottom:6px', novalidate: true }, input,
              h('button', { class: 'btn grad small', type: 'submit' }, 'Сохранить'),
              h('button', { class: 'btn small', type: 'button', onclick: () => { editing = null; render(); } }, 'Отмена'));
            form.addEventListener('submit', async (e) => {
              e.preventDefault();
              const r = await api.account.updateDevice(d.device_id, { name: input.value.trim() });
              if (!r.ok) setFlash('error', errText(r));
              editing = null;
              await loadDevices();
            });
            setTimeout(() => input.focus(), 0);
            return form as HTMLElement;
          })()
        : h('div', { class: 'name' }, d.name || 'Без названия',
            cur ? badge('info', 'это устройство') : null,
            d.trusted ? badge('ok', 'доверенное') : null,
            d.blocked ? badge('danger', 'заблокировано') : null);

      devicesActions(d, cur);
      card.appendChild(
        h('div', { class: 'device-card' + (cur ? ' current' : '') },
          h('div', { class: 'device-info' }, name,
            h('div', { class: 'device-meta' },
              h('div', null, [d.application, d.application_version].filter(Boolean).join(' ') || '—', ' · ', [d.operating_system, d.system_version].filter(Boolean).join(' ') || d.device_type),
              h('div', null, 'IP ', h('code', null, d.last_ip || '—'), place ? ` · ${place}` : ''),
              h('div', null, `Добавлено ${fmtDate(d.created_at)} · активность ${fmtDate(d.last_seen)}`),
            )),
          h('div', { class: 'device-actions' },
            h('button', { class: 'btn small', type: 'button', onclick: () => { editing = d.device_id; render(); } }, 'Переименовать'),
            h('button', { class: 'btn small', type: 'button', onclick: async () => { const r = await api.account.updateDevice(d.device_id, { trusted: !d.trusted }); if (!r.ok) setFlash('error', errText(r)); await loadDevices(); } }, d.trusted ? 'Убрать доверие' : 'Доверять'),
            h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
              if (!(await api.confirm(cur ? 'Удалить это устройство и выйти из аккаунта?' : 'Удалить устройство? Его токен перестанет работать.'))) return;
              const r = await api.account.deleteDevice(d.device_id);
              if (!r.ok) setFlash('error', errText(r));
              st = await api.account.state();
              if (!st.signedIn) { devices = null; setFlash('info', 'Устройство удалено, вы вышли из аккаунта.'); render(); } else await loadDevices();
            } }, cur ? 'Отвязать' : 'Удалить'),
          )),
      );
    }
    return card;
  }
  function devicesActions(_d: AccountDevice, _cur: boolean): void { /* точка расширения */ }

  async function loadHistory(): Promise<void> {
    const r = await api.account.loginHistory();
    if (!r.ok) {
      st = await api.account.state();
      setFlash('error', errText(r));
      records = [];
    } else records = r.data;
    render();
  }

  function historyCard(): HTMLElement {
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'История входов'), h('button', { class: 'btn small', type: 'button', onclick: () => void loadHistory() }, 'Обновить')),
      h('p', { class: 'section-note' }, 'Последние попытки входа в аккаунт: удачные, неудачные и заблокированные.'),
    );
    if (records === null) {
      card.appendChild(h('div', { class: 'empty-row' }, 'Загрузка…'));
      return card;
    }
    const body = h('tbody');
    if (!records.length) body.appendChild(h('tr', null, h('td', { class: 'empty-row', colSpan: 5 }, 'Записей пока нет.')));
    for (const r of records) {
      const kind: BadgeKind = r.status === 'success' ? 'ok' : r.status === 'failed' ? 'warn' : 'danger';
      const text = r.status === 'success' ? 'успешно' : r.status === 'failed' ? 'ошибка' : 'заблокирован';
      body.appendChild(h('tr', null,
        h('td', null, fmtDate(r.created_at)),
        h('td', null, r.device_name || '—'),
        h('td', null, h('code', null, r.ip || '—')),
        h('td', null, [r.city, r.country].filter(Boolean).join(', ') || '—'),
        h('td', null, badge(kind, text), r.reason ? h('div', { class: 'help-text' }, r.reason) : null),
      ));
    }
    card.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Дата'), h('th', null, 'Устройство'), h('th', null, 'IP'), h('th', null, 'Место'), h('th', null, 'Статус'))),
      body)));
    return card;
  }

  // ───────── отрисовка ─────────

  function render(): void {
    clear(root);
    root.appendChild(st.signedIn && st.user ? dashboard() : authCard());
  }

  api.onAccountChanged((s) => {
    const was = st && st.signedIn;
    st = s;
    if (was && !s.signedIn) { devices = records = null; }
    render();
  });

  void api.account.state().then((s) => {
    st = s;
    render();
    if (s.signedIn) void refreshProfile();
  });
})();
