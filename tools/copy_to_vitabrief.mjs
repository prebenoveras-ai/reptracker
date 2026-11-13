// Copies docs/engine.js into VitaBrief's index.html (the block between "const RepEngine = (() => {"
// and its closing "})();"). VitaBrief never edits that block by hand.
// Usage: node tools/copy_to_vitabrief.mjs [path to VitaBrief/index.html] [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const target = args[0] || path.resolve(here, '../../VitaBrief/index.html');
const check = process.argv.includes('--check');
const src = fs.readFileSync(path.resolve(here, '../docs/engine.js'), 'utf8').replace(/\r\n/g, '\n');
const names = [...src.matchAll(/^export (?:const|function|class) (\w+)/gm)].map(m => m[1]);
const body = src.replace(/^export /gm, '').replace(/\s+$/, '');
let html = fs.readFileSync(target, 'utf8');
const crlf = html.includes('\r\n');
if (crlf) html = html.replace(/\r\n/g, '\n');
const open = 'const RepEngine = (() => {\n';
const a = html.indexOf(open);
const m = a < 0 ? null : /\nreturn \{[^}]*\};\n\}\)\(\);\n/.exec(html.slice(a));
if (a < 0 || !m) { console.error('RepEngine block not found in ' + target); process.exit(1); }
const b = a + m.index + m[0].length;
const block = open + body + '\nreturn { ' + names.join(', ') + ' };\n})();\n';
if (/[^\x00-\x7F]/.test(block)) { console.error('engine.js has non-ASCII characters; VitaBrief needs ASCII'); process.exit(1); }
const same = html.slice(a, b) === block;
if (check) { console.log(same ? 'VitaBrief engine is up to date' : 'VitaBrief engine DIFFERS from docs/engine.js'); process.exit(same ? 0 : 1); }
if (same) { console.log('already up to date'); process.exit(0); }
html = html.slice(0, a) + block + html.slice(b);
fs.writeFileSync(target, crlf ? html.replace(/\n/g, '\r\n') : html);
console.log('copied engine (' + names.length + ' exports, ' + block.split('\n').length + ' lines) into ' + target);
