import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAnatomy } from '../src/anatomy.mjs';
import { createFlow } from '../src/flow.mjs';
import { cycle, period, valvesAt } from '../src/heartbeat.mjs';

// The particles of the blood-flow view (src/flow.mjs). These tests check what the module does with the generated routes:
// that the particles follow the beat's valve windows, queue behind closed valves and keep their order. They do not show that
// the speeds are physiological (they are display values) or that the routes are right (flow.test.mjs and the README say what
// is checked there).
const { flow: data } = decodeAnatomy(new Uint8Array(readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)))).meta;
const step = 2;

// Laps a particle has completed past a gate between two unwrapped positions (the ring makes positions unwrapped).
const passed = (r, gate, a, b) => Math.floor((b - gate) / r.length) - Math.floor((a - gate) / r.length);
// Run the flow over whole beats in steps and report each valve crossing with the beat time at which it happened.
function run(flow, beats) {
  const crossings = [];
  for (let ms = 0; ms < beats * period; ms += step) {
    const before = flow.routes.map(r => Float64Array.from(r.u));
    flow.advance(ms, ms + step);
    flow.routes.forEach((r, ri) => {
      for (let i = 0; i < r.n; i++) {
        const av = passed(r, r.av, before[ri][i], r.u[i]), arterial = passed(r, r.arterial, before[ri][i], r.u[i]);
        if (av) crossings.push({ valve: 'atrioventricular', route: r.id, at: ms % period, beat: Math.floor(ms / period), count: av });
        if (arterial) crossings.push({ valve: 'arterial', route: r.id, at: ms % period, beat: Math.floor(ms / period), count: arterial });
      }
    });
  }
  return crossings;
}
const total = (list, test) => list.filter(test).reduce((sum, c) => sum + c.count, 0);

test('there are particles on all six routes, and the ring never lets one overtake another or come closer than the gap', () => {
  const flow = createFlow(data.routes);
  assert.deepEqual(flow.routes.map(r => r.id), data.routes.map(r => r.id));
  assert.ok(flow.count > 150 && flow.count < 400, `${flow.count} particles`);
  for (let ms = 0; ms < 2 * period; ms += 8) {
    flow.advance(ms, ms + 8);
    for (const r of flow.routes) {
      for (let i = 0; i < r.n; i++) {
        const leader = i === 0 ? r.u[r.n - 1] + r.length : r.u[i - 1];
        assert.ok(leader - r.u[i] >= flow.settings.gap - 1e-6, `${r.id} ${i}: ${leader - r.u[i]} mm behind its leader at ${ms} ms`);
      }
    }
  }
  let k = 0;
  for (const r of flow.routes) for (let i = 0; i < r.n; i++, k++) assert.ok(flow.arc(k) >= 0 && flow.arc(k) < r.length, `${r.id} ${i}`);
});

test('no particle passes a closed valve: atrioventricular only in atrial systole and the filling, arterial only in the ejection', () => {
  const crossings = run(createFlow(data.routes), 4);
  assert.ok(crossings.length > 400);
  const atrial = cycle.atrialSystole;
  for (const c of crossings) {
    assert.ok(c.count > 0, 'a particle never moves backwards');
    // Compare against the valve state over the step in which the crossing happened (the start and the end of it).
    const open = [c.at, c.at + step - 1e-6].some(t => valvesAt(t)[c.valve]);
    assert.ok(open, `${c.route} crossed the ${c.valve} valve at ${c.at} ms while it was closed`);
  }
  assert.ok(total(crossings, c => c.valve === 'atrioventricular' && c.at >= atrial && c.at < 450) === 0, 'nothing crosses from the start of ventricular systole to the end of isovolumic relaxation');
  assert.ok(total(crossings, c => c.valve === 'arterial' && (c.at < 150 || c.at >= 370)) === 0, 'nothing crosses the arterial valve outside the ejection');
});

test('every route moves blood in the order of the cycle: atria to ventricle, then ventricle to artery, the same amount each beat', () => {
  const crossings = run(createFlow(data.routes), 10);
  for (const id of data.routes.map(r => r.id)) {
    const mine = crossings.filter(c => c.route === id);
    const filled = total(mine, c => c.valve === 'atrioventricular'), ejected = total(mine, c => c.valve === 'arterial');
    assert.ok(Math.abs(filled - ejected) <= 3, `${id}: ${filled} through the atrioventricular valve, ${ejected} through the arterial valve in 10 beats`);
    assert.ok(ejected >= 40, `${id}: only ${ejected} particles ejected in 10 beats`);
  }
  // The share of the filling that atrial systole delivers. OpenStax 19.3: the remaining 20 to 30%. The setting is 25%; with
  // 6 to 9 particles through a valve per beat the share comes in steps of about 11%, and measured 117 of 547 (21.4%).
  const atrial = total(crossings, c => c.valve === 'atrioventricular' && c.at < cycle.atrialSystole), all = total(crossings, c => c.valve === 'atrioventricular');
  assert.ok(atrial / all > .2 && atrial / all < .3, `${atrial} of ${all} (${(atrial / all * 100).toFixed(1)}%) came through in atrial systole`);
  // Ejected per beat against what the ventricular segment holds when full (its length over the gap): measured 64%.
  const capacity = createFlow(data.routes).routes.reduce((sum, r) => sum + (r.arterial - r.av) / 4, 0), ejected = total(crossings, c => c.valve === 'arterial') / 10;
  assert.ok(ejected / capacity > .5 && ejected / capacity < .75, `${(ejected / capacity * 100).toFixed(1)}% of the ventricular segment is ejected per beat`);
});

test('blood waits behind a closed valve: just before the arterial valve opens the ventricular particles queue at the gap', () => {
  const flow = createFlow(data.routes);
  flow.advance(0, 145);
  for (const r of flow.routes) {
    const queued = []; // arc positions of this route's particles in the ventricular segment
    const start = flow.routes.slice(0, flow.routes.indexOf(r)).reduce((sum, q) => sum + q.n, 0);
    for (let i = 0; i < r.n; i++) { const p = flow.arc(start + i); if (p >= r.av && p < r.arterial) queued.push(p); }
    queued.sort((a, b) => b - a);
    assert.ok(queued.length >= 8, `${r.id}: ${queued.length} particles in the ventricular segment`);
    assert.ok(r.arterial - queued[0] < 1, `${r.id}: the front particle is ${r.arterial - queued[0]} mm from the closed valve`);
    assert.ok(queued[0] - queued[1] < flow.settings.gap + 1, `${r.id}: the second is ${queued[0] - queued[1]} mm behind it`);
  }
});

test('the particles come back to the same places beat after beat, within one queue place, and do not move when time does not advance', () => {
  const flow = createFlow(data.routes);
  // One particle does not come back to its own place after a beat; it takes the place of the one ahead. So compare the places.
  const places = () => flow.routes.map((r, ri) => {
    const start = flow.routes.slice(0, ri).reduce((sum, q) => sum + q.n, 0);
    return Array.from({ length: r.n }, (_, i) => flow.arc(start + i)).sort((a, b) => a - b);
  });
  flow.advance(0, 3 * period);
  const a = places();
  flow.advance(3 * period, 4 * period);
  const b = places();
  // How far the nearest place of the earlier beat is, for each place of the later one, around the ring (largest over all
  // places). Measured over 12 beats: 4.00 mm (one gap) in 11 of them and 3.41 in one. The beat does not repeat exactly because a
  // queue holds a whole number of particles and can differ by one place from one beat to the next; it does not drift.
  const worst = Math.max(...b.flatMap((route, ri) => route.map(p => {
    const length = flow.routes[ri].length;
    return Math.min(...a[ri].map(q => { const d = Math.abs(p - q); return Math.min(d, length - d); }));
  })));
  assert.ok(worst <= flow.settings.gap + .5, `a place is ${worst} mm from where it was one beat earlier`);
  flow.advance(5, 5);
  flow.advance(900, 100);
  assert.deepEqual(places(), b, 'an empty or backwards interval moves nothing');
});

test('sample puts a particle on its route, shrinks it towards the ends of the route, and names its side', () => {
  const flow = createFlow(data.routes), out = [0, 0, 0];
  let k = 0;
  for (const r of flow.routes) {
    const route = data.routes.find(q => q.id === r.id);
    for (let i = 0; i < r.n; i++, k++) {
      const size = flow.sample(k, out), p = flow.arc(k);
      assert.equal(flow.side(k), route.side);
      assert.ok(size >= 0 && size <= 1);
      if (p > 12 && p < r.length - 12) assert.equal(size, 1);
      // On the polyline: the point is at the right distance between the two route points around its arc length.
      const j = r.cum.findIndex(c => c > p), a = route.points[j - 1], b = route.points[j];
      const f = (p - r.cum[j - 1]) / (r.cum[j] - r.cum[j - 1]);
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(out[axis] - (a[axis] + (b[axis] - a[axis]) * f)) < 1e-9);
    }
  }
  assert.equal(k, flow.count);
});
