import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Shared by the distributable and temporary inspection pages.
export async function buildStandalone({ transformSource } = {}) {
  const plugins = transformSource ? [{ name: 'inspect-main', setup(builder) {
    builder.onLoad({ filter: /[/\\]src[/\\]main\.js$/ }, async args => ({
      contents: transformSource(await readFile(args.path, 'utf8')),
      loader: 'js', resolveDir: dirname(args.path),
    }));
  }}] : [];
  const result = await build({ entryPoints: ['src/main.js'], bundle: true, write: false, format: 'iife', minify: true,
    legalComments: 'inline', loader: { '.bin': 'binary' }, plugins });
  const template = await readFile('src/template.html', 'utf8');
  const notices = await readFile('THIRD_PARTY_NOTICES.txt', 'utf8');
  const escapeHtml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return template.replace('/* APP */', () => result.outputFiles[0].text.replaceAll('</script', '<\\/script'))
    .replace('<!-- LICENSE -->', () => escapeHtml(notices));
}
