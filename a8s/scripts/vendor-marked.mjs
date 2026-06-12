import * as esbuild from 'esbuild';
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor/marked.js');

const polyfill = `
if (typeof Array.prototype.at !== 'function') {
  Array.prototype.at = function(n) {
    n = Math.trunc(Number(n)) || 0;
    if (n < 0) n += this.length;
    return n < 0 || n >= this.length ? void 0 : this[n];
  };
}
`.trim();

await esbuild.build({
  entryPoints: [join(root, 'node_modules/marked/lib/marked.esm.js')],
  bundle: true,
  format: 'iife',
  globalName: 'marked',
  target: 'es2017',
  platform: 'browser',
  outfile: out + '.tmp',
});

const license = readFileSync(join(root, 'node_modules/marked/lib/marked.umd.js'), 'utf8')
  .match(/^\/\*\*[\s\S]*?\*\//)?.[0] || '/** marked (MIT) https://github.com/markedjs/marked */';

const body = readFileSync(out + '.tmp', 'utf8');
writeFileSync(
  out,
  `${license}\n/* Transpiled with esbuild (ES2017) for Google Apps Script */\n${polyfill}\n${body}\n`
);
unlinkSync(out + '.tmp');

copyFileSync(join(root, 'node_modules/marked/LICENSE.md'), join(root, 'vendor/marked.LICENSE.md'));

console.log('Wrote', out);
