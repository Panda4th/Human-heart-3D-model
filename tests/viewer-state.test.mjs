import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitDistance, TapGesture } from '../src/viewer-state.mjs';
import { createExterior } from '../src/model.mjs';
import { createConduction } from '../src/conduction.mjs';
import { decodeAnatomy, anatomyDefinitions } from '../src/anatomy.mjs';
import { readFileSync } from 'node:fs';

test('tap selects, but drag out-and-back, pinch, cancel and mismatched pointer do not', () => {
  const g = new TapGesture();
  g.down(1, 0, 0); assert.equal(g.up(1, 3, 0), true);
  g.down(1, 0, 0); g.move(1, 20, 0); g.move(1, 0, 0); assert.equal(g.up(1, 0, 0), false);
  g.down(1, 0, 0); g.down(2, 20, 0); assert.equal(g.up(2, 20, 0), false); assert.equal(g.up(1, 0, 0), false);
  g.down(1, 0, 0); g.cancel(1); assert.equal(g.up(1, 0, 0), false);
  g.down(1, 0, 0); assert.equal(g.up(2, 0, 0), false); g.cancel(1);
  g.down(3, 10, 10); assert.equal(g.up(3, 10, 10), true);
});

const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
heart.add(exterior, conduction); heart.rotation.z = -.13;
createExterior(exterior, parts); createConduction(conduction, parts);
const bounds = new THREE.Box3().setFromObject(heart).getBoundingSphere(new THREE.Sphere());

test('model geometry is finite and each selectable group has geometry', () => {
  assert.equal(parts.size, 14);
  for (const group of parts.values()) {
    assert.ok(group.children.length > 0);
    group.traverse(o => {
      if (o.geometry) assert.ok([...o.geometry.attributes.position.array].every(Number.isFinite));
    });
  }
});
for (const aspect of [.5, .8, 1, 1.6, 2.4]) test(`all model vertices fit reset views at aspect ${aspect}`, () => {
  for (const dir of [[0,.06,1], [0,.06,-1], [1,.06,0]]) {
    const camera = new THREE.PerspectiveCamera(36, aspect, .1, 150);
    camera.position.copy(bounds.center).add(new THREE.Vector3(...dir).normalize().multiplyScalar(fitDistance(bounds.radius, aspect)));
    camera.lookAt(bounds.center); camera.updateMatrixWorld();
    heart.traverse(o => {
      const positions = o.geometry?.attributes.position;
      if (!positions) return;
      for (let i = 0; i < positions.count; i++) {
        const p = o.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, i)).project(camera);
        assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && Math.abs(p.z) < 1, `clipped vertex in ${o.parent.userData.id}`);
      }
    });
  }
});
test('standalone HTML includes license and has no external runtime resources', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('Permission is hereby granted, free of charge'));
  assert.ok(html.includes('THE SOFTWARE IS PROVIDED'));
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref\s*=/i);
  assert.ok(!html.includes('/* APP */'));
});

const anatomy = decodeAnatomy(readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)));
test('BodyParts3D bundle has every defined part with valid geometry', () => {
  assert.deepEqual(anatomy.parts.map(p => p.id), anatomyDefinitions.map(d => d[0]));
  for (const p of anatomy.parts) {
    assert.ok(p.indices.length > 0 && p.indices.length % 3 === 0, p.id);
    assert.ok(p.positions.every(Number.isFinite), p.id);
    assert.ok(p.indices.every(i => i < p.positions.length / 3), p.id);
  }
});
test('BodyParts3D heart wall has a plausible size and coronary vessels lie on it', () => {
  const wall = anatomy.parts.filter(p => ['lv', 'rv', 'ra', 'la'].includes(p.id)).flatMap(p => [...p.positions]);
  for (const axis of [0, 1, 2]) {
    const values = wall.filter((_, i) => i % 3 === axis);
    const size = Math.max(...values) - Math.min(...values);
    assert.ok(size > 80 && size < 150, `wall size ${size} mm on axis ${axis}`);
  }
  // 3.0 and 4.0 meshes are offset by 10 mm; a missing correction leaves vessels off the surface.
  const coronary = anatomy.parts.find(p => p.id === 'ca').positions;
  let near = 0, samples = 0;
  for (let i = 0; i < coronary.length; i += 30) {
    let best = Infinity;
    for (let j = 0; j < wall.length; j += 3) best = Math.min(best, (wall[j] - coronary[i]) ** 2 + (wall[j + 1] - coronary[i + 1]) ** 2 + (wall[j + 2] - coronary[i + 2]) ** 2);
    samples++; if (best < 25) near++;
  }
  assert.ok(near / samples > .9, `${near}/${samples} coronary samples within 5 mm of the wall`);
});
