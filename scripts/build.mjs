import { writeFile } from 'node:fs/promises';
import { buildStandalone } from './build-standalone.mjs';
await writeFile('index.html', await buildStandalone());
console.log('Built standalone index.html with third-party license');
