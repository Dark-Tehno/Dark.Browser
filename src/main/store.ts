import * as fs from 'node:fs';
import * as path from 'node:path';

/** Минимальное JSON-хранилище с отложенной атомарной записью. */
export class JsonStore<T extends object> {
  private data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string, defaults: T) {
    this.data = { ...defaults };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<T>;
      this.data = { ...defaults, ...parsed };
    } catch {
      /* файла нет или он повреждён — работаем со значениями по умолчанию */
    }
  }

  get(): T {
    return this.data;
  }

  patch(p: Partial<T>): void {
    this.data = { ...this.data, ...p };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Не удалось сохранить', this.file, e);
    }
  }
}
