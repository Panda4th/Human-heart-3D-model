import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeAnatomy } from '../src/anatomy.mjs';
import { createFlow } from '../src/flow.mjs';
import { cycle, period, stepBeat, valvesAt } from '../src/heartbeat.mjs';

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
  // 6 to 9 particles through a valve per beat the share comes in steps of about 11%, and measured 118 of 548 (21.5%) at bd65bd0 (117 of 547 before the steps were cut at the valve times).
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

// Unwrapped positions of all particles (the ring keeps counting past the end of a route), so that a lap does not look like a jump.
const unwrapped = flow => flow.routes.flatMap(r => Array.from(r.u));
const furthest = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('a step never crosses the time a valve changes: the result does not depend on where the frames fall', () => {
  // Review of PR #30: with a step of 4 ms judged by its middle, advance(448.4, 452.4) gave the 450 ms opening of the
  // atrioventricular valve 4 ms of movement instead of 2.4 ms, and 148 -> 152 differed by 0.36 mm from the split at 150.
  const flow = createFlow(data.routes);
  flow.advance(0, 448.4);
  const queued = flow.routes.map(r => r.u.reduce((best, u) => { const p = u - Math.floor(u / r.length) * r.length; return p < r.av && p > best ? p : best; }, 0));
  flow.advance(448.4, 449.99);
  // Still closed: whatever stands in front of the atrioventricular valve has not gone through it.
  flow.routes.forEach((r, i) => { const front = r.u.reduce((best, u) => { const p = u - Math.floor(u / r.length) * r.length; return p < r.av && p > best ? p : best; }, 0); assert.ok(front < r.av && front >= queued[i] - 1e-9, `${r.id}`); });
  const before = unwrapped(flow);
  flow.advance(449.99, 452.4);
  // After the opening only 2.4 ms of movement at the filling speed is possible for a particle that was waiting at the valve.
  flow.routes.forEach((r, i) => {
    const start = flow.routes.slice(0, i).reduce((sum, q) => sum + q.n, 0);
    for (let n = 0; n < r.n; n++) {
      const u = before[start + n], p = u - Math.floor(u / r.length) * r.length;
      if (p > r.av - 1e-3 && p < r.av) assert.ok(r.u[n] - u <= r.speed.passive * 2.41 + 1e-9, `${r.id}: a waiting particle moved ${r.u[n] - u} mm in 2.41 ms`);
    }
  });
  const atOnce = createFlow(data.routes), split = createFlow(data.routes);
  atOnce.advance(0, 148); split.advance(0, 148);
  atOnce.advance(148, 152); split.advance(148, 150); split.advance(150, 152);
  // Equal up to floating-point rounding (the two cut the time at slightly different binary fractions): measured 6e-14 mm.
  assert.ok(furthest(unwrapped(atOnce), unwrapped(split)) < 1e-9, 'a frame that spans the 150 ms valve opening equals the same time cut at 150 ms');
  // The same at every boundary and at fractional frame times.
  for (const boundary of [100, 150, 370, 450, 800]) {
    const x = createFlow(data.routes), y = createFlow(data.routes);
    x.advance(0, boundary - 1.7); y.advance(0, boundary - 1.7);
    x.advance(boundary - 1.7, boundary + 2.3); y.advance(boundary - 1.7, boundary); y.advance(boundary, boundary + 2.3);
    assert.ok(furthest(unwrapped(x), unwrapped(y)) < 1e-9, `boundary ${boundary} ms: ${furthest(unwrapped(x), unwrapped(y))} mm`);
  }
});

test('a one-beat play (reduced motion) moves the particles through that beat only, however long the last frame is', () => {
  // Review of PR #30: the particles were advanced before the clock was limited to the beat, so a 250 ms frame at 750 -> 1000 ms
  // moved them 200 ms into the next beat while the heart and the phase went back to 0.
  assert.deepEqual(stepBeat(750, 250, true), { next: 800, done: true });
  assert.deepEqual(stepBeat(300, 250, true), { next: 550, done: false });
  assert.deepEqual(stepBeat(750, 250, false), { next: 1000, done: false }, 'without the setting the clock runs on');
  const exact = createFlow(data.routes);
  exact.advance(0, period);
  for (const frame of [250, 16.7, 33.3, 790, 1000]) {
    const flow = createFlow(data.routes);
    let time = 0, done = false, frames = 0;
    while (!done && frames++ < 1000) {
      const step = stepBeat(time, frame, true);
      flow.advance(time, step.next);
      time = step.next; done = step.done;
    }
    assert.equal(time, period, `frame ${frame} ms`);
    // The frames cut the beat in other places than the single call does; the steps then differ a little (measured at most 0.5 mm).
    assert.ok(furthest(unwrapped(flow), unwrapped(exact)) < 1, `frame ${frame} ms: ${furthest(unwrapped(flow), unwrapped(exact))} mm from the particles after exactly one beat`);
  }
  // The order that was wrong: advance first, limit the clock after. The last 250 ms frame (750 -> 1000 ms) then moves the particles
  // 200 ms into the next beat, and the test above would fail for it.
  const unlimited = createFlow(data.routes);
  for (let time = 0; time < period; time += 250) unlimited.advance(time, time + 250);
  assert.ok(furthest(unwrapped(unlimited), unwrapped(exact)) > 5, 'the unlimited order does differ visibly');
  // Pressing again plays the next beat from the same rest state: two presses equal two beats.
  const twice = createFlow(data.routes), twoBeats = createFlow(data.routes);
  for (let press = 0; press < 2; press++) { let time = 0, done = false; while (!done) { const step = stepBeat(time, 250, true); twice.advance(time, step.next); time = step.next; done = step.done; } }
  twoBeats.advance(0, 2 * period);
  assert.ok(furthest(unwrapped(twice), unwrapped(twoBeats)) < 1);
});
