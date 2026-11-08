import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAnatomy } from '../src/anatomy.mjs';
import { createFlow } from '../src/flow.mjs';
import { period, valvesAt } from '../src/heartbeat.mjs';
import { createValves, leafletCount, leafletDistance, pointTriangleDistance, valveAxes, valveKind, valveNames, valveOfRoute, valveSettings } from '../src/valves.mjs';

// The schematic valve leaflets of the blood-flow view (src/valves.mjs) and how the particles keep away from them (src/flow.mjs).
// The shape is a display choice (README, 血流の弁尖); these tests check that it is consistent, that it leaves a passage when open and
// covers the opening when closed, and that no particle comes within the clearance of a leaflet, moving or not. They do not show
// that the valves are anatomically right.
const { flow: data } = decodeAnatomy(new Uint8Array(readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)))).meta;
const valves = createValves(data);
const axial = (valve, p) => (p[0] - valve.center[0]) * valve.axis[0] + (p[1] - valve.center[1]) * valve.axis[1] + (p[2] - valve.center[2]) * valve.axis[2];
const vertex = (positions, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
const onAxis = (valve, z) => [0, 1, 2].map(k => valve.center[k] + valve.axis[k] * z);

test('each valve has its textbook number of leaflets, attached on a ring in the plane of the valve opening', () => {
  assert.deepEqual(valveNames.map(name => valves[name].leaflets), [3, 2, 3, 3]);
  assert.deepEqual(Object.fromEntries(valveNames.map(name => [name, leafletCount[name]])), { tricuspid: 3, mitral: 2, aortic: 3, pulmonary: 3 });
  for (const name of valveNames) {
    const v = valves[name], n = v.leaflets, per = valveSettings.arcSegments + 1;
    assert.equal(v.vertexCount, n * (1 + per));
    assert.equal(v.indices.length, n * valveSettings.arcSegments * 3);
    assert.ok(Math.abs(Math.hypot(...v.axis) - 1) < 1e-9);
    assert.ok(Math.abs(v.ring - data.valves[name].radius * valveSettings.ring) < 1e-9);
    // The attached edge (the arc) does not move with the opening; it lies on the ring in the plane of the opening.
    const closed = v.pose(0), open = v.pose(1);
    for (let j = 0; j < n; j++) for (let k = 0; k < per; k++) {
      const i = j * (1 + per) + 1 + k, a = vertex(closed, i), b = vertex(open, i);
      assert.ok(Math.hypot(...a.map((x, m) => x - b[m])) < 1e-9, `${name}: leaflet ${j}, point ${k} moved`);
      assert.ok(Math.abs(axial(v, a)) < 1e-9, `${name}: attached edge leaves the plane`);
      assert.ok(Math.abs(Math.hypot(...a.map((x, m) => x - v.center[m])) - v.ring) < 1e-9, `${name}: attached edge is not on the ring`);
    }
  }
});

test('closed, the leaflets are a flat disc over the whole opening; open, they leave a round passage around the axis', () => {
  for (const name of valveNames) {
    const v = valves[name], closed = v.pose(0), open = v.pose(1);
    for (let i = 0; i < v.vertexCount; i++) assert.ok(Math.abs(axial(v, vertex(closed, i))) < 1e-9, `${name}: closed leaflets are not flat`);
    // Every point of the disc to 90% of the ring is on a leaflet (the arcs are polygons: with two leaflets a chord runs 92.4% of the ring out).
    const u = [0, 1, 0].map((x, k) => x - v.axis[1] * v.axis[k]), ul = Math.hypot(...u), e1 = u.map(x => x / ul);
    const e2 = [v.axis[1] * e1[2] - v.axis[2] * e1[1], v.axis[2] * e1[0] - v.axis[0] * e1[2], v.axis[0] * e1[1] - v.axis[1] * e1[0]];
    for (let s = 0; s < 400; s++) {
      const angle = s * 2.399963, radius = v.ring * .9 * Math.sqrt((s + .5) / 400); // a sunflower spread of points
      const p = [0, 1, 2].map(k => v.center[k] + radius * (Math.cos(angle) * e1[k] + Math.sin(angle) * e2[k]));
      assert.ok(leafletDistance(v, closed, p) < 1e-6, `${name}: the closed valve has a hole at radius ${radius.toFixed(1)}, angle ${angle % (2 * Math.PI)}`);
    }
    // Open: along the axis from the wall position to past the leaflets' reach, the nearest leaflet is far from the axis.
    let widest = Infinity;
    for (let z = -2; z <= v.lift + 3; z += .25) widest = Math.min(widest, leafletDistance(v, open, onAxis(v, z)));
    assert.ok(widest > 5, `${name}: only ${widest} mm of passage`);
    assert.ok(widest > 3 * valveSettings.particleRadius, 'the passage is wider than three particle radii');
    // The leaflets move monotonically: the free corners go downstream and the passage widens as the valve opens.
    let previous = -Infinity;
    for (let e = 0; e <= 1.0001; e += .1) {
      const pose = v.pose(e), height = axial(v, vertex(pose, 0));
      assert.ok(height >= previous - 1e-9, `${name}: the free corner went back at ${e}`);
      previous = height;
    }
    assert.ok(Math.abs(axial(v, vertex(open, 0)) - v.lift) < 1e-9);
  }
});

test('point to triangle distance: inside the triangle, beside an edge and beyond a corner', () => {
  const a = [0, 0, 0], b = [4, 0, 0], c = [0, 4, 0];
  assert.equal(pointTriangleDistance([1, 1, 2], a, b, c), 2);
  assert.equal(pointTriangleDistance([2, -3, 0], a, b, c), 3);
  assert.equal(pointTriangleDistance([-3, -4, 0], a, b, c), 5);
  assert.ok(Math.abs(pointTriangleDistance([3, 3, 1], a, b, c) - Math.hypot(Math.SQRT2, 1)) < 1e-9); // (3, 3) is sqrt 2 from the long edge in the plane
});

test('the axis of a valve follows the routes through it: every route crosses at a slant of under 25 degrees', () => {
  const axes = valveAxes(data);
  let worst = 0;
  for (const route of data.routes) for (const kind of ['atrioventricular', 'arterial']) {
    const name = valveOfRoute(route.side, kind), m = route.marks[kind], p = route.points;
    const t = [0, 1, 2].map(k => p[Math.min(m + 2, p.length - 1)][k] - p[Math.max(m - 2, 0)][k]);
    const cos = (t[0] * axes[name][0] + t[1] * axes[name][1] + t[2] * axes[name][2]) / Math.hypot(...t);
    worst = Math.max(worst, Math.acos(cos) * 180 / Math.PI);
    assert.equal(valveKind[name], kind);
  }
  assert.ok(worst < 25, `${worst} degrees`);
});

// Every particle against every leaflet, at every step of several beats. The distance is from the particle's centre to the nearest
// triangle, in the millimetre frame of the parts (the particles are spheres of radius valveSettings.particleRadius).
function minimumClearance(flow, frames, beats) {
  const out = [0, 0, 0], positions = Object.fromEntries(valveNames.map(name => [name, new Float64Array(flow.valves[name].vertexCount * 3)]));
  let best = { distance: Infinity };
  let time = 0, frame = 0;
  while (time < beats * period) {
    const next = time + frames[frame++ % frames.length];
    flow.advance(time, next);
    time = next;
    for (const name of valveNames) flow.leaflets(name, positions[name]);
    for (let k = 0; k < flow.count; k++) {
      flow.sample(k, out);
      for (const name of valveNames) {
        const v = flow.valves[name], z = axial(v, out);
        if (z < -12 || z > 12 || Math.hypot(...out.map((x, m) => x - v.center[m] - z * v.axis[m])) > v.ring + 4) continue;
        const distance = leafletDistance(v, positions[name], out);
        if (distance < best.distance) best = { distance, name, time: time % period, z, open: flow.openness(name) };
      }
    }
  }
  return best;
}

test('no particle comes within the clearance of a leaflet, whether the leaflets are still, opening or closing, and whatever the frame interval', () => {
  const clearance = valveSettings.particleRadius + valveSettings.margin;
  // Frame intervals: a fine step, a 60 Hz and a 30 Hz screen, a slow device, and a mixed sequence with a long frame.
  for (const frames of [[2], [16.7], [33.3], [120], [7, 16.7, 250, 3, 33.3]]) {
    const best = minimumClearance(createFlow(data), frames, 8);
    assert.ok(best.distance >= clearance - 1e-9, `frames ${frames}: ${best.distance} mm from the ${best.name} valve at ${best.time} ms (openness ${best.open}, ${best.z} mm along the axis)`);
    assert.ok(best.distance > valveSettings.particleRadius + 0.4);
  }
});

test('the leaflets are completely open within 20 ms of the start of the valve window, and closed within 60 ms of its end', () => {
  const flow = createFlow(data), seen = Object.fromEntries(valveNames.map(name => [name, { open: [], close: [] }]));
  const before = Object.fromEntries(valveNames.map(name => [name, valvesAt(0)[valveKind[name]]]));
  const openedAt = {}, closedAt = {};
  for (let ms = 0; ms < 8 * period; ms += 1) {
    flow.advance(ms, ms + 1);
    for (const name of valveNames) {
      const now = valvesAt(ms + 1)[valveKind[name]], o = flow.openness(name);
      if (now && !before[name]) openedAt[name] = ms + 1;                                           // the window has just opened
      if (!now && before[name]) closedAt[name] = ms + 1;                                           // the window has just ended
      if (o === 1 && openedAt[name] !== undefined) { if (ms > 2 * period) seen[name].open.push(ms + 1 - openedAt[name]); openedAt[name] = undefined; }
      if (o === 0 && closedAt[name] !== undefined) { if (ms > 2 * period) seen[name].close.push(ms + 1 - closedAt[name]); closedAt[name] = undefined; }
      before[name] = now;
    }
  }
  // Measured over 8 beats with the 10 ms swing: leaflets completely open 0 ms after the window opens, closed 11 to 54 ms after it ends.
  for (const name of valveNames) {
    assert.ok(seen[name].open.length >= 5, `${name}: ${seen[name].open.length} openings seen`);
    assert.ok(Math.max(...seen[name].open) <= 20, `${name}: completely open ${Math.max(...seen[name].open)} ms after the window opened`);
    assert.ok(seen[name].close.length >= 5, `${name}: ${seen[name].close.length} closings seen`);
    assert.ok(Math.max(...seen[name].close) <= 60, `${name}: closed ${Math.max(...seen[name].close)} ms after the window`);
  }
});

test('the four valves are never open together on one side, and all four are closed together for a stretch of each isovolumic period (review of PR #32)', () => {
  // Review of PR #32, first round: the mitral valve was held open by the last particle of the filling column while the aortic valve
  // opened from 25 ms before its window, so both were completely open at 150 ms and at 160 ms. Second round: the two sides closed at
  // different times (right 123-125 ms, left 137 ms in the contraction period), so there was no instant at which all four were closed,
  // while the screen says that in the isovolumic periods all four valves are closed.
  const flow = createFlow(data), pairs = [['tricuspid', 'pulmonary'], ['mitral', 'aortic']];
  const runs = { contraction: [], relaxation: [] };
  let run = null, worst = 0;
  for (let ms = 0; ms < 8 * period; ms += 1) {
    flow.advance(ms, ms + 1);
    if (ms < 2 * period) continue;
    const t = (ms + 1) % period;
    for (const [a, b] of pairs) {
      const small = Math.min(flow.openness(a), flow.openness(b));
      worst = Math.max(worst, small);
      assert.ok(small <= .05, `${a} ${flow.openness(a)} and ${b} ${flow.openness(b)} are open together at ${t} ms`);
    }
    const phase = t >= 100 && t < 170 ? 'contraction' : t >= 370 && t < 460 ? 'relaxation' : null;
    if (phase && valveNames.every(name => flow.openness(name) <= .05)) {
      run = run ?? { phase, from: t, length: 0 };
      run.length++;
      // The leaflets are closed only while both of the beat's valve windows are closed too.
      assert.ok(!valvesAt(t).atrioventricular && !valvesAt(t).arterial, `all four leaflets closed at ${t} ms, inside a valve window`);
    } else if (run) { runs[run.phase].push(run); run = null; }
  }
  // 6 beats counted. Each isovolumic period has one stretch with all four closed. Measured with the 10 ms swing: 10-11 ms of the
  // 50 ms contraction period and 17-19 ms of the 80 ms relaxation period. The leaflets do not show the whole of either period.
  assert.equal(runs.contraction.length, 6, JSON.stringify(runs.contraction));
  assert.equal(runs.relaxation.length, 6, JSON.stringify(runs.relaxation));
  assert.ok(runs.contraction.every(r => r.length >= 8), `contraction: ${runs.contraction.map(r => `${r.from}+${r.length}`)}`);
  assert.ok(runs.relaxation.every(r => r.length >= 12), `relaxation: ${runs.relaxation.map(r => `${r.from}+${r.length}`)}`);
  assert.ok(worst <= .05);
});
