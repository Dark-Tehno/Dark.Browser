(function () {
  "use strict";
  const api = window.darkDialog;
  const title = document.getElementById('dialog-title') as HTMLElement;
  const message = document.getElementById('message') as HTMLElement;
  const detail = document.getElementById('detail') as HTMLElement;
  const icon = document.getElementById('icon') as HTMLElement;
  const actions = document.getElementById('actions') as HTMLElement;
  const close = document.getElementById('close') as HTMLButtonElement;
  let current: BrowserDialogData | null = null;

  function respond(index: number): void {
    if (!current) return;
    api.respond(current.id, index);
    current = null;
  }

  api.onShow((data) => {
    current = data;
    title.textContent = data.title;
    message.textContent = data.message;
    detail.textContent = data.detail ?? '';
    detail.hidden = !data.detail;
    icon.className = `dialog-icon ${data.kind}`;
    actions.replaceChildren();
    data.buttons.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (index === data.defaultId) button.classList.add('primary');
      button.addEventListener('click', () => respond(index));
      actions.append(button);
    });
    const defaultButton = actions.querySelector('button') as HTMLButtonElement | null;
    const preferred = actions.children.item(data.defaultId) as HTMLButtonElement | null;
    (preferred ?? defaultButton)?.focus();
  });

  close.addEventListener('click', () => respond(current?.cancelId ?? 0));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') respond(current?.cancelId ?? 0);
    if (event.key === 'Enter' && current) respond(current.defaultId);
  });
})();
