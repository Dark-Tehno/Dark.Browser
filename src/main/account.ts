import { app, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { JsonStore } from './store';

/** Базовый адрес Account API. Можно переопределить переменной DARK_API_BASE. */
export const API_BASE = (process.env.DARK_API_BASE || 'https://vsp210.ru/account/api/').replace(/\/*$/, '/');
const ORIGIN = new URL(API_BASE).origin;

const APP_TYPE = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

interface Persisted {
  deviceId: string;
  tokenEnc: string;
  user: AccountUser | null;
  device: AccountDevice | null;
}

const MESSAGES: Record<string, string> = {
  EMAIL_PASSWORD_NOT_PROVIDED: 'Укажите email и пароль.',
  LANGUAGE_NOT_SUPPORTED: 'Этот язык не поддерживается.',
  USERNAME_PASSWORD_NOT_PROVIDED: 'Укажите имя пользователя и пароль.',
  INVALID_CREDENTIALS: 'Неверное имя пользователя или пароль.',
  TWO_FACTOR_EMAIL_NOT_CONFIGURED: 'У аккаунта не настроен email для двухфакторной аутентификации.',
  INVALID_OR_EXPIRED_TWO_FACTOR_CODE: 'Код неверный или истёк. Запросите новый код.',
  INVALID_OR_EXPIRED_TWO_FACTOR_CHALLENGE: 'Время подтверждения истекло. Войдите заново.',
  CHALLENGE_CODE_NOT_PROVIDED: 'Введите код из письма.',
  INVALID_DEVICE_ID: 'Некорректный идентификатор устройства.',
  INVALID_TWO_FACTOR_ENABLED: 'Некорректное значение настройки.',
  DEVICE_ID_NOT_PROVIDED: 'Не указан идентификатор устройства.',
  DEVICE_NOT_FOUND: 'Устройство не найдено.',
  USERNAME_NOT_PROVIDED: 'Укажите имя для поиска.',
};

const FIELDS: Record<string, string> = {
  username: 'Имя пользователя',
  email: 'Email',
  password: 'Пароль',
  info: 'О себе',
  date_of_birth: 'Дата рождения',
  avatar: 'Аватар',
  avatar_access: 'Доступ к аватару',
  language: 'Язык',
  name: 'Название',
  trusted: 'Доверие',
  non_field_errors: '',
  detail: '',
};

const canEncrypt = (): boolean => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};
const encrypt = (s: string): string => (canEncrypt() ? safeStorage.encryptString(s).toString('base64') : '');
const decrypt = (b: string): string | null => {
  if (!b || !canEncrypt()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b, 'base64'));
  } catch {
    return null;
  }
};

const fail = (code: string, message: string, status = 0): ApiErr => ({ ok: false, code, message, status });

function flatten(j: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(j)) {
    if (k === 'status') continue;
    const text = Array.isArray(v) ? v.map(String).join(' ') : typeof v === 'string' ? v : '';
    if (!text) continue;
    const label = k in FIELDS ? FIELDS[k] : k;
    parts.push(label ? `${label}: ${text}` : text);
  }
  return parts.join(' ');
}

function failure(status: number, j: Record<string, unknown> | null): ApiErr {
  const code = typeof j?.message === 'string' ? j.message : '';
  let message = code ? MESSAGES[code] : undefined;
  const known = !!message;
  if (!message) {
    if (typeof j?.detail === 'string') message = j.detail;
    else if (status === 429) message = 'Слишком много запросов. Подождите минуту и повторите.';
    else if (j && typeof j === 'object') message = flatten(j);
  }
  if (!message) message = `Сервер вернул ошибку (HTTP ${status}).`;
  if (status === 403 && !known) message += ' Если ошибка повторяется, проверьте секретный ключ приложения в настройках.';
  return fail(code || `HTTP_${status}`, message, status);
}

function normUser(u: AccountUser): AccountUser {
  let avatar = u.avatar || null;
  if (avatar) {
    try {
      // Относительный адрес → абсолютный; http:// своего же сервера → схема сервера (обычно https).
      const a = new URL(avatar, ORIGIN);
      const o = new URL(ORIGIN);
      if (a.host === o.host) a.protocol = o.protocol;
      avatar = a.href;
    } catch {
      avatar = null;
    }
  }
  return { ...u, avatar };
}

type Raw = ApiOk<any> | ApiErr;

/**
 * Клиент Dark.Account API и хранилище привязки браузера к аккаунту.
 *
 * Токен устройства и секретный ключ приложения шифруются средствами ОС
 * (safeStorage). Если шифрование недоступно, они живут только в памяти.
 */
export class AccountService extends EventEmitter {
  private readonly store: JsonStore<Persisted>;
  private token: string | null = null;
  private user: AccountUser | null = null;
  private device: AccountDevice | null = null;
  private avatarUrl = '';
  private avatarData: string | null = null;

  constructor(userData: string) {
    super();
    this.store = new JsonStore<Persisted>(path.join(userData, 'account.json'), {
      deviceId: '',
      tokenEnc: '',
      user: null,
      device: null,
    });
    if (!this.store.get().deviceId) this.store.patch({ deviceId: randomUUID() });
    const p = this.store.get();
    this.token = decrypt(p.tokenEnc);
    if (this.token) {
      this.user = p.user;
      this.device = p.device;
    }
    if (this.token) {
      void this.refreshAvatar();
      void this.profile();
    }
  }

  flush(): void {
    this.store.flush();
  }

  state(): AccountState {
    return {
      signedIn: !!this.token,
      user: this.token ? this.user : null,
      avatarData: this.token ? this.avatarData : null,
      currentDevice: this.token ? this.device : null,
      deviceId: this.store.get().deviceId,
      persistent: canEncrypt(),
      application: `${APP_TYPE}|${app.getVersion()}`,
    };
  }

  // ───────── сессия ─────────

  private setSession(token: string, user: AccountUser, device: AccountDevice | null): void {
    this.token = token;
    this.user = normUser(user);
    this.device = device;
    this.avatarUrl = '';
    this.store.patch({ tokenEnc: encrypt(token), user: this.user, device });
    void this.refreshAvatar();
    this.emit('change');
  }

  private dropSession(): void {
    this.token = null;
    this.user = null;
    this.device = null;
    this.avatarUrl = '';
    this.avatarData = null;
    this.store.patch({ tokenEnc: '', user: null, device: null });
    this.emit('change');
  }

  private setUser(user: AccountUser): AccountUser {
    this.user = normUser(user);
    this.store.patch({ user: this.user });
    void this.refreshAvatar();
    this.emit('change');
    return this.user;
  }

  /**
   * Аватар скачивается основным процессом (с токеном, если доступ «только вошедшим»)
   * и отдаётся страницам как data: URL — так он виден независимо от CSP и прав доступа.
   */
  private async refreshAvatar(): Promise<void> {
    const url = this.user?.avatar ?? '';
    if (url === this.avatarUrl) return;
    this.avatarUrl = url;
    this.avatarData = null;
    if (!url) return;
    const data = await this.fetchAvatar(url);
    if (data && url === this.avatarUrl) {
      this.avatarData = data;
      this.emit('change');
    }
  }

  private async fetchAvatar(url: string): Promise<string | null> {
    try {
      if (new URL(url).origin !== ORIGIN) return null;
      const headers: Record<string, string> = { Accept: 'image/*', 'User-Agent': `DarkBrowser/${app.getVersion()}` };
      if (this.token) headers.Authorization = `Token ${this.token}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) return null;
      return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  // ───────── HTTP ─────────

  private async request(
    method: string,
    route: string,
    opts: { body?: unknown; form?: FormData; auth?: boolean } = {},
  ): Promise<Raw> {
    if (opts.auth && !this.token) return fail('NOT_SIGNED_IN', 'Вы не вошли в аккаунт.', 401);

    const headers: Record<string, string> = {
      // Секрет больше не нужен; тип и версия приложения передаются в прежнем формате с пустым секретом.
      // Если сервер перестал читать этот заголовок — строку можно удалить.
      'DARK-TALK-SECRET-KEY': `--${APP_TYPE}|${app.getVersion()}`,
      Accept: 'application/json',
      'User-Agent': `DarkBrowser/${app.getVersion()} (${process.platform}; Electron ${process.versions.electron})`,
    };
    if (opts.auth && this.token) headers.Authorization = `Token ${this.token}`;
    let body: string | FormData | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      // redirect:'error' — секрет и токен не должны уходить по чужому редиректу.
      res = await fetch(API_BASE + route, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch {
      return fail('NETWORK', 'Нет связи с сервером Dark.Account. Проверьте подключение к интернету.');
    }

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        /* не JSON */
      }
    }

    if (res.ok) return { ok: true, data: json, status: res.status };

    if (opts.auth && res.status === 401) {
      this.dropSession();
      return fail('SESSION_EXPIRED', 'Сессия завершена. Войдите в аккаунт снова.', 401);
    }
    return failure(res.status, json);
  }

  // ───────── вход / регистрация ─────────

  private async finishLogin(r: Raw): Promise<ApiResult<LoginOutcome>> {
    if (!r.ok) return r;
    const d = r.data ?? {};
    if (r.status === 202 || d.status === 'two_factor_required') {
      return {
        ok: true,
        status: r.status,
        data: { status: 'two_factor', challengeId: String(d.challenge_id), expiresAt: String(d.expires_at) },
      };
    }
    if (typeof d.token !== 'string' || !d.user) return fail('BAD_RESPONSE', 'Сервер вернул неожиданный ответ.', r.status);
    this.setSession(d.token, d.user as AccountUser, (d.device as AccountDevice) ?? null);
    return { ok: true, status: r.status, data: { status: 'ok', user: this.user as AccountUser } };
  }

  async login(username: string, password: string): Promise<ApiResult<LoginOutcome>> {
    return this.finishLogin(
      await this.request('POST', 'auth/login/', { body: { username, password, device_id: this.store.get().deviceId } }),
    );
  }

  async verify(challengeId: string, code: string): Promise<ApiResult<LoginOutcome>> {
    return this.finishLogin(
      await this.request('POST', 'auth/2fa/verify/', {
        body: { challenge_id: challengeId, code, device_id: this.store.get().deviceId },
      }),
    );
  }

  async resend(challengeId: string): Promise<ApiResult<{ challengeId: string; expiresAt: string }>> {
    const r = await this.request('POST', 'auth/2fa/resend/', { body: { challenge_id: challengeId } });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: { challengeId: String(r.data?.challenge_id), expiresAt: String(r.data?.expires_at) } };
  }

  async register(data: { email: string; password: string; username?: string; language?: string }): Promise<ApiResult<LoginOutcome>> {
    const body: Record<string, unknown> = {
      email: data.email,
      password: data.password,
      language: data.language || 'Russian',
      device_id: this.store.get().deviceId,
    };
    if (data.username) body.username = data.username;
    return this.finishLogin(await this.request('POST', 'auth/register/', { body }));
  }

  async logout(): Promise<ApiResult<null>> {
    if (this.token) {
      // Токен удаляется на сервере; локально выходим в любом случае.
      await this.request('POST', 'auth/logout/', {
        auth: true,
        body: { device_id: this.device?.device_id ?? this.store.get().deviceId },
      });
    }
    this.dropSession();
    return { ok: true, data: null, status: 204 };
  }

  // ───────── профиль ─────────

  async profile(): Promise<ApiResult<AccountUser>> {
    const r = await this.request('GET', 'profile/', { auth: true });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: this.setUser(r.data.user) };
  }

  async updateProfile(patch: Record<string, unknown>): Promise<ApiResult<AccountUser>> {
    const allowed = ['username', 'avatar_access', 'info', 'date_of_birth', 'language'];
    const body: Record<string, unknown> = {};
    for (const k of allowed) if (k in patch) body[k] = patch[k];
    const r = await this.request('PATCH', 'profile/', { auth: true, body });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: this.setUser(r.data.user) };
  }

  async uploadAvatar(file: { name: string; type: string; bytes: ArrayBuffer }, avatarAccess?: string): Promise<ApiResult<AccountUser>> {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return fail('AVATAR_TYPE', 'Допустимы изображения PNG, JPEG, WebP или GIF.');
    if (file.bytes.byteLength > 5 * 1024 * 1024) return fail('AVATAR_SIZE', 'Файл слишком большой (максимум 5 МБ).');
    const form = new FormData();
    form.append('avatar', new Blob([file.bytes], { type: file.type }), path.basename(file.name) || 'avatar');
    if (avatarAccess) form.append('avatar_access', avatarAccess);
    const r = await this.request('PATCH', 'profile/', { auth: true, form });
    if (!r.ok) return r;
    this.avatarUrl = '';
    return { ok: true, status: r.status, data: this.setUser(r.data.user) };
  }

  // ───────── устройства и история ─────────

  async devices(): Promise<ApiResult<AccountDevice[]>> {
    const r = await this.request('GET', 'devices/', { auth: true });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: (r.data?.devices as AccountDevice[]) ?? [] };
  }

  async updateDevice(deviceId: string, patch: { name?: string; trusted?: boolean }): Promise<ApiResult<AccountDevice>> {
    const body: Record<string, unknown> = {};
    if (typeof patch.name === 'string') body.name = patch.name;
    if (typeof patch.trusted === 'boolean') body.trusted = patch.trusted;
    const r = await this.request('PATCH', `devices/${encodeURIComponent(deviceId)}/`, { auth: true, body });
    if (!r.ok) return r;
    const device = (r.data?.device ?? r.data) as AccountDevice;
    if (this.device && this.device.device_id === device.device_id) {
      this.device = device;
      this.store.patch({ device });
    }
    return { ok: true, status: r.status, data: device };
  }

  async deleteDevice(deviceId: string): Promise<ApiResult<null>> {
    const r = await this.request('DELETE', `devices/${encodeURIComponent(deviceId)}/`, { auth: true });
    if (!r.ok) return r;
    if (this.device?.device_id === deviceId || this.store.get().deviceId === deviceId) this.dropSession();
    return { ok: true, status: r.status, data: null };
  }

  async loginHistory(): Promise<ApiResult<LoginRecord[]>> {
    const r = await this.request('GET', 'login-history/', { auth: true });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: (r.data?.login_history as LoginRecord[]) ?? [] };
  }

  // ───────── двухфакторная аутентификация ─────────

  async twoFactor(): Promise<ApiResult<boolean>> {
    const r = await this.request('GET', '2fa/', { auth: true });
    if (!r.ok) return r;
    return { ok: true, status: r.status, data: !!r.data?.two_factor_enabled };
  }

  async setTwoFactor(enabled: boolean): Promise<ApiResult<boolean>> {
    const r = await this.request('PATCH', '2fa/', { auth: true, body: { enabled } });
    if (!r.ok) return r;
    const value = !!r.data?.two_factor_enabled;
    if (this.user) this.setUser({ ...this.user, two_factor_enabled: value });
    return { ok: true, status: r.status, data: value };
  }
}
