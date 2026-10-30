(function () {
  "use strict";
  const api = window.darkDialog;
  const title = document.getElementById('dialog-title') as HTMLElement;
  const message = document.getElementById('message') as HTMLElement;
  const detail = document.getElementById('detail') as HTMLElement;
  const icon = document.getElementById('icon') as HTMLElement;
  const actions = document.getElementById('actions') as HTMLElement;
  const close = document.getElementById('close') as HTMLButtonElement;
  const input = document.getElementById('input') as HTMLInputElement;
  let current: BrowserDialogData | null = null;

  function respond(index: number): void {
    if (!current) return;
    api.respond(current.id, index, current.input ? input.value : undefined);
    current = null;
  }

  api.onShow((data) => {
    current = data;
    title.textContent = data.title;
    message.textContent = data.message;
    detail.textContent = data.detail ?? '';
    detail.hidden = !data.detail;
    icon.className = `dialog-icon ${data.kind}`;
    input.hidden = !data.input;
    input.value = data.input ? data.input.value : '';
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
    if (data.input) {
      input.focus();
      input.select();
    } else {
      (preferred ?? defaultButton)?.focus();
    }
  });

  close.addEventListener('click', () => respond(current?.cancelId ?? 0));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') respond(current?.cancelId ?? 0);
    // Enter на кнопке нажимает именно её; на поле ввода и в остальных местах — кнопку по умолчанию.
    if (event.key === 'Enter' && current && !(event.target instanceof HTMLButtonElement)) respond(current.defaultId);
  });
})();