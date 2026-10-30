"use strict";
// Общие помощники для страниц (подключаются обычным <script>, без зависимостей).

type Child = Node | string | number | null | undefined | false;

function append(el: Node, kids: Child[]): void {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    el.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
}

/** Создаёт элемент. Текст всегда вставляется как текст — никакого innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: { [k: string]: any } | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && k !== 'list') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** d.m.Y или d.m.Y H:i */
function fmtDate(iso?: string | number | null, withTime = true): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

type BadgeKind = 'ok' | 'warn' | 'danger' | 'info' | '';

/** Бейдж со статусной точкой; состояние всегда продублировано текстом. */
function badge(kind: BadgeKind, text: string): HTMLElement {
  return h('span', { class: 'badge' + (kind ? ' badge-' + kind : '') }, h('span', { class: 'sw' }), text);
}

function alertBox(kind: 'success' | 'error' | 'warning' | 'info', text: string): HTMLElement {
  return h('div', { class: 'alert alert-' + kind, role: kind === 'error' ? 'alert' : 'status' }, text);
}

function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  const id = input.id || '';
  return h('div', { class: 'form-group' }, h('label', { for: id }, label), input, help ? h('div', { class: 'help-text' }, help) : null);
}

function select(options: [string, string][], value: string, id?: string): HTMLSelectElement {
  const s = h('select', { class: 'input', id });
  for (const [v, t] of options) s.appendChild(h('option', { value: v }, t));
  s.value = value;
  return s;
}

function logoMark(size: number, uid: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 26 26');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    `<defs><linearGradient id="${uid}" x1="2" y1="2" x2="24" y2="24" gradientUnits="userSpaceOnUse">` +
    '<stop offset="0" stop-color="#7c5cff"/><stop offset="0.55" stop-color="#3e7bfa"/><stop offset="1" stop-color="#22d3e8"/></linearGradient></defs>' +
    `<circle cx="13" cy="13" r="11" stroke="url(#${uid})" stroke-width="2.4"/>` +
    `<path d="M9.5 7.5H13.2C15.9 7.5 18 9.7 18 13C18 16.3 15.9 18.5 13.2 18.5H9.5V7.5Z" stroke="url(#${uid})" stroke-width="1.8" stroke-linejoin="round"/>`;
  return svg;
}
