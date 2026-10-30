(function () {
  "use strict";
  const api = window.dark;
  const root = document.getElementById('app') as HTMLElement;
  let list: DownloadEntry[] = [];
  let error: string | null = null;

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
  }

  function status(entry: DownloadEntry): string {
    if (entry.state === 'completed') return 'Завершено';
    if (entry.state === 'cancelled') return 'Отменено';
    if (entry.state === 'interrupted') return 'Прервано';
    return entry.totalBytes > 0
      ? `Загрузка · ${Math.min(100, Math.floor(entry.receivedBytes / entry.totalBytes * 100))}%`
      : `Загрузка · ${size(entry.receivedBytes)}`;
  }

  function showError(message: string): void {
    error = message;
    render();
  }

  function render(): void {
    clear(root);
    const items = h('div', { class: 'download-list' });
    if (list.length) {
      items.append(...list.map((entry) => h('div', { class: 'download-row' },
        h('div', { class: 'download-main' },
          h('strong', null, entry.filename || entry.url),
          h('a', { class: 'u', href: entry.url, title: entry.url }, entry.url),
          h('div', { class: 'download-meta' }, `${status(entry)} · ${size(entry.receivedBytes)}${entry.totalBytes ? ` / ${size(entry.totalBytes)}` : ''} · ${fmtDate(entry.ended ?? entry.started)}`),
          entry.state === 'progress' && entry.totalBytes > 0 ? h('progress', { class: 'download-progress', max: entry.totalBytes, value: entry.receivedBytes }) : null),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', type: 'button', disabled: entry.state !== 'completed', onclick: () => { void api.downloads.open(entry.id).catch((e: unknown) => showError(e instanceof Error ? e.message : 'Не удалось открыть файл.')); } }, 'Открыть'),
          h('button', { class: 'btn small', type: 'button', disabled: !entry.path, onclick: () => { void api.downloads.show(entry.id).catch((e: unknown) => showError(e instanceof Error ? e.message : 'Не удалось показать файл.')); } }, 'В папке'),
          h('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Удалить запись', onclick: async () => { list = await api.downloads.remove(entry.id); render(); } }, 'Удалить')))));
    } else {
      items.appendChild(h('div', { class: 'empty-row' }, 'Загрузок пока нет.'));
    }
    const clearButton = h('button', {
      class: 'btn danger',
      type: 'button',
      disabled: !list.length,
      onclick: async () => {
        if (!(await api.confirm('Очистить историю загрузок?'))) return;
        list = await api.downloads.clear();
        render();
      },
    }, 'Очистить историю загрузок');
    root.append(
      h('div', { class: 'eyebrow' }, 'Dark.Browser'),
      h('h1', null, 'Загрузки'),
      h('p', null, 'Файлы сохраняются в папку загрузок системы. История хранится на этом компьютере.'),
    );
    if (error) root.appendChild(h('div', { class: 'toast-stack' }, alertBox('error', error)));
    root.appendChild(
      h('div', { class: 'card' },
        h('div', { class: 'toolbar' }, h('a', { class: 'btn', href: 'dark://history' }, 'История просмотров'), clearButton),
        items),
    );
    error = null;
  }

  api.downloads.onChanged((entries) => {
    list = entries;
    render();
  });
  void api.downloads.list().then((entries) => {
    list = entries;
    render();
  });
})();
