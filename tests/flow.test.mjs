import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { anatomyDefinitions, createAnatomy, decodeAnatomy, interiorDefinitions } from '../src/anatomy.mjs';
import { createBeat } from '../src/heartbeat.mjs';
import { checkRoute, inside, makeSolid, nearestVertexDistance, rayHits, wallDistanceAround } from '../scripts/flow-geometry.mjs';

// The blood-flow routes (meta.flow) are a schematic made by scripts/prepare-bodyparts3d.mjs. These tests check what the
// bundle can show without the BodyParts3D zips: the routes against the cavities and vessels that are in the bundle, and
// the geometry functions themselves. They do not show that the routes are anatomically right.
const bytes = readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url));
const anatomy = decodeAnatomy(new Uint8Array(bytes)), { flow } = anatomy.meta;
const mesh = id => { const p = anatomy.parts.find(part => part.id === id); return { positions: Array.from(p.positions), indices: Array.from(p.indices) }; };
const cavityIds = ['lv', 'rv', 'ra', 'la'];
const cavities = Object.fromEntries(cavityIds.map(id => [id, makeSolid(mesh('cav' + id))]));
const vesselSolids = Object.fromEntries(['vc', 'pa', 'pv', 'ao'].map(id => [id, makeSolid(mesh(id))]));
const vesselsOf = { right: ['vc', 'pa'], left: ['pv', 'ao'] }, expectedOrder = { right: ['ra', 'rv'], left: ['la', 'lv'] };
const regionsFor = (side, valves = flow.valves) => ({ cavities, vessels: Object.fromEntries(vesselsOf[side].map(id => [id, vesselSolids[id]])), valves });
const curveOf = points => new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), false, 'centripetal');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const valveParts = { tricuspid: 'tv', mitral: 'mv', aortic: 'aov', pulmonary: 'pov' };
const valveSides = { tricuspid: ['ra', 'rv'], mitral: ['la', 'lv'], aortic: ['lv'], pulmonary: ['rv'] };

test('the bundle holds six routes, four valve openings and the four cavities, which are not drawn', () => {
  assert.deepEqual(flow.routes.map(r => r.id), ['svc', 'ivc', 'lspv', 'lipv', 'rspv', 'ripv']);
  assert.deepEqual(flow.routes.map(r => r.side), ['right', 'right', 'left', 'left', 'left', 'left']);
  assert.deepEqual(flow.routes.map(r => r.outlet), ['lpa', 'rpa', 'arch', 'arch', 'arch', 'arch']);
  assert.deepEqual(Object.keys(flow.valves), ['tricuspid', 'mitral', 'aortic', 'pulmonary']);
  const drawn = new Set([...anatomyDefinitions, ...interiorDefinitions].map(d => d[0]));
  for (const id of cavityIds) {
    assert.ok(anatomy.parts.some(p => p.id === 'cav' + id), `cav${id} is in the bundle`);
    assert.ok(!drawn.has('cav' + id), `cav${id} must not be drawn`);
  }
  // The cavities must hold plausible volumes (grid count, 3 mm): a swapped or empty cavity would not.
  const volume = id => { const s = cavities[id]; let n = 0; for (let x = s.min[0]; x <= s.max[0]; x += 3) for (let y = s.min[1]; y <= s.max[1]; y += 3) for (let z = s.min[2]; z <= s.max[2]; z += 3) if (inside(s, [x, y, z])) n++; return n * 27 / 1000; };
  for (const id of cavityIds) { const mL = volume(id); assert.ok(mL > 35 && mL < 140, `${id} holds ${mL} mL`); }
});

test('geometry helpers: inside, nearest wall and enclosure on a cube and a tube', () => {
  const cube = makeSolid({ positions: [0,0,0, 10,0,0, 10,10,0, 0,10,0, 0,0,10, 10,0,10, 10,10,10, 0,10,10], indices: [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 3,6,2, 3,7,6, 0,4,7, 0,7,3, 1,2,6, 1,6,5] });
  assert.equal(inside(cube, [5, 5, 5]), true);
  assert.equal(inside(cube, [5, 5, 12]), false);
  assert.equal(inside(cube, [-1, 5, 5]), false);
  // A tube of radius 5 along y, open at both ends, from y = 0 to y = 40.
  const g = new THREE.CylinderGeometry(5, 5, 40, 24, 1, true).translate(0, 20, 0);
  const tube = makeSolid({ positions: Array.from(g.attributes.position.array), indices: Array.from(g.index.array) });
  assert.ok(Math.abs(wallDistanceAround(tube, [0, 13, 0], [0, 1, 0]) - 5) < .1, 'on the axis: the radius (the tube has 24 flat faces)');
  assert.ok(Math.abs(wallDistanceAround(tube, [2, 13, 0], [0, 1, 0]) - 3) < .2, 'off the axis the nearest ray is closer to the wall');
  assert.equal(wallDistanceAround(tube, [9, 13, 0], [0, 1, 0]), Infinity, 'a point outside the tube is not enclosed');
  assert.equal(wallDistanceAround(tube, [0, 1, 0], [1, 1, 0]), Infinity, 'a tilted cut near the open end lets rays out');
  // Two hits closer than 0.02 mm count once: a doubled face does not flip the answer.
  const doubled = makeSolid({ positions: cube.positions, indices: [...cube.indices, ...cube.indices] });
  assert.equal(inside(doubled, [5, 5, 5]), true);
  assert.equal(rayHits(cube, [4, 6, 5], [0, 0, 1]).length, 1);
});

test('every route stays in the cavities and the vessel; the only stretches that do not are valve roots and the atrial wall', () => {
  for (const route of flow.routes) {
    const result = checkRoute(curveOf(route.points), regionsFor(route.side), expectedOrder[route.side]);
    assert.deepEqual(result.problems, [], `${route.id}: ${result.problems}`);
    assert.deepEqual(result.order, expectedOrder[route.side]);
    assert.ok(result.longestGap <= 5, `${route.id}: longest stretch outside both is ${result.longestGap} mm (measured 5)`);
    // Measured: one stretch of 3-4 mm at each valve crossed, and 5 mm where the right superior pulmonary vein enters the left atrium.
    const atValve = result.gaps.filter(g => g.atValve).length, atJunction = result.gaps.filter(g => !g.atValve && g.joins).length;
    assert.ok(atValve <= 3 && atJunction <= 1, `${route.id}: ${atValve} gaps at valves, ${atJunction} at junctions`);
  }
});

test('the check does fail for a route that leaves the heart or runs through the wrong chambers', () => {
  const route = flow.routes.find(r => r.id === 'svc');
  const shifted = route.points.map(p => [p[0], p[1], p[2] + 15]);
  assert.notDeepEqual(checkRoute(curveOf(shifted), regionsFor('right'), expectedOrder.right).problems, []);
  assert.notDeepEqual(checkRoute(curveOf(route.points), regionsFor('left'), expectedOrder.left).problems, [], 'a right-heart route is not a left-heart route');
  // A straight chord from the start of the caval route to the middle of the left atrium cuts through the septum and walls.
  const la = flow.routes.find(r => r.id === 'lspv').points[flow.routes.find(r => r.id === 'lspv').marks.atrium];
  const chord = [route.points[0], ...Array.from({ length: 12 }, (_, i) => route.points[0].map((v, k) => v + (la[k] - v) * (i + 1) / 12))];
  assert.notDeepEqual(checkRoute(curveOf(chord), regionsFor('right'), expectedOrder.right).problems, []);
});

test('marks name the middle of each chamber and the centre of each valve along the route, in the order of the circulation', () => {
  for (const route of flow.routes) {
    const { atrium, atrioventricular, ventricle, arterial } = route.marks, p = route.points;
    assert.ok(0 < atrium && atrium < atrioventricular && atrioventricular < ventricle && ventricle < arterial && arterial < p.length - 1, `${route.id}: ${JSON.stringify(route.marks)}`);
    const [a, v] = expectedOrder[route.side], valves = route.side === 'right' ? ['tricuspid', 'pulmonary'] : ['mitral', 'aortic'];
    assert.ok(inside(cavities[a], p[atrium]), `${route.id}: atrium mark is not in ${a}`);
    assert.ok(inside(cavities[v], p[ventricle]), `${route.id}: ventricle mark is not in ${v}`);
    assert.ok(dist(p[atrioventricular], flow.valves[valves[0]].center) < 2.5, `${route.id}: atrioventricular mark is ${dist(p[atrioventricular], flow.valves[valves[0]].center)} mm from the valve centre`);
    assert.ok(dist(p[arterial], flow.valves[valves[1]].center) < 2.5, `${route.id}: arterial mark is ${dist(p[arterial], flow.valves[valves[1]].center)} mm from the valve centre`);
  }
  // +X is the patient's left: the right heart lies at smaller X than the left atrium.
  const x = (id, mark) => { const r = flow.routes.find(route => route.id === id); return r.points[r.marks[mark]][0]; };
  assert.ok(x('svc', 'atrium') < x('lspv', 'atrium') && x('ivc', 'atrium') < x('ripv', 'atrium'));
  assert.ok(x('svc', 'ventricle') < x('lspv', 'ventricle'), 'the right ventricle lies to the right of the left ventricle');
});

test('each valve opening lies where the valve is: between its two chambers, near its leaflets, with a plausible radius', () => {
  for (const [valve, opening] of Object.entries(flow.valves)) {
    assert.ok(opening.radius > 8 && opening.radius < 20, `${valve} radius ${opening.radius}`);
    // Distances to the nearest cavity vertex, which are larger than to the surface because the vertices are a few mm apart:
    // measured at most 8.9 mm (mitral, left atrium). The valve's own chambers must be nearer than the others.
    const near = id => nearestVertexDistance(mesh('cav' + id), opening.center);
    for (const id of valveSides[valve]) assert.ok(near(id) < 10, `${valve} centre is ${near(id)} mm from the ${id} cavity`);
    const others = cavityIds.filter(id => !valveSides[valve].includes(id));
    assert.ok(Math.max(...valveSides[valve].map(near)) < Math.min(...others.map(near)), `${valve} centre is nearer another chamber than its own`);
    const toLeaflet = nearestVertexDistance(mesh(valveParts[valve]), opening.center);
    assert.ok(toLeaflet < 3, `${valve} centre is ${toLeaflet} mm from the nearest leaflet vertex`);
  }
});

test('known limit: the routes cross the valve leaflets, which are one moment of the source data and sit across the opening', () => {
  // Measured with the leaflet meshes in the bundle: tricuspid 2, pulmonary 2, mitral 4, aortic 2 crossings per route.
  // A crossing is a leaflet surface met along the route. This is a bound on the known limit, not a goal: if a change
  // lowers it, lower the numbers here and in the README; if it raises them, look at why.
  const bound = { tricuspid: 2, pulmonary: 2, mitral: 4, aortic: 2 };
  for (const route of flow.routes) {
    const curve = curveOf(route.points), length = curve.getLength();
    for (const [valve, id] of Object.entries(valveParts)) {
      const solid = makeSolid(mesh(id));
      let crossings = 0;
      for (let d = 0; d + 1 < length; d++) {
        const a = curve.getPointAt(d / length).toArray(), b = curve.getPointAt((d + 1) / length).toArray(), step = dist(a, b);
        crossings += rayHits(solid, a, b.map((v, k) => (v - a[k]) / step)).filter(h => h <= step).length;
      }
      assert.ok(crossings <= bound[valve], `${route.id} crosses the ${valve} leaflets ${crossings} times (measured at most ${bound[valve]})`);
    }
  }
});

test('route points are evenly spaced and bend gently', () => {
  for (const { id, points } of flow.routes) {
    let sharpest = 0;
    points.forEach((p, i) => {
      if (i) assert.ok(dist(p, points[i - 1]) > 2.5 && dist(p, points[i - 1]) < 3.5, `${id}: spacing ${dist(p, points[i - 1])} at ${i}`);
      if (i && i + 1 < points.length) {
        const u = points[i].map((v, k) => v - points[i - 1][k]), w = points[i + 1].map((v, k) => v - points[i][k]);
        sharpest = Math.max(sharpest, Math.acos(Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / Math.hypot(...u) / Math.hypot(...w))) * 180 / Math.PI);
      }
    });
    assert.ok(sharpest < 50, `${id}: sharpest bend ${sharpest} degrees over one 3 mm step (measured 45)`);
  }
});

// The beat moves every vertex by a displacement that depends only on its position (README, 拍動). The routes must follow
// it: the same displacement applied to the route, the cavities, the vessels and the valve centres keeps the route inside.
test('moved by the heartbeat displacement together with the cavities and vessels, the routes stay inside; left at rest they do not', () => {
  const heart = new THREE.Group(), exterior = new THREE.Group(), parts = new Map();
  heart.add(exterior);
  createAnatomy(exterior, parts, new Uint8Array(bytes), .033);
  const beat = createBeat(exterior, parts);
  const moveMesh = m => { const positions = []; for (let i = 0; i < m.positions.length; i += 3) positions.push(...beat.displace([m.positions[i], m.positions[i + 1], m.positions[i + 2]])); return { positions, indices: m.indices }; };
  const states = { 'atrial systole at its peak': { atria: 1, ventricles: 0 }, 'ventricular systole at its peak': { atria: 0, ventricles: 1 } };
  for (const [name, state] of Object.entries(states)) {
    beat.set(state);
    const movedCavities = Object.fromEntries(cavityIds.map(id => [id, makeSolid(moveMesh(mesh('cav' + id)))]));
    const vessels = Object.fromEntries(Object.entries(vesselSolids).map(([id, s]) => [id, makeSolid(moveMesh({ positions: s.positions, indices: s.indices }))]));
    const valves = Object.fromEntries(Object.entries(flow.valves).map(([id, v]) => [id, { center: beat.displace(v.center), radius: v.radius }]));
    let atRestFailures = 0;
    for (const route of flow.routes) {
      const regions = { cavities: movedCavities, vessels: Object.fromEntries(vesselsOf[route.side].map(id => [id, vessels[id]])), valves };
      const followed = checkRoute(curveOf(route.points.map(p => beat.displace(p))), regions, expectedOrder[route.side]);
      assert.deepEqual(followed.problems, [], `${route.id}, ${name}: ${followed.problems}`);
      if (checkRoute(curveOf(route.points), regions, expectedOrder[route.side]).problems.length) atRestFailures++;
    }
    // Informational bound, not a requirement: how many routes would leave the moved walls if their points stayed put.
    console.log(`${name}: ${atRestFailures} of ${flow.routes.length} routes fail the check if left at rest`);
  }
  beat.set({ atria: 0, ventricles: 0 });
});
