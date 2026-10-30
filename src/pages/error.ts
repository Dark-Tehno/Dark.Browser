(function () {
  "use strict";
  const root = document.getElementById('app') as HTMLElement;
  const q = new URLSearchParams(location.search);
  const url = q.get('url') || '';
  const desc = q.get('desc') || 'UNKNOWN';
  const code = q.get('code') || '';

  const hints: Record<string, string> = {
    ERR_NAME_NOT_RESOLVED: 'Не удалось найти сервер. Проверьте адрес и подключение к интернету.',
    ERR_INTERNET_DISCONNECTED: 'Нет подключения к интернету.',
    ERR_CONNECTION_REFUSED: 'Сервер отклонил соединение.',
    ERR_CONNECTION_TIMED_OUT: 'Сервер слишком долго не отвечает.',
    ERR_CERT_AUTHORITY_INVALID: 'Сертификат сайта не вызывает доверия. Соединение не защищено.',
    ERR_CERT_DATE_INVALID: 'Срок действия сертификата сайта истёк или ещё не наступил.',
    ERR_CERT_COMMON_NAME_INVALID: 'Сертификат выдан на другое имя сайта.',
  };
  const safe = /^https?:\/\//i.test(url);

  root.appendChild(h('div', { class: 'auth-wrap' }, h('div', { class: 'card', style: 'max-width:560px;width:100%;padding:34px 32px' },
    h('div', { class: 'eyebrow' }, 'Ошибка загрузки'),
    h('h1', null, 'Не удалось открыть страницу'),
    h('p', null, hints[desc] || 'Страница недоступна. Попробуйте ещё раз чуть позже.'),
    h('dl', { class: 'kv' },
      h('dt', null, 'адрес'), h('dd', null, h('code', null, url || '—')),
      h('dt', null, 'код'), h('dd', null, h('code', null, desc + (code ? ` (${code})` : '')))),
    h('div', { class: 'btn-row' },
      safe ? h('a', { class: 'btn grad', href: url }, 'Повторить') : null,
      h('a', { class: 'btn', href: 'dark://home' }, 'На главную')),
  )));
})();
