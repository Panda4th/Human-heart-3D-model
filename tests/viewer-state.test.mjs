import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrossSection, fitDistance, modelSphere, pickPart, selectableIn, TapGesture } from '../src/viewer-state.mjs';
import { createConduction, conductionDefinitions } from '../src/conduction.mjs';
import { createAnatomy, decodeAnatomy, anatomyDefinitions, anatomyFormat, interiorDefinitions } from '../src/anatomy.mjs';
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

const bundle = readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url));
// Same structure as src/main.js.
const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
heart.add(exterior);
const meta = createAnatomy(exterior, parts, bundle, .033);
exterior.add(conduction);
createConduction(conduction, parts, meta.conduction);
const bounds = modelSphere(heart);

test('model geometry is finite and each selectable group has geometry', () => {
  assert.equal(parts.size, anatomyDefinitions.length + interiorDefinitions.length + conductionDefinitions.length);
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
test('framing sphere is tight around the model, not the bounding box', () => {
  const boxSphere = new THREE.Box3().setFromObject(heart).getBoundingSphere(new THREE.Sphere());
  assert.ok(bounds.radius < boxSphere.radius * .85, `${bounds.radius} vs ${boxSphere.radius}`);
});
test('standalone HTML includes license and has no external runtime resources', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('Permission is hereby granted, free of charge'));
  assert.ok(html.includes('THE SOFTWARE IS PROVIDED'));
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref\s*=/i);
  assert.ok(!html.includes('/* APP */'));
});

const anatomy = decodeAnatomy(bundle);
test('BodyParts3D bundle has every defined part with valid geometry', () => {
  assert.deepEqual(anatomy.parts.map(p => p.id), [...anatomyDefinitions, ...interiorDefinitions].map(d => d[0]));
  for (const p of anatomy.parts) {
    assert.ok(p.indices.length > 0 && p.indices.length % 3 === 0, p.id);
    assert.ok(p.positions.every(Number.isFinite), p.id);
    assert.ok(p.indices.every(i => i < p.positions.length / 3), p.id);
  }
});
test('valves and papillary muscles sit inside the heart wall and only the interior view selects them', () => {
  const wall = new THREE.Box3();
  for (const id of ['lv', 'rv', 'ra', 'la']) wall.expandByObject(parts.get(id));
  for (const [id] of interiorDefinitions) {
    const group = parts.get(id), box = new THREE.Box3().setFromObject(group);
    assert.ok(wall.containsBox(box), `${id} outside the heart wall`);
    assert.deepEqual(group.userData.modes, ['interior']);
  }
  for (const id of ['lv', 'rv', 'ra', 'la']) assert.deepEqual(parts.get(id).userData.modes, ['exterior', 'interior']);
  assert.deepEqual(parts.get('ao').userData.modes, ['exterior']);
});
test('the conduction overlay makes conduction selectable only on the cross-section', () => {
  const sa = parts.get('sa').userData, mv = parts.get('mv').userData, ao = parts.get('ao').userData;
  for (const overlay of [false, true]) {
    assert.equal(selectableIn(sa, 'conduction', overlay), true);
    assert.equal(selectableIn(sa, 'exterior', overlay), false);
    assert.equal(selectableIn(mv, 'interior', overlay), true);
    assert.equal(selectableIn(ao, 'interior', overlay), false);
  }
  assert.equal(selectableIn(sa, 'interior', false), false);
  assert.equal(selectableIn(sa, 'interior', true), true);
});
test('in the cross-section, a click on a valve picks the valve, not the removed front wall', () => {
  // Separate copy of the scene, built as in src/main.js with the interior view enabled.
  const root = new THREE.Group(), ext = new THREE.Group(), map = new Map();
  root.add(ext);
  createAnatomy(ext, map, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0); // keeps z <= 0, as the slider at its middle
  const section = createCrossSection(ext, map, plane, 0xc98478);
  section.setEnabled(true);
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(0, .06, 1).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  const targets = [...map.values()];
  for (const id of ['aov', 'tv', 'pm']) {
    // Aim at the visible vertex of the part nearest the camera, behind the cut.
    const mesh = map.get(id).children[0], p = mesh.geometry.attributes.position, v = new THREE.Vector3();
    let aim = null;
    for (let i = 0; i < p.count; i++) {
      mesh.localToWorld(v.fromBufferAttribute(p, i));
      if (v.z < -.02 && (!aim || v.z > aim.z)) aim = v.clone();
    }
    const ray = new THREE.Raycaster(camera.position, aim.clone().sub(camera.position).normalize());
    assert.equal(pickPart(ray, targets, [plane]), id);
    assert.notEqual(pickPart(ray, targets, []), id, `${id}: without the plane filter the removed wall is picked`);
  }
  section.setEnabled(false);
  assert.ok(map.get('aov').visible === false && map.get('lv').children[0].visible === true);
});
test('bundle format is checked', () => {
  assert.equal(decodeAnatomy(bundle).meta.format, anatomyFormat);
  const copy = new Uint8Array(bundle), text = new TextDecoder().decode(copy.subarray(8, 8 + new DataView(copy.buffer, copy.byteOffset).getUint32(4, true)));
  const at = 8 + text.indexOf(`"format":${anatomyFormat}`) + '"format":'.length;
  copy[at] = 0x32; // "2"
  assert.throws(() => decodeAnatomy(copy), /format 2/);
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
test('conduction overlay sits on the matching heart walls', () => {
  // Regression check of the generator, not of anatomy: the wall is split by the nearest cavity and
  // the paths are snapped to cavities, so this catches swapped or misplaced cavities only.
  const walls = anatomy.parts.filter(p => ['lv', 'rv', 'ra', 'la', 'vc'].includes(p.id));
  const nearestWall = q => {
    let best = [Infinity, ''];
    for (const p of walls) for (let i = 0; i < p.positions.length; i += 3) {
      const d = (p.positions[i] - q[0]) ** 2 + (p.positions[i + 1] - q[1]) ** 2 + (p.positions[i + 2] - q[2]) ** 2;
      if (d < best[0]) best = [d, p.id];
    }
    return { id: best[1], distance: Math.sqrt(best[0]) };
  };
  const { nodes, paths } = anatomy.meta.conduction;
  const sa = nearestWall(nodes.sa);
  assert.ok(['ra', 'vc'].includes(sa.id) && sa.distance < 5, `SA node near ${sa.id} at ${sa.distance} mm`);
  for (const list of Object.values(paths)) for (const line of list) for (const p of line) {
    assert.ok(nearestWall(p).distance < 12, `point ${p} is ${nearestWall(p).distance} mm from the wall`);
  }
  const share = (line, id) => line.filter(p => nearestWall(p).id === id).length / line.length;
  assert.ok(share(paths.branches[0], 'lv') > .8, 'left bundle branch on the left ventricle');
  assert.ok(share(paths.branches[1], 'rv') > .7, 'right bundle branch on the right ventricle');
  for (const line of paths.purkinje.slice(0, 2)) assert.ok(share(line, 'lv') > .8);
  for (const line of paths.purkinje.slice(2)) assert.ok(share(line, 'rv') > .8);
});
test('aortic arch keeps all three branches, including the brachiocephalic trunk', () => {
  // The brachiocephalic trunk is the only aortic part above the arch on the patient's right.
  const ao = anatomy.parts.find(p => p.id === 'ao').positions;
  let right = 0;
  for (let i = 0; i < ao.length; i += 3) if (ao[i] < -10 && ao[i + 1] > 1330) right++;
  assert.ok(right > 20, `${right} aorta vertices right of the arch`);
});
