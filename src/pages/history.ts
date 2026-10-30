(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let list: HistoryEntry[] = [];
  let query = '';

  function dayLabel(ts: number): string {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === y.toDateString()) return 'Вчера';
    return fmtDate(ts, false);
  }

  function shell(): { body: HTMLElement; search: HTMLInputElement } {
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск по истории', 'aria-label': 'Поиск по истории', value: query });
    const body = h('div');
    const clearBtn = h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!list.length || !(await api.confirm('Очистить всю историю просмотров?'))) return;
      list = await api.history.clear();
      draw(body);
    } }, 'Очистить историю');
    root.append(
      h('div', { class: 'eyebrow' }, 'Dark.Browser'),
      h('h1', null, 'История'),
      h('p', null, 'Посещённые страницы. Хранится на этом компьютере.'),
      h('div', { class: 'card' }, h('div', { class: 'toolbar' }, search, clearBtn), body),
    );
    return { body, search };
  }

  function draw(body: HTMLElement): void {
    clear(body);
    const q = query.trim().toLowerCase();
    const items = q ? list.filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)) : list;
    if (!items.length) {
      body.appendChild(h('div', { class: 'empty-row' }, q ? 'Ничего не найдено.' : 'История пуста.'));
      return;
    }
    let last = '';
    for (const e of items.slice(0, 500)) {
      const label = dayLabel(e.visited);
      if (label !== last) {
        body.appendChild(h('div', { class: 'group-label' }, label));
        last = label;
      }
      const t = new Date(e.visited);
      body.appendChild(h('div', { class: 'list-row' },
        h('span', { class: 'list-time' }, `${pad(t.getHours())}:${pad(t.getMinutes())}`),
        h('div', { class: 'list-main' }, h('a', { href: e.url }, e.title || e.url), h('span', { class: 'u' }, e.url)),
        h('button', { class: 'btn small', type: 'button', 'aria-label': 'Удалить запись', onclick: async () => { list = await api.history.remove(e.url, e.visited); draw(body); } }, 'Удалить')));
    }
  }

  void api.history.list().then((l) => {
    list = l;
    const { body, search } = shell();
    search.addEventListener('input', () => { query = search.value; draw(body); });
    draw(body);
  });
})();
