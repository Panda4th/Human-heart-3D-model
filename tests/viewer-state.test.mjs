import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrossSection, fitDistance, modelSphere, pickPart, selectableIn, TapGesture, wallIds } from '../src/viewer-state.mjs';
import { createConduction, conductionDefinitions } from '../src/conduction.mjs';
import { createAnatomy, decodeAnatomy, anatomyDefinitions, anatomyFormat, interiorDefinitions } from '../src/anatomy.mjs';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
// This checks the bounding box of the four chambers only. It cannot tell whether a valve lies in a cavity
// or pierces the wall; that needs the cavity meshes, which are not in the bundle.
test('valves and papillary muscles fit within the bounding box of the four chambers; only the interior view selects them', () => {
  const wall = new THREE.Box3();
  for (const id of ['lv', 'rv', 'ra', 'la']) wall.expandByObject(parts.get(id));
  for (const [id] of interiorDefinitions) {
    const group = parts.get(id), box = new THREE.Box3().setFromObject(group);
    assert.ok(wall.containsBox(box), `${id} outside the chambers' bounding box`);
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
// Separate copy of the scene, built as in src/main.js with the interior view enabled.
// The plane keeps z <= constant (the slider's -constant), seen from the front.
function sectionScene(constant) {
  const root = new THREE.Group(), ext = new THREE.Group(), map = new Map();
  root.add(ext);
  createAnatomy(ext, map, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), constant);
  const section = createCrossSection(ext, map, plane, 0xc98478);
  section.setEnabled(true);
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(0, .06, 1).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  return { map, plane, section, camera, targets: [...map.values()] };
}
const rayAt = (camera, x, y) => { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(x, y), camera); return r; };

test('in the cross-section, a click on a valve picks the valve, not the removed front wall', () => {
  const { map, plane, section, camera, targets } = sectionScene(0);
  for (const id of ['aov', 'tv', 'pm']) {
    // Aim at the visible vertex of the part nearest the camera, behind the cut.
    const mesh = map.get(id).children[0], p = mesh.geometry.attributes.position, v = new THREE.Vector3();
    let aim = null;
    for (let i = 0; i < p.count; i++) {
      mesh.localToWorld(v.fromBufferAttribute(p, i));
      if (v.z < -.02 && (!aim || v.z > aim.z)) aim = v.clone();
    }
    const ray = new THREE.Raycaster(camera.position, aim.clone().sub(camera.position).normalize());
    assert.equal(pickPart(ray, targets, [plane], section.solids), id);
    assert.notEqual(pickPart(ray, targets, []), id, `${id}: without the plane filter the removed wall is picked`);
  }
  section.setEnabled(false);
  assert.ok(map.get('aov').visible === false && map.get('lv').children[0].visible === true);
});
test('a click on the drawn cut face of the wall picks that chamber, not the valve or vessel behind it', () => {
  // Regression for a reported bug: the cut face is drawn but was not pickable, so a click on it
  // selected whatever lay behind (e.g. the mitral valve behind the left ventricle's cut wall).
  // The expected answer does not come from pickPart's own logic: a point on the plane is wall
  // material when a ray in any other direction also crosses a non-zero net count of wall faces.
  const winding = (point, direction, solids) => {
    const inner = new THREE.Raycaster(point.clone().addScaledVector(direction, 1e-5), direction), n = new THREE.Vector3();
    return inner.intersectObjects(solids, false).reduce((sum, h) => sum + (n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(direction) > 0 ? 1 : -1), 0);
  };
  const other = new THREE.Vector3(.31, -.77, -.55).normalize();
  let flipped = 0, faces = 0;
  for (const constant of [0, -.5, .5]) {
    const { plane, section, camera, targets } = sectionScene(constant);
    for (let x = -.6; x <= .6; x += .03) for (let y = -.7; y <= .7; y += .03) {
      const ray = rayAt(camera, x, y), point = ray.ray.intersectPlane(plane, new THREE.Vector3());
      const onWall = winding(point, other, section.solids) !== 0;
      const withCut = pickPart(ray, targets, [plane], section.solids), withoutCut = pickPart(ray, targets, [plane]);
      if (onWall) {
        faces++;
        assert.ok(wallIds.includes(withCut), `plane ${constant}, pixel ${x.toFixed(2)},${y.toFixed(2)}: cut face picked ${withCut}`);
        if (!wallIds.includes(withoutCut)) flipped++;
      } else assert.equal(withCut, withoutCut, `plane ${constant}, pixel ${x.toFixed(2)},${y.toFixed(2)}: outside the wall the pick must not change`);
    }
  }
  assert.ok(faces > 300, `${faces} pixels on the cut face`);
  assert.ok(flipped > 50, `only ${flipped} pixels differ from the old pick, so the case the report describes is not covered`);
});
test('a click on the cut face names the exact chamber that contains that point, from several viewpoints and planes', () => {
  // The expected chamber is found without pickPart. The chamber walls are shells that stay open at the valve
  // openings, so one ray can escape and give a wrong "inside". Only points are used where three different rays
  // all find the point inside exactly one wall mesh and outside all the others; that mesh is the chamber.
  const directions = [[.31, -.77, -.55], [.9, .2, .1], [-.2, .5, .8]].map(d => new THREE.Vector3(...d).normalize()), n = new THREE.Vector3();
  const netOf = (point, direction, solid) => new THREE.Raycaster(point.clone().addScaledVector(direction, 1e-5), direction)
    .intersectObject(solid, false).reduce((sum, h) => sum + (n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(direction) > 0 ? 1 : -1), 0);
  const containing = (point, solidIds) => {
    const verdicts = solidIds.map(([solid, id]) => [id, directions.map(d => netOf(point, d, solid) !== 0)]);
    if (verdicts.some(([, v]) => new Set(v).size > 1)) return null;
    const inside = verdicts.filter(([, v]) => v[0]).map(([id]) => id);
    return inside.length === 1 ? inside[0] : null;
  };
  const covered = new Map(), wrong = [];
  for (const constant of [0, -.5, .5]) for (const eye of [[0, .06, 1], [.5, .2, 1], [-.5, -.1, 1]]) {
    const { map, plane, section, camera, targets } = sectionScene(constant);
    camera.position.set(...eye).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
    camera.lookAt(bounds.center); camera.updateMatrixWorld();
    const solidIds = section.solids.map(solid => [solid, wallIds.find(id => map.get(id).getObjectById(solid.id))]);
    assert.ok(solidIds.every(([, id]) => id), 'every wall mesh belongs to one of the four chambers');
    for (let x = -.6; x <= .6; x += .04) for (let y = -.7; y <= .7; y += .04) {
      const ray = rayAt(camera, x, y);
      if (plane.distanceToPoint(ray.ray.origin) >= 0) continue;
      const point = ray.ray.intersectPlane(plane, new THREE.Vector3());
      const expected = point && containing(point, solidIds);
      if (!expected) continue;
      const got = pickPart(ray, targets, [plane], section.solids);
      covered.set(expected, (covered.get(expected) || 0) + 1);
      if (got !== expected) wrong.push(`${expected}->${got}`);
    }
  }
  for (const id of wallIds) assert.ok((covered.get(id) || 0) >= 5, `${id}: only ${covered.get(id) || 0} checked points`);
  // Not exact: at about 5% of these points a left-ventricle or right-ventricle point is answered as the left atrium,
  // where the shells overlap (Issue #9). Swapping the chambers' ids gives well under half, so the bound still catches that.
  const total = [...covered.values()].reduce((a, b) => a + b, 0);
  assert.ok(wrong.length <= total * .1, `${wrong.length} of ${total} points name the wrong chamber: ${wrong.slice(0, 8)}`);
});
test('the wall meshes form a closed surface, so the cut face has no holes; vessels are open shells and get no face', () => {
  const edges = new Map();
  const count = ids => {
    edges.clear();
    for (const p of anatomy.parts.filter(q => ids.includes(q.id))) {
      const key = i => [0, 1, 2].map(k => Math.round(p.positions[i * 3 + k] * 100)).join(',');
      for (let t = 0; t < p.indices.length; t += 3) for (let k = 0; k < 3; k++) {
        const u = key(p.indices[t + k]), v = key(p.indices[t + (k + 1) % 3]), e = u < v ? `${u}|${v}` : `${v}|${u}`;
        edges.set(e, (edges.get(e) || 0) + 1);
      }
    }
    return [...edges.values()].filter(n => n % 2).length;
  };
  assert.equal(count(wallIds), 0, 'wall edges used an odd number of times');
  for (const id of ['ao', 'pa', 'vc']) assert.ok(count([id]) > 0, `${id} is expected to have open ends`);
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
test('above the aortic arch there are exactly three separate branch stubs (one on the right, two on the left), each touching the arch', () => {
  // Meaning of the check: the aorta is built from separate meshes (three from 3.0, three branches from 4.0), so
  // "connected" is a distance, not shared vertices. It does not check the branches' shape or that they are the
  // brachiocephalic, left common carotid and left subclavian arteries (the data's file names say so).
  const ao = anatomy.parts.find(p => p.id === 'ao');
  const key = i => [0, 1, 2].map(k => Math.round(ao.positions[i * 3 + k] * 100)).join(',');
  const pieces = (keep) => {
    const parent = new Map(), vertex = new Map(), find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (let t = 0; t < ao.indices.length; t += 3) {
      const tri = [0, 1, 2].map(k => ao.indices[t + k]);
      if (!tri.every(i => keep(i))) continue;
      const ks = tri.map(key);
      ks.forEach((k, i) => { if (!parent.has(k)) parent.set(k, k); vertex.set(k, tri[i]); });
      parent.set(find(ks[1]), find(ks[0])); parent.set(find(ks[2]), find(ks[0]));
    }
    const groups = new Map();
    for (const [k, i] of vertex) { const r = find(k); (groups.get(r) || groups.set(r, []).get(r)).push(i); }
    return [...groups.values()];
  };
  const x = i => ao.positions[i * 3], y = i => ao.positions[i * 3 + 1], meanX = list => list.reduce((s, i) => s + x(i), 0) / list.length;
  const stubs = pieces(i => y(i) > 1340).sort((a, b) => meanX(a) - meanX(b));
  assert.equal(stubs.length, 3, `${stubs.length} separate stubs above the arch`);
  assert.deepEqual(stubs.map(list => meanX(list) < 0), [true, false, false]);
  const all = pieces(() => true);
  for (const stub of stubs) {
    const own = all.find(list => list.includes(stub[0]) || stub.some(i => list.some(j => key(j) === key(i)))), others = all.filter(list => list !== own).flat();
    let nearest = Infinity;
    for (const i of own) for (const j of others) nearest = Math.min(nearest, Math.hypot(...[0, 1, 2].map(k => ao.positions[i * 3 + k] - ao.positions[j * 3 + k])));
    assert.ok(nearest < 3, `branch ends ${nearest.toFixed(1)} mm from the arch`);
  }
});

test('the input hash check is skipped only when ALLOW_UNVERIFIED_INPUT is exactly 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heart-input-')), a = join(dir, 'a.zip'), b = join(dir, 'b.zip');
  writeFileSync(a, 'not the recorded file'); writeFileSync(b, 'not the recorded file either');
  const run = value => spawnSync(process.execPath, ['scripts/prepare-bodyparts3d.mjs', a, b], { encoding: 'utf8', env: { ...process.env, ...(value === undefined ? {ALLOW_UNVERIFIED_INPUT: ''} : {ALLOW_UNVERIFIED_INPUT: value}) } });
  for (const value of [undefined, '0', 'false', 'yes']) assert.match(run(value).stderr, /does not match the recorded/, `value ${value}`);
  assert.doesNotMatch(run('1').stderr, /does not match the recorded/);
});
