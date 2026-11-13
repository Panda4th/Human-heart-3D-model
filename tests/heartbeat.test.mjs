import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createAnatomy, modelScale } from '../src/anatomy.mjs';
import { createConduction } from '../src/conduction.mjs';
import { createCrossSection, cutColor } from '../src/viewer-state.mjs';
import { contraction, createBeat, cycle, isovolumic, period, phaseAt, phases, valvesAt } from '../src/heartbeat.mjs';

// Same structure as src/main.js: the beat is created after the cross-section and the conduction overlay.
const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
heart.add(exterior);
const meta = createAnatomy(exterior, parts, readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)), modelScale);
createCrossSection(exterior, parts, new THREE.Plane(new THREE.Vector3(0, 0, -1), .6), cutColor);
exterior.add(conduction);
createConduction(conduction, parts, meta.conduction);
const meshOf = id => parts.get(id).children.find(o => o.isMesh);
// The BodyParts3D parts; the conduction overlay is checked through its AV node below.
const rest = new Map([...parts].filter(([, g]) => g.userData.kind !== 'conduction').map(([id]) => [id, Float32Array.from(meshOf(id).geometry.attributes.position.array)]));
const beat = createBeat(exterior, parts);
const atrialPeak = { atria: 1, ventricles: 0 }, ventricularPeak = { atria: 0, ventricles: 1 };
const moved = id => {
  const a = rest.get(id), b = meshOf(id).geometry.attributes.position.array, out = [];
  for (let i = 0; i < a.length; i += 3) out.push(Math.hypot(b[i] - a[i], b[i + 1] - a[i + 1], b[i + 2] - a[i + 2]));
  return out;
};
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

test('the cycle follows OpenStax 19.3: atria, then ventricles, then ventricular relaxation, 800 ms in all', () => {
  assert.deepEqual(cycle, { atrialSystole: 100, ventricularSystole: 270, ventricularDiastole: 430 });
  assert.equal(period, 800);
  assert.deepEqual([0, 99, 100, 369, 370, 799, 800].map(phaseAt), [0, 0, 1, 1, 2, 2, 0]);
  assert.equal(phases.length, 3);
  // Atria contract only in atrial systole; ventricles are at rest then, most contracted at the end of their systole.
  assert.deepEqual(contraction(0), { atria: 0, ventricles: 0 });
  assert.ok(contraction(50).atria > .99 && contraction(50).ventricles === 0);
  assert.ok(contraction(370).ventricles > .99 && contraction(370).atria === 0);
  assert.equal(contraction(799).ventricles, 0);
  for (let t = 0; t < 1600; t += 7) {
    const s = contraction(t);
    assert.ok(s.atria >= 0 && s.atria <= 1 && s.ventricles >= 0 && s.ventricles <= 1);
    assert.ok(Math.abs(contraction(t + 1).ventricles - s.ventricles) < .02, 'no jumps between frames');
  }
});

test('the valves follow OpenStax 19.3: atrioventricular open in atrial systole and late diastole, arterial only in the ejection', () => {
  // The source gives the order, not the length of the two isovolumic periods; 50 and 80 ms are display values (heartbeat.mjs).
  assert.deepEqual(isovolumic, { contraction: 50, relaxation: 80 });
  const open = ms => { const v = valvesAt(ms); return `${v.atrioventricular ? 'AV' : '--'}/${v.arterial ? 'SL' : '--'}`; };
  assert.deepEqual([0, 99, 100, 149, 150, 369, 370, 449, 450, 799, 800, -1].map(open),
    ['AV/--', 'AV/--', '--/--', '--/--', '--/SL', '--/SL', '--/--', '--/--', 'AV/--', 'AV/--', 'AV/--', 'AV/--']);
  for (let t = 0; t < period; t++) { const v = valvesAt(t); assert.ok(!(v.atrioventricular && v.arterial), `both open at ${t} ms`); }
  // Atrial systole: atrioventricular valves open, arterial valves closed (the phase text says the same).
  assert.equal(valvesAt(50).atrioventricular, true);
  assert.equal(valvesAt(50).arterial, false);
  assert.equal(valvesAt(1600 + 200).arterial, true, 'periodic');
});

test('each phase contracts its own chambers more than the others, by a few millimetres', () => {
  beat.set(atrialPeak);
  const atrial = Object.fromEntries(['lv', 'rv', 'ra', 'la'].map(id => [id, mean(moved(id))]));
  beat.set(ventricularPeak);
  const ventricular = Object.fromEntries(['lv', 'rv', 'ra', 'la'].map(id => [id, mean(moved(id))]));
  for (const id of ['ra', 'la']) assert.ok(atrial[id] > 2 * Math.max(atrial.lv, atrial.rv), `${id} ${JSON.stringify(atrial)}`);
  for (const id of ['lv', 'rv']) assert.ok(ventricular[id] > 2 * Math.max(ventricular.ra, ventricular.la), `${id} ${JSON.stringify(ventricular)}`);
  for (const id of parts.keys()) if (rest.has(id)) assert.ok(Math.max(...moved(id)) < 7, `${id} moves at most a few millimetres`);
  beat.set({ atria: 0, ventricles: 0 });
});

test('the surface does not tear or fold: shared wall points stay together and no triangle turns over', () => {
  // The wall is one shell split between the chambers, so the chambers share border points.
  const key = (a, i) => `${a[i].toFixed(2)},${a[i + 1].toFixed(2)},${a[i + 2].toFixed(2)}`;
  const shared = [];
  const index = new Map();
  for (const id of ['lv', 'rv', 'ra', 'la']) {
    const a = rest.get(id);
    for (let i = 0; i < a.length; i += 3) {
      const other = index.get(key(a, i));
      if (other && other[0] !== id) shared.push([other, [id, i]]);
      else index.set(key(a, i), [id, i]);
    }
  }
  assert.ok(shared.length > 100, `border points found: ${shared.length}`);
  for (const state of [atrialPeak, ventricularPeak]) {
    beat.set(state);
    for (const [[a, i], [b, j]] of shared) {
      const p = meshOf(a).geometry.attributes.position.array, q = meshOf(b).geometry.attributes.position.array;
      assert.ok(Math.hypot(p[i] - q[j], p[i + 1] - q[j + 1], p[i + 2] - q[j + 2]) < .02);
    }
    let turned = 0;
    for (const [id, a] of rest) {
      const geometry = meshOf(id).geometry, b = geometry.attributes.position.array, ix = geometry.index.array;
      const normal = (v, t) => {
        const [i, j, k] = [ix[t], ix[t + 1], ix[t + 2]].map(n => new THREE.Vector3(v[3 * n], v[3 * n + 1], v[3 * n + 2]));
        return j.sub(i).cross(k.sub(i));
      };
      for (let t = 0; t < ix.length; t += 3) {
        // A sliver whose three corners are almost on one line (height under 2% of its longest side) has no stable
        // facing: the source data has a few (tricuspid valve, pulmonary veins), and a sub-millimetre shift turns them.
        const n = normal(a, t), longest = Math.max(...[[0, 1], [1, 2], [2, 0]].map(([x, y]) => {
          const p = ix[t + x], q = ix[t + y];
          return Math.hypot(a[3 * p] - a[3 * q], a[3 * p + 1] - a[3 * q + 1], a[3 * p + 2] - a[3 * q + 2]);
        }));
        if (n.length() / longest < .02 * longest) continue;
        if (n.dot(normal(b, t)) <= 0) turned++;
      }
    }
    assert.equal(turned, 0);
  }
  beat.set({ atria: 0, ventricles: 0 });
});

test('the cut-face copies share the deformed geometry, the rest shape comes back, and labels follow', () => {
  beat.set(ventricularPeak);
  const geometry = meshOf('lv').geometry;
  const copies = [];
  exterior.traverse(o => { if (o.isMesh && o.geometry === geometry) copies.push(o); });
  assert.ok(copies.length >= 3, 'original, cross-section copy and stencil counters');
  const anchor = meta.conduction.nodes.av, displaced = beat.displace(anchor);
  assert.ok(Math.hypot(...displaced.map((v, i) => v - anchor[i])) > .1, 'the AV node label moves with the beat');
  const av = parts.get('av').children[0];
  assert.ok(av.position.distanceTo(new THREE.Vector3(...displaced)) < 1e-6, 'the AV node mesh moves to the same place');
  beat.set({ atria: 0, ventricles: 0 });
  for (const [id, a] of rest) assert.deepEqual(meshOf(id).geometry.attributes.position.array, a, `${id} back to rest`);
  assert.deepEqual(beat.displace(anchor), anchor);
});

// src/main.js decides whether the cut leaves anything of a part from a box that is the union of the rest shape and the two
// most contracted shapes. That is exact only if no moment of the beat reaches outside that union.
test('the box of every part over the beat stays inside the union of the rest shape and the two contracted shapes', () => {
  const boxOf = group => new THREE.Box3().setFromObject(group, true);
  const union = new Map();
  for (const state of [{ atria: 0, ventricles: 0 }, atrialPeak, ventricularPeak]) {
    beat.set(state);
    for (const [id, group] of parts) union.has(id) ? union.get(id).union(boxOf(group)) : union.set(id, boxOf(group));
  }
  let widened = 0;
  const eps = 1e-6;
  for (let t = 0; t < period; t += 10) {
    beat.set(contraction(t));
    for (const [id, group] of parts) {
      const b = boxOf(group), u = union.get(id);
      assert.ok(b.min.x >= u.min.x - eps && b.min.y >= u.min.y - eps && b.min.z >= u.min.z - eps
        && b.max.x <= u.max.x + eps && b.max.y <= u.max.y + eps && b.max.z <= u.max.z + eps, `${id} at ${t} ms`);
    }
  }
  beat.set({ atria: 0, ventricles: 0 });
  for (const [id, group] of parts) if (union.get(id).min.z < boxOf(group).min.z - 1e-4) widened++;
  assert.ok(widened > 0, 'at least one part reaches further back than at rest');
});
