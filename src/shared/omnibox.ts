/** Поисковые системы адресной строки. %s — поисковый запрос. */
export const SEARCH_ENGINES: Record<string, { name: string; url: string }> = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  yandex: { name: 'Яндекс', url: 'https://yandex.ru/search/?text=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
};

export function searchUrl(engine: string, query: string): string {
  const e = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo;
  return e.url.replace('%s', encodeURIComponent(query));
}

/** Схемы, которые браузер передаёт внешним приложениям (после подтверждения). */
export const EXTERNAL_SCHEMES = new Set([
  'tg', 'mailto', 'tel', 'sms', 'viber', 'whatsapp', 'skype', 'discord',
  'steam', 'spotify', 'zoommtg', 'zoomus', 'msteams', 'slack',
]);

export function isExternalScheme(url: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return !!m && EXTERNAL_SCHEMES.has(m[1].toLowerCase());
}

const EXPLICIT = /^(https?|dark):\/\//i;
const DANGEROUS = /^(javascript|file|data|vbscript|blob|view-source|chrome|devtools|filesystem):/i;
const LOCAL = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const HOSTLIKE = /^[^\s/?#:]+\.[a-zа-я]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/**
 * Превращает ввод в адрес: полный URL остаётся URL, «хост.домен» получает https,
 * localhost и IP — http, всё остальное уходит в поиск. Опасные схемы
 * (javascript:, file:, data: …) никогда не открываются, а ищутся как текст.
 */
export function resolveInput(raw: string, engine: string, homepage: string): string {
  const t = raw.trim();
  if (!t) return homepage;
  if (EXPLICIT.test(t)) {
    try {
      return new URL(t).href;
    } catch {
      return searchUrl(engine, t);
    }
  }
  if (t === 'about:blank') return t;
  if (isExternalScheme(t) && !/\s/.test(t)) return t;
  if (DANGEROUS.test(t)) return searchUrl(engine, t);
  if (!/\s/.test(t)) {
    if (LOCAL.test(t)) return normalize(`http://${t}`, engine, t);
    if (HOSTLIKE.test(t)) return normalize(`https://${t}`, engine, t);
  }
  return searchUrl(engine, t);
}

function normalize(url: string, engine: string, original: string): string {
  try {
    return new URL(url).href;
  } catch {
    return searchUrl(engine, original);
  }
}
