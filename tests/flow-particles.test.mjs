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
const kinds = ['atrioventricular', 'arterial'];
// Run the flow over whole beats in steps and report each crossing of a valve with the beat time at which it happened. A valve
// is crossed at two places: the wall in front of it (`wall`, where the particles wait for a closed valve) and the plane of its
// leaflets (`plane`, which the beat's counts use). `open` is how far the valve's leaflets were open at the start of the step.
function run(flow, beats) {
  const crossings = [];
  for (let ms = 0; ms < beats * period; ms += step) {
    const before = flow.routes.map(r => Float64Array.from(r.u)), open = Object.fromEntries(Object.keys(flow.valves).map(name => [name, flow.openness(name)]));
    flow.advance(ms, ms + step);
    flow.routes.forEach((r, ri) => {
      for (let i = 0; i < r.n; i++) {
        for (const kind of kinds) {
          const where = { wall: r.zone[kind].lo, plane: r.zone[kind].center };
          for (const [place, gate] of Object.entries(where)) {
            const count = passed(r, gate, before[ri][i], r.u[i]);
            if (count) crossings.push({ valve: kind, name: r.valve[kind], place, route: r.id, at: ms % period, beat: Math.floor(ms / period), count, open: open[r.valve[kind]] });
          }
        }
      }
    });
  }
  return crossings;
}
const total = (list, test) => list.filter(test).reduce((sum, c) => sum + c.count, 0);

test('there are particles on all six routes, and the ring never lets one overtake another or come closer than the gap', () => {
  const flow = createFlow(data);
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

test('no particle passes a closed valve: the wall in front of it holds while its window is closed, the leaflets are open whenever one crosses', () => {
  const crossings = run(createFlow(data), 4);
  assert.ok(crossings.length > 800);
  for (const c of crossings) {
    assert.ok(c.count > 0, 'a particle never moves backwards');
    if (c.place === 'wall') {
      // Compare against the valve state over the step in which the crossing happened (the start and the end of it).
      const open = [c.at, c.at + step - 1e-6].some(t => valvesAt(t)[c.valve]);
      assert.ok(open, `${c.route} passed the wall of the ${c.valve} valve at ${c.at} ms while its window was closed`);
    } else {
      assert.equal(c.open, 1, `${c.route} crossed the plane of the ${c.name} valve at ${c.at} ms with the leaflets ${c.open} open`);
    }
  }
  const atrial = cycle.atrialSystole, walls = crossings.filter(c => c.place === 'wall');
  assert.ok(total(walls, c => c.valve === 'atrioventricular' && c.at >= atrial && c.at < 450) === 0, 'nothing enters the atrioventricular valve from the start of ventricular systole to the end of isovolumic relaxation');
  assert.ok(total(walls, c => c.valve === 'arterial' && (c.at < 150 || c.at >= 370)) === 0, 'nothing enters the arterial valve outside the ejection');
});

test('every route moves blood in the order of the cycle: atria to ventricle, then ventricle to artery, the same amount each beat', () => {
  const crossings = run(createFlow(data), 10).filter(c => c.place === 'plane');
  for (const id of data.routes.map(r => r.id)) {
    const mine = crossings.filter(c => c.route === id);
    const filled = total(mine, c => c.valve === 'atrioventricular'), ejected = total(mine, c => c.valve === 'arterial');
    assert.ok(Math.abs(filled - ejected) <= 3, `${id}: ${filled} through the atrioventricular valve, ${ejected} through the arterial valve in 10 beats`);
    assert.ok(ejected >= 40, `${id}: only ${ejected} particles ejected in 10 beats`);
  }
  // The share of the filling that atrial systole delivers. OpenStax 19.3: the remaining 20 to 30%. The setting is 25%; with
  // 6 to 9 particles through a valve per beat the share comes in steps of about 11%, and measured 118 of 548 (21.5%) at bd65bd0; 130 of 532 (24.4%) with the leaflets (valves.mjs), whose zones change where particles wait.
  const atrial = total(crossings, c => c.valve === 'atrioventricular' && c.at < cycle.atrialSystole), all = total(crossings, c => c.valve === 'atrioventricular');
  assert.ok(atrial / all > .2 && atrial / all < .3, `${atrial} of ${all} (${(atrial / all * 100).toFixed(1)}%) came through in atrial systole`);
  // Ejected per beat against what the ventricular segment holds when full (its length over the gap): measured 64%.
  const capacity = createFlow(data).routes.reduce((sum, r) => sum + (r.arterial - r.av) / 4, 0), ejected = total(crossings, c => c.valve === 'arterial') / 10;
  assert.ok(ejected / capacity > .5 && ejected / capacity < .75, `${(ejected / capacity * 100).toFixed(1)}% of the ventricular segment is ejected per beat`);
});

// How far in front of the wall the front particle of a queue stands (negative: it has gone past the wall).
const shortOfWall = (wall, front) => wall - front;
test('blood waits behind a closed valve: just before the arterial valve opens the ventricular particles queue at the gap', () => {
  const flow = createFlow(data);
  flow.advance(0, 145);
  for (const r of flow.routes) {
    const queued = []; // arc positions of this route's particles in the ventricular segment
    const start = flow.routes.slice(0, flow.routes.indexOf(r)).reduce((sum, q) => sum + q.n, 0);
    for (let i = 0; i < r.n; i++) { const p = flow.arc(start + i); if (p >= r.av && p < r.zone.arterial.lo + 1e-3) queued.push(p); }
    queued.sort((a, b) => b - a);
    assert.ok(queued.length >= 8, `${r.id}: ${queued.length} particles in the ventricular segment`);
    const short = shortOfWall(r.zone.arterial.lo, queued[0]);
    assert.ok(short >= 0 && short < 1, `${r.id}: the front particle is ${short} mm short of the wall in front of the closed valve`);
    assert.ok(queued[0] - queued[1] < flow.settings.gap + 1, `${r.id}: the second is ${queued[0] - queued[1]} mm behind it`);
  }
  // The check itself: a queue standing 10 mm short of the wall, or past it, must fail it (review of PR #32: the first version of the
  // test had the sign the wrong way and accepted a queue that stopped far short).
  const accepts = short => short >= 0 && short < 1;
  assert.ok(accepts(shortOfWall(100, 99.5)));
  assert.ok(!accepts(shortOfWall(100, 90)), 'a queue 10 mm short is not accepted');
  assert.ok(!accepts(shortOfWall(100, 101)), 'a queue past the wall is not accepted');
});

test('the particles come back to the same places beat after beat, within one queue place, and do not move when time does not advance', () => {
  const flow = createFlow(data);
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
  const flow = createFlow(data), out = [0, 0, 0];
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
  const flow = createFlow(data);
  flow.advance(0, 448.4);
  // The particles waiting at the wall in front of the atrioventricular valve: the one nearest the wall in each route.
  const waiting = () => flow.routes.map(r => r.u.reduce((best, u) => { const p = u - Math.floor(u / r.length) * r.length; return p < r.zone.atrioventricular.lo && p > best ? p : best; }, 0));
  const queued = waiting();
  flow.advance(448.4, 449.99);
  // Still closed: whatever stands in front of the wall has not gone through it.
  flow.routes.forEach((r, i) => { const front = waiting()[i]; assert.ok(front < r.zone.atrioventricular.lo && front >= queued[i] - 1e-9, `${r.id}`); });
  const before = unwrapped(flow);
  flow.advance(449.99, 452.4);
  // After the opening only 2.41 ms of movement is possible for a particle that was waiting at the wall, and in that time it can
  // be no faster than in a valve's zone (the ejection speed, the fastest of the valve speeds). The leaflets are still opening,
  // so in fact it has not moved. Each route has such a particle (review of PR #32: the first version of this check looked at a
  // place that is no longer where the particles wait, and found no particle at all).
  let checked = 0;
  flow.routes.forEach((r, i) => {
    const start = flow.routes.slice(0, i).reduce((sum, q) => sum + q.n, 0);
    let here = 0;
    for (let n = 0; n < r.n; n++) {
      const u = before[start + n], p = u - Math.floor(u / r.length) * r.length;
      if (p > r.zone.atrioventricular.lo - 1e-3 && p < r.zone.atrioventricular.lo) {
        here++;
        assert.ok(r.u[n] - u <= r.speed.ejection * 2.41 + 1e-9, `${r.id}: a waiting particle moved ${r.u[n] - u} mm in 2.41 ms`);
      }
    }
    assert.equal(here, 1, `${r.id}: ${here} particles waiting at the wall at 449.99 ms`);
    checked += here;
  });
  assert.equal(checked, flow.routes.length);
  const atOnce = createFlow(data), split = createFlow(data);
  atOnce.advance(0, 148); split.advance(0, 148);
  atOnce.advance(148, 152); split.advance(148, 150); split.advance(150, 152);
  // Equal up to floating-point rounding (the two cut the time at slightly different binary fractions): measured 6e-14 mm.
  assert.ok(furthest(unwrapped(atOnce), unwrapped(split)) < 1e-9, 'a frame that spans the 150 ms valve opening equals the same time cut at 150 ms');
  // The same at every boundary and at fractional frame times.
  for (const boundary of [100, 150, 370, 450, 800]) {
    const x = createFlow(data), y = createFlow(data);
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
  // Issue #50 recheck (B3): the beat clock counts on across beats, so a one-beat play that starts after the beat has run on normally
  // (the setting turned on while the page is open) ends at the end of the beat it is in, not at the first beat's end (800 ms), which
  // ended it at once.
  assert.deepEqual(stepBeat(1200, 100, true), { next: 1300, done: false });
  assert.deepEqual(stepBeat(1550, 100, true), { next: 1600, done: true });
  assert.deepEqual(stepBeat(1600, 100, true), { next: 1700, done: false }, 'a play that starts on a beat boundary plays that whole beat');
  const exact = createFlow(data);
  exact.advance(0, period);
  for (const frame of [250, 16.7, 33.3, 790, 1000]) {
    const flow = createFlow(data);
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
  const unlimited = createFlow(data);
  for (let time = 0; time < period; time += 250) unlimited.advance(time, time + 250);
  assert.ok(furthest(unwrapped(unlimited), unwrapped(exact)) > 5, 'the unlimited order does differ visibly');
  // Pressing again plays the next beat from the same rest state: two presses equal two beats.
  const twice = createFlow(data), twoBeats = createFlow(data);
  for (let press = 0; press < 2; press++) { let time = 0, done = false; while (!done) { const step = stepBeat(time, 250, true); twice.advance(time, step.next); time = step.next; done = step.done; } }
  twoBeats.advance(0, 2 * period);
  assert.ok(furthest(unwrapped(twice), unwrapped(twoBeats)) < 1);
});
