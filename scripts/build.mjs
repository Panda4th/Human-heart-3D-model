import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({entryPoints: ['src/main.js'], bundle: true, write: false, format: 'iife', minify: true, legalComments: 'inline'});
const template = await readFile('src/template.html', 'utf8');
const notices = await readFile('THIRD_PARTY_NOTICES.txt', 'utf8');
const escapeHtml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const html = template.replace('/* APP */', () => result.outputFiles[0].text.replaceAll('</script', '<\\/script'))
  .replace('<!-- LICENSE -->', () => escapeHtml(notices));
await writeFile('index.html', html);
console.log('Built standalone index.html with third-party license');
