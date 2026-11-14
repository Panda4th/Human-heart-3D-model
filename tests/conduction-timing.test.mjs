import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, period } from '../src/heartbeat.mjs';
import { readFileSync } from 'node:fs';
import { decodeAnatomy } from '../src/anatomy.mjs';
import { createConductionPulse } from '../src/conduction.mjs';
import { bundleSplit, conductionTimes, ecgAt, ecgBumps, fade, glowAt, partWindows, pulseAt, repolarizationWindow, sinusFire, stretchAt, stretchNameAt, stretches, stretchTextAt, waveAge } from '../src/conduction-timing.mjs';

const lengths = { his: 10, bhis: 8, lbb: 60, rbb: 50 };
// The arc lengths of the paths of the generated data, as the viewer uses them.
const realLengths = createConductionPulse(decodeAnatomy(new Uint8Array(readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)))).meta.conduction).lengths;

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

// Review of PR #49: the glow must not run ahead of the head. In the bundle stretch the impulse is in the His bundle, then in the
// branching interval, then in both branches; each part glows only from the moment the head reaches it.
for (const [name, l] of [['test lengths', lengths], ['the lengths of the data', realLengths]]) {
  test(`the glow follows the head through the bundle parts in order (${name})`, () => {
    const b = stretches.bundles, w = partWindows(l), split = bundleSplit(l);
    // The windows tile the stretch: His, then branching interval, then both branches together.
    assert.equal(w.his.from, b.from);
    assert.ok(Math.abs(w.his.to - w.bhis.from) < 1e-9 && Math.abs(w.bhis.to - w.lbb.from) < 1e-9);
    assert.ok(Math.abs(w.lbb.to - b.to) < 1e-9 && w.lbb.from === w.rbb.from && w.lbb.to === w.rbb.to);
    assert.ok(split.his[1] > 0 && split.bhis[1] < 1);
    // Before the head reaches a part it does not glow: while the head is only in the His bundle, the three others are dark; while it
    // is in the branching interval, both branches are dark.
    const inHis = (w.his.from + w.his.to) / 2, inBhis = (w.bhis.from + w.bhis.to) / 2, inBranches = (w.lbb.from + w.lbb.to) / 2;
    for (const id of ['bhis', 'lbb', 'rbb']) assert.equal(glowAt(inHis, l)[id], 0, `${id} while the head is in the His bundle`);
    for (const id of ['lbb', 'rbb']) assert.equal(glowAt(inBhis, l)[id], 0, `${id} while the head is in the branching interval`);
    assert.equal(glowAt(w.his.from, l).his, 1, 'the His bundle glows when the head enters it');
    assert.equal(glowAt(inBhis, l).bhis, 1);
    assert.equal(glowAt(inBranches, l).lbb, 1);
    assert.equal(glowAt(inBranches, l).rbb, 1);
    // The head and the glow agree at every instant of the stretch and of the beat: a part with the head in it is fully lit, and a
    // part the head has not reached in this beat is dark unless it is still fading from the beat before.
    for (let ms = b.from - 1; ms < b.to + 1; ms += .05) {
      const head = pulseAt(ms, l), glow = glowAt(ms, l);
      for (const id of ['his', 'bhis', 'lbb', 'rbb']) {
        if (head[id] !== null) assert.equal(glow[id], 1, `${id} at ${ms} ms`);
        // 1e-6 ms of slack: the loop's own rounding (a step of 0.05 ms) can land a hair before the start and wrap to the start of the beat.
        if (ms < w[id].from - 1e-6) assert.ok(glow[id] < Math.exp(-(period - (w[id].from - ms) - w[id].length) / fade) + 1e-9, `${id} lit before the head, at ${ms} ms`);
      }
    }
    // After the head has left a part its glow fades from the moment of leaving that part (not from the end of the stretch), and the
    // same shape comes back in every beat.
    for (const id of ['his', 'bhis', 'lbb', 'rbb']) {
      for (const dt of [10, 60, 120, 240]) {
        const ms = w[id].to + dt;
        assert.ok(Math.abs(glowAt(ms, l)[id] - Math.exp(-dt / fade)) < 1e-9, `${id} ${dt} ms after it`);
        assert.ok(Math.abs(glowAt(ms + 5 * period, l)[id] - glowAt(ms, l)[id]) < 1e-9, `${id} repeats`);
      }
      assert.equal(glowAt(w[id].to + 3 * fade + 1, l)[id], 0);
    }
    // The part that the head leaves first fades first: His bundle < branching interval < branches, in the same time after leaving
    // (they leave one after the other), so at the end of the stretch they are in order of brightness.
    const end = glowAt(b.to + .001, l);
    assert.ok(end.his < end.bhis && end.bhis <= end.lbb, JSON.stringify(end));
  });
}

// Review of PR #49: the labels of the ECG are found from the beat time, which keeps growing while the beat plays.
test('the age of a wave in the strip depends only on where the beat time is within the beat, however many beats have played', () => {
  const [minAge, maxAge] = [6 / .276, (276 - 6) / .276];
  for (const bump of ecgBumps.filter(b => ['P', 'R', 'T'].includes(b.name))) {
    for (const base of [0, 30, 105, 340, 405, 740, 799]) {
      const first = waveAge(base, bump.mean, minAge, maxAge);
      for (const beats of [1, 2, 3, 4, 10, 100, 1000]) {
        const later = waveAge(base + beats * period, bump.mean, minAge, maxAge);
        assert.ok(first === later || Math.abs(first - later) < 1e-6, `${bump.name} at ${base} + ${beats} beats: ${first} vs ${later}`);
      }
    }
  }
  // The newest occurrence is chosen, and it is a real occurrence of the wave: its time is `mean` plus whole beats.
  const age = waveAge(8400 + 400, ecgBumps[2].mean, minAge, maxAge);
  assert.ok(age >= minAge && age <= maxAge);
  assert.ok(Math.abs(((8800 - age - ecgBumps[2].mean) / period) - Math.round((8800 - age - ecgBumps[2].mean) / period)) < 1e-9);
  // The strip is 1000 ms wide and a beat 800 ms: every wave is in view at every beat time except when it has just been drawn at the
  // very edge, and none is when the window is too short for it.
  for (let ms = 0; ms < 5 * period; ms += 7) for (const bump of ecgBumps.filter(b => ['P', 'R', 'T'].includes(b.name))) assert.notEqual(waveAge(ms + 40000, bump.mean, minAge, maxAge), null, `${bump.name} at ${ms}`);
  assert.equal(waveAge(1000, 500, 5, 100), null);
});

// Issue #50 (C2/F1): the durations are written out in the screen text too. A change of a constant must not leave the old number there.
test('the screen text gives the durations of the four stretches as the constants say', async () => {
  const { stretchText } = await import('../src/conduction-timing.mjs');
  const template = readFileSync(new URL('../src/template.html', import.meta.url), 'utf8');
  const seconds = ms => `約${ms / 1000}秒`;
  for (const [name, ms] of Object.entries(conductionTimes)) assert.ok(stretchText[name].includes(seconds(ms)), `${name}: ${stretchText[name]}`);
  const note = /<p class="note" id="propagation-note"[^>]*>([^<]*)<\/p>/.exec(template)[1];
  assert.ok(note.includes(`洞房結節から心房へ${seconds(conductionTimes.atria)}`), note);
  assert.ok(note.includes(`房室結節で${seconds(conductionTimes.avNode)}`), note);
  assert.ok(note.includes(`心尖へ${seconds(conductionTimes.bundles)}`), note);
  assert.ok(note.includes(`心室の筋へ${seconds(conductionTimes.purkinje)}`), note);
  const total = Object.values(conductionTimes).reduce((a, b) => a + b, 0);
  assert.ok(note.includes(`4つの区間を足すと${total}ミリ秒`), note);
  assert.ok(note.includes(`約${-sinusFire / 1000}秒前に発火`), note);
});
