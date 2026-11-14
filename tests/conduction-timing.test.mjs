import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, period } from '../src/heartbeat.mjs';
import { conductionTimes, ecgAt, ecgBumps, glowAt, pulseAt, repolarizationWindow, sinusFire, stretchAt, stretchNameAt, stretches, stretchTextAt } from '../src/conduction-timing.mjs';

const lengths = { his: 10, bhis: 8, lbb: 60, rbb: 50 };

test('the four stretches follow the durations of the source and run one after another', () => {
  assert.deepEqual(conductionTimes, { atria: 50, avNode: 100, bundles: 25, purkinje: 75 });
  assert.equal(stretches.atria.length, 50);
  assert.equal(stretches.avNode.length, 100);
  assert.equal(stretches.bundles.length, 25);
  assert.equal(stretches.purkinje.length, 75);
  assert.equal(stretches.avNode.from, stretches.atria.to);
  assert.equal(stretches.bundles.from, stretches.avNode.to);
  assert.equal(stretches.purkinje.from, stretches.bundles.to);
});

test('the ventricles begin to contract when the Purkinje stretch begins, and the atria contract after the impulse has reached the AV node', () => {
  assert.equal(stretches.purkinje.from, cycle.atrialSystole);
  assert.equal(sinusFire, -75);
  // The impulse reaches the ventricular muscle before the ventricles contract, and the SA node fires before the atria contract.
  assert.ok(stretches.bundles.from <= cycle.atrialSystole);
  assert.ok(sinusFire < 0);
  // The whole impulse is over before the T wave begins, and the T wave ends with the ventricular systole.
  assert.ok(stretches.purkinje.to < repolarizationWindow.from);
  assert.equal(repolarizationWindow.to, cycle.atrialSystole + cycle.ventricularSystole);
  assert.equal(repolarizationWindow.length, 75);
});

test('the impulse is in exactly one stretch at a time, comes back every beat, and rests between', () => {
  for (let ms = -2 * period; ms < 3 * period; ms += 5) {
    const inside = Object.values(stretches).filter(s => stretchAt(s, ms).active).length;
    assert.ok(inside <= 1, `at ${ms} ms in ${inside} stretches`);
    assert.equal(stretchNameAt(ms), stretchNameAt(ms + period), `${ms} ms`);
  }
  assert.equal(stretchNameAt(-60), 'atria');
  assert.equal(stretchNameAt(0), 'avNode');
  assert.equal(stretchNameAt(80), 'bundles');
  assert.equal(stretchNameAt(120), 'purkinje');
  assert.equal(stretchNameAt(200), null);
  assert.equal(stretchNameAt(700), null);
  assert.equal(stretchNameAt(740), 'atria');
});

test('progress runs from 0 to 1 over a stretch and the age counts from its end', () => {
  const s = stretches.avNode;
  assert.equal(stretchAt(s, s.from).progress, 0);
  assert.ok(Math.abs(stretchAt(s, s.from + 50).progress - .5) < 1e-12);
  assert.equal(stretchAt(s, s.to + 30).age, 30);
  assert.equal(stretchAt(s, s.from + 10).age, -1);
});

test('the impulse goes down the His bundle, then along both branches, and reaches the end of each at the end of the stretch', () => {
  const at = ms => pulseAt(ms, lengths);
  const b = stretches.bundles;
  assert.ok(at(b.from + 1).his > 0 && at(b.from + 1).bhis === null && at(b.from + 1).lbb === null);
  // lengths 10 + 8 of 78: the first interval takes the first 3.2 ms of the 25, the second the next 2.6 ms.
  assert.ok(at(b.from + 3).his !== null && at(b.from + 4).his === null && at(b.from + 4).bhis !== null);
  assert.ok(at(b.from + 6).bhis === null && at(b.from + 6).lbb !== null);
  // The branches run in parallel and finish together.
  const late = at(b.to - .01);
  assert.ok(late.lbb > .99 && late.rbb > .99, `${late.lbb} ${late.rbb}`);
  assert.equal(late.lbb, late.rbb);
  // Order: the His bundle is done before the first interval of the branches starts.
  for (let ms = b.from; ms < b.to; ms += .5) {
    const p = at(ms);
    const live = ['his', 'bhis', 'lbb'].filter(k => p[k] !== null);
    assert.equal(live.length, 1, `at ${ms} ms: ${live}`);
  }
  assert.equal(at(b.to + 1).lbb, null);
  assert.equal(at(stretches.atria.from + 25).atria, .5);
  assert.equal(at(stretches.purkinje.from + 37.5).purkinje, .5);
});

test('parts glow while the impulse is in them and fade after it has left', () => {
  assert.equal(glowAt(-60, lengths).sa, 1);
  assert.equal(glowAt(0, lengths).av, 1);
  const after = glowAt(stretches.avNode.to + 120, lengths).av;
  assert.ok(Math.abs(after - Math.exp(-1)) < 1e-12);
  assert.equal(glowAt(stretches.avNode.to + 400, lengths).av, 0);
  assert.equal(glowAt(120, lengths).purkinje, 1);
});

test('every moment of the beat has a screen text', () => {
  for (let ms = 0; ms < period; ms += 7) assert.match(stretchTextAt(ms), /^刺激：/);
  assert.match(stretchTextAt(0), /房室結節/);
  assert.match(stretchTextAt(340), /T波/);
});

test('the schematic ECG has its waves on the stretches of the impulse and is flat outside them', () => {
  const peak = (from, to) => { let best = [from, -Infinity]; for (let ms = from; ms <= to; ms += .25) if (ecgAt(ms) > best[1]) best = [ms, ecgAt(ms)]; return best; };
  const p = peak(sinusFire - 20, stretches.atria.to + 20);
  assert.ok(p[0] >= stretches.atria.from && p[0] <= stretches.atria.to, `P peaks at ${p[0]}`);
  const r = peak(stretches.bundles.from, stretches.purkinje.to);
  assert.ok(Math.abs(r[0] - cycle.atrialSystole) < 1, `R peaks at ${r[0]}`);
  assert.ok(r[1] > .9);
  const t = peak(stretches.purkinje.to, period - 100);
  assert.ok(t[0] >= repolarizationWindow.from && t[0] <= repolarizationWindow.to, `T peaks at ${t[0]}`);
  // R is by far the highest, and the P and T waves are small and upright.
  assert.ok(p[1] < .3 && t[1] < .4 && p[1] > .1 && t[1] > .2);
  // Outside the three waves the trace is on the baseline (the PR segment is the AV node's wait).
  const quiet = [[stretches.atria.to + 8, stretches.bundles.from - 5], [stretches.purkinje.to + 5, repolarizationWindow.from - 25], [repolarizationWindow.to + 25, period + sinusFire - 25]];
  for (const [from, to] of quiet) for (let ms = from; ms <= to; ms += 1) assert.ok(Math.abs(ecgAt(ms)) < .03, `${ms} ms: ${ecgAt(ms)}`);
  // It repeats every beat, and the P wave of the next beat sits in the end of this one (the wave is in the beat clock's wrap).
  assert.ok(Math.abs(ecgAt(30) - ecgAt(30 + period)) < 1e-12);
  assert.ok(ecgAt(period + sinusFire + 25) > .15);
});

test('the ECG is made of five named bumps', () => {
  assert.deepEqual(ecgBumps.map(b => b.name), ['P', 'Q', 'R', 'S', 'T']);
});
