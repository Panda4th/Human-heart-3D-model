// Issue #50 G8: renaming a part changes its button and heading (they read the definition), but the old name can stay in the other
// parts' descriptions and in the screen text written elsewhere (template.html, the phase text in heartbeat.mjs, the impulse text in
// conduction-timing.mjs, the flow note in main.js). Nothing can find an old name it was never told, so a rename goes like this:
//   1. The first test fails, and its message lists the files under src/ that still write the old name.
//   2. Fix those, then add the old name to formerNames below and the new name to the list in the first test.
//   3. The second test keeps failing while the old name is written anywhere under src/.
// Dated records (README sections with a date, docs/) may keep an old name: they describe the page as it was. Review of PR #54 (M1):
// the first version of this test looked for part-like words with a pattern and missed the valves, the papillary muscles and the
// conduction parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { anatomyDefinitions, interiorDefinitions } from '../src/anatomy.mjs';
import { conductionDefinitions } from '../src/conduction.mjs';

const definitions = [...anatomyDefinitions, ...interiorDefinitions, ...conductionDefinitions];
const names = definitions.map(([, name]) => name);

// Names parts had before (none yet). See the steps above.
const formerNames = [];

const srcDir = new URL('../src/', import.meta.url);
const sources = readdirSync(srcDir).filter(f => /\.(mjs|js|html)$/.test(f)).map(f => [`src/${f}`, readFileSync(new URL(f, srcDir), 'utf8')]);
// Files that write `name` other than as a part of a longer current name (an old "大動脈" must not be found in "大動脈弁").
function filesWriting(name) {
  const longer = names.filter(n => n !== name && n.includes(name));
  return sources.filter(([, text]) => longer.reduce((t, n) => t.replaceAll(n, ''), text).includes(name)).map(([file]) => file);
}

test('the part names are the ones the texts were written for', () => {
  const expected = [
    'lv:左心室', 'rv:右心室', 'ra:右心房', 'la:左心房', 'ao:大動脈', 'pa:肺動脈', 'vc:大静脈', 'pv:肺静脈', 'ca:冠動脈', 'cv:冠静脈',
    'mv:僧帽弁', 'tv:三尖弁', 'aov:大動脈弁', 'pov:肺動脈弁', 'pm:乳頭筋',
    'sa:洞房結節', 'atria:心房への広がり', 'av:房室結節', 'his:ヒス束（近位区間）', 'bhis:ヒス束（分岐区間）', 'rbb:右脚', 'lbb:左脚', 'purkinje:プルキンエ線維',
  ];
  const actual = definitions.map(([id, name]) => `${id}:${name}`);
  const changed = expected.filter(entry => !actual.includes(entry)).map(entry => {
    const old = entry.slice(entry.indexOf(':') + 1);
    return `${entry} (the old name is still written in: ${filesWriting(old).join(', ') || 'no file under src/'})`;
  });
  assert.deepEqual(actual, expected, changed.length ? `renamed or removed: ${changed.join('; ')}` : undefined);
});

test('no former part name is still written under src/', () => {
  assert.equal(new Set(names).size, names.length, 'two parts have the same name');
  for (const old of formerNames) {
    assert.ok(!names.includes(old), `${old} is in formerNames but is a part name again`);
    const files = filesWriting(old);
    assert.deepEqual(files, [], `the former name ${old} is still written in: ${files.join(', ')}`);
  }
});
