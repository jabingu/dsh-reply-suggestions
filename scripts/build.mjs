import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await mkdir(new URL('lib/', root), { recursive: true });
for (const name of ['common.mjs', 'engine.mjs', 'index.mjs', 'usage.mjs', 'pricing.mjs', 'price-updates.mjs', 'billing-calendar.mjs']) await copyFile(new URL(`src/${name}`, root), new URL(`lib/${name}`, root));
const common = (await readFile(new URL('src/common.mjs', root), 'utf8')).replace(/^export /gm, '');
const client = await readFile(new URL('src/client.cjs', root), 'utf8');
const bundle = `window.__ModuleLoader__.load({id:'dsh-reply-suggestions',factory:function(require){\n'use strict';\nvar module={exports:{}};var exports=module.exports;\n${common}\n${client}\nreturn module.exports;\n}});\n`;
await writeFile(new URL('lib/client.js', root), bundle);
console.log('Built host entry and desktop/web client bundle without installing build dependencies.');
