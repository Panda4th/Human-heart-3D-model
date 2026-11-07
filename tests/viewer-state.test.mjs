import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitDistance, TapGesture } from '../src/viewer-state.mjs';
import { createExterior } from '../src/model.mjs';
import { createConduction } from '../src/conduction.mjs';
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
