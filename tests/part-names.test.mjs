// Issue #50 G8: renaming a part changed its button and heading (they read the definition), but nothing noticed the old name left in
// the other parts' descriptions, the screen text (template.html) or the README. A changed name fails this test. When you rename a
// part on purpose, search the definitions, src/template.html, src/main.js and README.md for the old name, then update the list here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anatomyDefinitions, interiorDefinitions } from '../src/anatomy.mjs';
import { conductionDefinitions } from '../src/conduction.mjs';

const definitions = [...anatomyDefinitions, ...interiorDefinitions, ...conductionDefinitions];

test('the part names are the ones the texts were written for', () => {
  assert.deepEqual(definitions.map(([id, name]) => `${id}:${name}`), [
    'lv:左心室', 'rv:右心室', 'ra:右心房', 'la:左心房', 'ao:大動脈', 'pa:肺動脈', 'vc:大静脈', 'pv:肺静脈', 'ca:冠動脈', 'cv:冠静脈',
    'mv:僧帽弁', 'tv:三尖弁', 'aov:大動脈弁', 'pov:肺動脈弁', 'pm:乳頭筋',
    'sa:洞房結節', 'atria:心房への広がり', 'av:房室結節', 'his:ヒス束（近位区間）', 'bhis:ヒス束（分岐区間）', 'rbb:右脚', 'lbb:左脚', 'purkinje:プルキンエ線維',
  ]);
});

test('every part has its own name, and the screen text and the descriptions write no part name the definitions do not have', () => {
  const names = definitions.map(([, name]) => name);
  assert.equal(new Set(names).size, names.length);
  // Names of the flow routes in main.js are vessels, not parts, and are left out here. Only names written the way parts are named
  // (ending in 心室, 心房, 動脈, 静脈, 弁) are checked, so that a renamed part leaves no button-like name behind in the page.
  const page = readFileSync(new URL('../src/template.html', import.meta.url), 'utf8') + definitions.map(([, , , text]) => text).join('');
  const partLike = new Set(page.match(/[左右]心[室房]|[大肺冠](?:動|静)脈|(?:僧帽|三尖|大動脈|肺動脈)弁/g));
  for (const name of partLike) assert.ok(names.some(n => n.includes(name)), `${name} in template.html or a description is not a part name`);
});
