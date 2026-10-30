// Копирует статику (html, css, svg, png) из src в dist, сохраняя структуру.
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const EXT = new Set(['.html', '.css', '.svg', '.png']);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (EXT.has(extname(name))) {
      const out = join(dist, relative(src, full));
      mkdirSync(dirname(out), { recursive: true });
      cpSync(full, out);
    }
  }
}
walk(src);
console.log('static copied');
