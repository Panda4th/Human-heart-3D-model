import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrossSection, fitDistance, modelSphere, pickHit, pickPart, removedByCut, selectableIn, TapGesture, wallIds } from '../src/viewer-state.mjs';
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
  // Format 6 also carries the four cavities, which are not drawn (tests/flow.test.mjs checks the blood-flow routes against them).
  assert.deepEqual(anatomy.parts.map(p => p.id), [...[...anatomyDefinitions, ...interiorDefinitions].map(d => d[0]), 'cavlv', 'cavrv', 'cavra', 'cavla']);
  for (const p of anatomy.parts) {
    assert.ok(p.indices.length > 0 && p.indices.length % 3 === 0, p.id);
    assert.ok(p.positions.every(Number.isFinite), p.id);
    assert.ok(p.indices.every(i => i < p.positions.length / 3), p.id);
  }
});
// This checks the bounding box of the four chambers only. It cannot tell whether a valve lies in a cavity
// or pierces the wall; that needs the cavity meshes, which are in the bundle from format 6 but are not used here.
test('valves and papillary muscles fit within the bounding box of the four chambers; only the interior view selects them', () => {
  const wall = new THREE.Box3();
  for (const id of ['lv', 'rv', 'ra', 'la']) wall.expandByObject(parts.get(id));
  for (const [id] of interiorDefinitions) {
    const group = parts.get(id), box = new THREE.Box3().setFromObject(group);
    assert.ok(wall.containsBox(box), `${id} outside the chambers' bounding box`);
    assert.deepEqual(group.userData.modes, ['interior']);
  }
  for (const id of ['lv', 'rv', 'ra', 'la']) assert.deepEqual(parts.get(id).userData.modes, ['exterior', 'interior', 'flow']);
  assert.deepEqual(parts.get('ao').userData.modes, ['exterior', 'flow']);
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
test('regression: a click on the cut face names the chamber a three-ray reference also names, at 90% or better (not exact, and not anatomical truth)', () => {
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
  // The reference is one way of deciding, not the true chamber. Not exact: at about 5% of these points a left-ventricle or right-ventricle point is answered as the left atrium,
  // where the shells overlap (Issue #9). Swapping the chambers' ids gives well under half, so the bound still catches that.
  const total = [...covered.values()].reduce((a, b) => a + b, 0);
  assert.ok(wrong.length <= total * .1, `${wrong.length} of ${total} points name the wrong chamber: ${wrong.slice(0, 8)}`);
});
test('the wall meshes have no boundary edges (every edge is used an even number of times); vessels are open shells and get no face', () => {
  // Even use only rules out open boundaries. It does not show that the wall is a clean solid: see the next test.
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
test('the aorta has no flat caps left inside it where its shells meet (Issue #17, item 1)', () => {
  // The aorta is separate shells, each closed by a cap. Left in place, the caps and the gap between the rims showed as a dark
  // line and a step. Caps lie at about y 1302 (mm) and face up or down; the tube wall there faces sideways. The strip that joins
  // the rims is also nearly flat but only a fraction of a mm wide. Measured 2026-11-07: 1735 mm2 of such triangles before the
  // fix (the caps), 47 mm2 after (the strips). The bound sits between the two.
  const p = anatomy.parts.find(q => q.id === 'ao'), at = (i, k) => p.positions[i * 3 + k];
  let flat = 0;
  for (let t = 0; t < p.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map(k => p.indices[t + k]);
    if (![a, b, c].every(i => at(i, 1) > 1299 && at(i, 1) < 1306)) continue;
    const u = [0, 1, 2].map(k => at(b, k) - at(a, k)), w = [0, 1, 2].map(k => at(c, k) - at(a, k));
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (Math.abs(n[1]) / Math.hypot(...n) > .7) flat += Math.hypot(...n) / 2;
  }
  assert.ok(flat < 300, `${flat.toFixed(0)} mm2 of up/down-facing triangles between y 1299 and 1306`);
});
test('wall duplicate triangles and edges shared by four or more triangles do not grow (Issue #9, item on wall mesh quality)', () => {
  // Measured on 2026-11-07: of 457 duplicated triangles in the four chamber walls, 456 are a pair with opposite winding
  // (a zero-thickness double sheet). They come from simplification: none of the 457 is among the 1335 duplicates of the
  // source mesh, all of which simplification removed. Edges used by 4 or more triangles rose from 354 to 711.
  // Whether they show on screen is not settled. These bounds only stop the numbers from growing unnoticed.
  const triangles = new Map(), edges = new Map();
  for (const p of anatomy.parts.filter(q => wallIds.includes(q.id))) {
    const key = i => [0, 1, 2].map(k => Math.round(p.positions[i * 3 + k] * 100)).join(',');
    for (let t = 0; t < p.indices.length; t += 3) {
      const v = [0, 1, 2].map(k => key(p.indices[t + k]));
      const tri = [...v].sort().join('|'); triangles.set(tri, (triangles.get(tri) || 0) + 1);
      for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3], e = a < b ? `${a}|${b}` : `${b}|${a}`; edges.set(e, (edges.get(e) || 0) + 1); }
    }
  }
  const duplicated = [...triangles.values()].filter(n => n > 1).length, crowded = [...edges.values()].filter(n => n >= 4).length;
  assert.ok(duplicated <= 460, `${duplicated} duplicated triangles (measured 457)`);
  assert.ok(crowded <= 720, `${crowded} edges used by 4 or more triangles (measured 711)`);
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
test('regression only, not anatomical validation: conduction overlay sits on the matching heart walls', () => {
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
  for (const line of paths.leftFascicles) assert.ok(share(line, 'lv') > .8, 'left directional route stays on the left ventricle');
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
  // Empty files: with the check skipped, reading the zip fails at once, so the script never reaches its output step.
  writeFileSync(a, ''); writeFileSync(b, '');
  const run = value => {
    const env = { ...process.env };
    if (value === undefined) delete env.ALLOW_UNVERIFIED_INPUT; else env.ALLOW_UNVERIFIED_INPUT = value;
    return spawnSync(process.execPath, ['scripts/prepare-bodyparts3d.mjs', a, b], { encoding: 'utf8', env });
  };
  for (const value of [undefined, '', '0', 'false', 'yes']) assert.match(run(value).stderr, /does not match the recorded/, `value ${value}`);
  const skipped = run('1');
  assert.doesNotMatch(skipped.stderr, /does not match the recorded/);
  assert.notEqual(skipped.status, 0, 'empty input must still fail after the check is skipped');
});

test('the cross-section slider reaches both ends of the four chambers', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const [, min, max] = /id="cut-depth" type="range" min="(-?[\d.]+)" max="(-?[\d.]+)"/.exec(html).map((x, i) => i ? Number(x) : x);
  const box = new THREE.Box3();
  for (const id of wallIds) parts.get(id).traverse(o => { if (o.isMesh) box.expandByObject(o); });
  // The plane sits at z = -value, so the slider must cover -z for every z of the wall, to within one step (0.05).
  assert.ok(min <= -box.max.z + .05 && max >= -box.min.z - .05, `slider ${min}..${max}, chambers z ${box.min.z.toFixed(3)}..${box.max.z.toFixed(3)}`);
});

test('the right and left bundle branches are separate parts with their own colours, and the label anchors follow them', () => {
  const ids = conductionDefinitions.map(d => d[0]);
  assert.deepEqual(ids, ['sa', 'atria', 'av', 'his', 'bhis', 'rbb', 'lbb', 'purkinje']);
  const colors = ['rbb', 'lbb', 'purkinje'].map(id => parts.get(id).userData.color);
  assert.equal(new Set(colors).size, 3, 'the two branches and the Purkinje lines must not share a colour');
  // paths.branches is [left, right] in the generated data (the regression test above checks the walls they lie on).
  const { branches } = meta.conduction.paths;
  for (const [id, line] of [['lbb', branches[0]], ['rbb', branches[1]]]) {
    const box = new THREE.Box3().setFromObject(parts.get(id)), inverse = new THREE.Matrix4().copy(conduction.matrixWorld).invert();
    box.applyMatrix4(inverse);
    box.expandByScalar(1);
    for (const p of [line[0], line.at(-1)]) assert.ok(box.containsPoint(new THREE.Vector3(...p)), `${id} does not contain the end ${p}`);
    assert.equal(parts.get(id).children.length, id === 'lbb' ? 4 : 1, `${id} has its expected sheet/path meshes`);
  }
});

test('removedByCut agrees with a vertex-by-vertex check for every part at several cut depths', () => {
  const root = new THREE.Group(), ext = new THREE.Group(), map = new Map(), cond = new THREE.Group();
  root.add(ext); createAnatomy(ext, map, bundle, .033); ext.add(cond); createConduction(cond, map, meta.conduction);
  root.updateMatrixWorld(true);
  let gone = 0, kept = 0;
  for (const depth of [-1.8, -.6, 0, .3, .9, 1.5, 1.8]) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -depth);
    for (const [id, group] of map) {
      const box = new THREE.Box3().setFromObject(group);
      let anyKept = false;
      group.traverse(o => {
        const p = o.geometry?.attributes.position;
        for (let i = 0; p && i < p.count; i++) if (plane.distanceToPoint(o.localToWorld(new THREE.Vector3().fromBufferAttribute(p, i))) >= 0) anyKept = true;
      });
      assert.equal(removedByCut(box, plane), !anyKept, `${id} at depth ${depth}`);
      anyKept ? kept++ : gone++;
    }
  }
  assert.ok(gone > 10 && kept > 10, `${gone} removed / ${kept} kept: the check must cover both`);
  // README: at slider 0.9 the whole conduction system is cut away; at 0 the AV node and the His bundle are not.
  const at = (depth, id) => removedByCut(new THREE.Box3().setFromObject(map.get(id)), new THREE.Plane(new THREE.Vector3(0, 0, -1), -depth));
  for (const [id] of conductionDefinitions) assert.equal(at(.9, id), true, `${id} at 0.9`);
  assert.equal(at(0, 'av'), false);
  assert.equal(at(0, 'his'), false);
});

test('a conduction label can sit behind an opaque wall in the interior view (the His bundle at slider -0.3, seen from the front)', () => {
  const root = new THREE.Group(), ext = new THREE.Group(), map = new Map(), cond = new THREE.Group();
  root.add(ext); createAnatomy(ext, map, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), .3), section = createCrossSection(ext, map, plane, 0xc98478); // slider -0.3
  section.setEnabled(true);
  ext.add(cond); const anchors = createConduction(cond, map, meta.conduction);
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(0, .06, 1).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  const occluders = [...map.values()].filter(g => g.userData.kind !== 'conduction');
  const behind = new Map();
  for (const [id, anchor] of anchors) {
    const world = cond.localToWorld(new THREE.Vector3(...anchor));
    if (plane.distanceToPoint(world) < 0) continue; // cut away: no label at all
    const direction = world.clone().sub(camera.position), distance = direction.length();
    const ray = new THREE.Raycaster(camera.position, direction.normalize());
    const hit = pickHit(ray, occluders, [plane], section.solids);
    behind.set(id, Boolean(hit) && hit.distance < distance - .04);
  }
  // Measured on 2026-11-07 with this scene (positions from the Koch-apex rule): His behind the cut face of the left
  // ventricle, the AV node behind the cut face of the right ventricle, the SA node behind the right atrium; the Purkinje
  // label in view. (With the earlier positions the report's case was the His bundle at slider 0.)
  assert.equal(behind.get('his'), true, 'the ray to the His label meets the left ventricle first');
  assert.equal(behind.get('av'), true);
  assert.equal(behind.get('sa'), true);
  assert.equal(behind.get('purkinje'), false);
});

test('regression of the Koch-apex rule (not anatomical validation): the AV node sits on the tricuspid valve next to the aortic root, the branching point under the aortic valve', () => {
  // Measured on 2026-11-07 from the bundle: AV node 0.0 mm from the tricuspid valve and 10.3 mm from the aortic valve,
  // branching point 4.6 mm from the aortic valve. With the earlier rule (midpoint towards the coronary sinus, 12 mm below
  // the cusp) the values were 19.7 and 12.2 mm, which these bounds reject. The rule picks points near the valves, so
  // these numbers follow from the rule and do not confirm the anatomy.
  const nearestTo = (q, id) => {
    const p = anatomy.parts.find(x => x.id === id).positions;
    let best = Infinity;
    for (let i = 0; i < p.length; i += 3) best = Math.min(best, Math.hypot(p[i] - q[0], p[i + 1] - q[1], p[i + 2] - q[2]));
    return best;
  };
  const { nodes, paths } = anatomy.meta.conduction, bifurcation = paths.his[0].at(-1);
  assert.ok(nearestTo(nodes.av, 'tv') < 2, `AV node ${nearestTo(nodes.av, 'tv').toFixed(1)} mm from the tricuspid valve`);
  assert.ok(nearestTo(nodes.av, 'aov') < 14, `AV node ${nearestTo(nodes.av, 'aov').toFixed(1)} mm from the aortic valve`);
  assert.ok(nearestTo(bifurcation, 'aov') < 8, `branching point ${nearestTo(bifurcation, 'aov').toFixed(1)} mm from the aortic valve`);
  assert.deepEqual(paths.his[0][0], nodes.av, 'the His bundle starts at the AV node');
});

test('schematic conduction paths share their junctions and have no unsampled long right-branch tail', () => {
  const { nodes, paths } = anatomy.meta.conduction;
  for (const atrial of paths.atria) assert.deepEqual(atrial[0], nodes.sa, 'both atrial routes start at the sinus node');
  assert.deepEqual(paths.atria[0].at(-1), nodes.av, 'atrial route meets the AV node');
  assert.deepEqual(paths.his[0][0], nodes.av, 'His bundle starts at the AV node');
  const { leftOrigin, rightOrigin } = anatomy.meta.conduction.junctions;
  assert.notDeepEqual(leftOrigin, rightOrigin, 'left and right take-offs are distinct');
  assert.deepEqual(paths.his[0].at(-1), leftOrigin);
  assert.deepEqual(paths.branchingHis[0][0], leftOrigin);
  assert.deepEqual(paths.branchingHis[0].at(-1), rightOrigin);
  assert.deepEqual(paths.branches[0][0], leftOrigin, 'left branch leaves the earlier take-off');
  assert.deepEqual(paths.branches[1][0], rightOrigin, 'right branch continues from the distal interval');
  for (const [i, fibre] of paths.purkinje.entries()) assert.deepEqual(fibre[0], paths.branches[i < 2 ? 0 : 1].at(-1), 'fibres meet their branch');
  const right = paths.branches[1];
  const gaps = right.slice(1).map((p, i) => Math.hypot(...p.map((v, k) => v - right[i][k])));
  assert.ok(Math.max(...gaps) < 12, `unsampled right-branch interval: ${Math.max(...gaps)} mm`);
});

test('proximal His schematic crosses directly between its anchors; sinus node is elongated caudally', () => {
  const root = new THREE.Group(), map = new Map();
  createConduction(root, map, anatomy.meta.conduction);
  const curve = map.get('his').children[0].geometry.parameters.path;
  const start = curve.getPoint(0), end = curve.getPoint(1), axis = end.clone().sub(start);
  let previous = -Infinity;
  for (const point of curve.getPoints(100)) {
    const t = point.clone().sub(start).dot(axis) / axis.lengthSq();
    assert.ok(t >= previous - 1e-6 && t >= -1e-6 && t <= 1 + 1e-6, 'no return or overshoot');
    assert.ok(point.distanceTo(start.clone().addScaledVector(axis, t)) < .01, 'no LV-surface detour');
    previous = t;
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(map.get('sa')), size = box.getSize(new THREE.Vector3());
  assert.ok(size.y > size.x * 3 && size.y > size.z * 3, 'elongated instead of spherical');
  assert.ok(box.containsPoint(new THREE.Vector3(...anatomy.meta.conduction.nodes.sa)), 'head anchor remains inside the node');
  assert.ok(box.getCenter(new THREE.Vector3()).y < anatomy.meta.conduction.nodes.sa[1], 'body extends caudally');
});


test('His intervals are separately selectable, differently coloured, and share only their junction', () => {
  const root = new THREE.Group(), map = new Map();
  const anchors = createConduction(root, map, anatomy.meta.conduction);
  const proximal = map.get('his'), branching = map.get('bhis');
  assert.ok(proximal && branching);
  assert.notEqual(proximal.userData.color, branching.userData.color);
  assert.equal(selectableIn(branching.userData, 'conduction', false), true);
  assert.equal(selectableIn(branching.userData, 'interior', false), false);
  assert.equal(selectableIn(branching.userData, 'interior', true), true);
  const first = proximal.children[0].geometry.parameters.path;
  const second = branching.children[0].geometry.parameters.path;
  assert.ok(first.getPoint(1).distanceTo(second.getPoint(0)) < 1e-6);
  assert.ok(first.getPoint(0).distanceTo(second.getPoint(1)) > 1);
  for (const [id, curve] of [['his', first], ['bhis', second]]) {
    assert.ok(new THREE.Vector3(...anchors.get(id)).distanceTo(curve.getPointAt(.5)) < 1e-6, id + ' anchor is on its own curve');
  }
  heart.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(0, .06, 1).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  for (const id of ['his', 'bhis']) {
    const world = conduction.localToWorld(new THREE.Vector3(...anchors.get(id)));
    const ray = new THREE.Raycaster(camera.position, world.clone().sub(camera.position).normalize());
    ray.params.Line.threshold = .08 / exterior.scale.x;
    assert.equal(pickPart(ray, [...parts.values()].filter(g => g.userData.kind === 'conduction')), id, id + ' is picked at its label anchor');
  }

});


test('left bundle has a non-degenerate broad sheet and three routes connected to the existing network', () => {
  const {leftBundle, paths, junctions} = anatomy.meta.conduction;
  assert.deepEqual(leftBundle.directions, ['anterior','septal','posterior']);
  assert.equal(paths.leftFascicles.length, 3);
  const {positions, indices} = leftBundle.sheet;
  const point = i => new THREE.Vector3(...positions.slice(i*3,i*3+3));
  assert.ok(positions.every(Number.isFinite));
  assert.ok(indices.every(i => Number.isInteger(i) && i >= 0 && i < positions.length/3));
  let area = 0;
  for(let i=0;i<indices.length;i+=3){
    const a=point(indices[i]), b=point(indices[i+1]), c=point(indices[i+2]);
    const twiceArea=b.sub(a).cross(c.sub(a)).length();
    assert.ok(twiceArea>.001, 'no collapsed triangles');
    area+=twiceArea/2;
  }
  assert.ok(area>60, `a broad surface, rather than a line: ${area} mm2`);
  const graph=new Map(), edgeUses=new Map();
  for(let i=0;i<indices.length;i+=3) for(let k=0;k<3;k++){
    const a=indices[i+k], b=indices[i+(k+1)%3];
    if(!graph.has(a))graph.set(a,new Set()); if(!graph.has(b))graph.set(b,new Set());
    graph.get(a).add(b); graph.get(b).add(a);
    const key=[a,b].sort((x,y)=>x-y).join(',');edgeUses.set(key,(edgeUses.get(key)||0)+1);
  }
  const seen=new Set(), pending=[indices[0]];
  while(pending.length){const a=pending.pop();if(seen.has(a))continue;seen.add(a);pending.push(...graph.get(a));}
  assert.equal(seen.size,graph.size,'the sheet is a single connected surface');
  assert.ok([...edgeUses.values()].every(n=>n<=2),'no non-manifold sheet edges');
  assert.ok([...seen].some(i=>point(i).distanceTo(new THREE.Vector3(...junctions.leftOrigin))<.01), 'sheet meets His-side proxy');
  const [anterior,septal,posterior]=paths.leftFascicles;
  const inNetwork=(p,line)=>line.some(q=>Math.hypot(...q.map((v,k)=>v-p[k]))<.01);
  assert.ok(inNetwork(anterior.at(-1),paths.purkinje[1]));
  assert.ok(inNetwork(posterior.at(-1),paths.purkinje[0]));
  assert.deepEqual(septal.at(-1),paths.purkinje[0][0]);
  assert.ok(anterior.at(-1)[2]>posterior.at(-1)[2]+10, 'anterior and posterior are not duplicate directions');
  for(const line of [anterior,posterior]) assert.ok([...seen].some(i=>point(i).distanceTo(new THREE.Vector3(...line[0]))<.01), 'directional route meets the connected sheet');
  const mesh=parts.get('lbb').children[0];
  assert.equal(mesh.material.side,THREE.DoubleSide,'sheet is visible from either side');
});
