(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let list: Bookmark[] = [];

  function render(): void {
    clear(root);
    const title = h('input', { class: 'input', id: 'b-title', placeholder: 'Название (необязательно)', 'aria-label': 'Название' });
    const url = h('input', { class: 'input', id: 'b-url', placeholder: 'Адрес сайта', 'aria-label': 'Адрес', spellcheck: false });
    const add = h('form', { class: 'toolbar', novalidate: true }, title, url, h('button', { class: 'btn grad', type: 'submit' }, 'Добавить'));
    add.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!url.value.trim()) return;
      list = await api.bookmarks.add(title.value, url.value);
      render();
    });

    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Все закладки'), badge('', `${list.length}`)),
      h('p', { class: 'section-note' }, 'Добавить текущую страницу можно звёздочкой в адресной строке или клавишами Ctrl+D.'),
      add);
    if (!list.length) card.appendChild(h('div', { class: 'empty-row' }, 'Закладок пока нет.'));
    for (const b of list) {
      card.appendChild(h('div', { class: 'list-row' },
        h('div', { class: 'list-main' }, h('a', { href: b.url }, b.title), h('span', { class: 'u' }, b.url)),
        h('span', { class: 'list-time' }, fmtDate(b.added, false)),
        h('button', { class: 'btn small danger', type: 'button', onclick: async () => { list = await api.bookmarks.remove(b.id); render(); } }, 'Удалить')));
    }
    root.append(h('div', { class: 'eyebrow' }, 'Dark.Browser'), h('h1', null, 'Закладки'), h('p', null, 'Сохранённые страницы. Хранятся на этом компьютере.'), card);
  }

  void api.bookmarks.list().then((l) => { list = l; render(); });
})();
