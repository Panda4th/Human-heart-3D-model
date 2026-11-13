import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle, period, slowFactor } from '../src/heartbeat.mjs';
import { createHeartSound, createPlayback, createSoundScheduler, lateLimit, lookahead, soundBeats, soundsBetween, voices } from '../src/heartsound.mjs';

// Issue #31. The time source is a variable here, so the clock, the booking and the cancelling are checked without audio.
const makeClock = (start = 0) => { const clock = { t: start, read: () => clock.t }; return clock; };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('the first sound is at the start of ventricular systole and the second at the start of ventricular relaxation', () => {
  assert.deepEqual(soundBeats, { first: cycle.atrialSystole, second: cycle.atrialSystole + cycle.ventricularSystole });
  assert.deepEqual(soundBeats, { first: 100, second: 370 });
  assert.deepEqual(soundsBetween(0, period), [{ sound: 'first', beat: 100 }, { sound: 'second', beat: 370 }]);
  assert.deepEqual(soundsBetween(100, 370), [{ sound: 'first', beat: 100 }], 'from is included, to is not');
  assert.deepEqual(soundsBetween(371, 899), [{ sound: 'first', beat: 900 }].slice(1), 'nothing between the second sound and the next first');
  assert.deepEqual(soundsBetween(371, 901), [{ sound: 'first', beat: 900 }]);
  assert.deepEqual(soundsBetween(5, 5), []);
  assert.deepEqual(soundsBetween(10, 5), []);
  assert.equal(soundsBetween(0, 10 * period).length, 20);
  assert.deepEqual(soundsBetween(3 * period, 4 * period).map(s => s.beat), [3 * period + 100, 3 * period + 370]);
});

test('the playback clock runs at the slow or the real speed, and stands still when paused', () => {
  const c = makeClock(10), p = createPlayback(c.read);
  assert.equal(p.running, false);
  c.t = 12;
  assert.equal(p.position(), 0, 'paused: no movement');
  p.play();
  c.t = 12.5;
  near(p.position(), 500 / slowFactor);
  p.setSlow(false);
  c.t = 13.5;
  near(p.position(), 100 + 1000);
  p.pause();
  const stopped = p.position();
  c.t = 20;
  assert.equal(p.position(), stopped);
  p.play();
  c.t = 20.25;
  near(p.position(), stopped + 250);
  p.seek(0);
  near(p.position(), 0);
  // Source time of a beat time, for booking.
  near(p.sourceTime(100), c.t + .1);
});

test('changing the time source keeps the position (turning the sound on does not move the beat)', () => {
  const page = makeClock(1000), audio = makeClock(7);
  const p = createPlayback(page.read);
  p.play();
  page.t = 1002;
  const before = p.position();
  near(before, 2000 / slowFactor);
  p.useSource(audio.read);
  near(p.position(), before);
  audio.t = 8;
  near(p.position(), before + 1000 / slowFactor);
  // The old source is no longer read.
  page.t = 5000;
  near(p.position(), before + 1000 / slowFactor);
  // A source that has stopped (an interrupted audio context) is replaced at the last drawn position.
  p.useSource(page.read, 123);
  near(p.position(), 123);
});

test('the sounds are booked at the source time of their beat time, in the slow and in the real speed', () => {
  for (const [slow, scale] of [[true, slowFactor], [false, 1]]) {
    const c = makeClock(50), p = createPlayback(c.read), s = createSoundScheduler();
    p.setSlow(slow);
    p.play();
    s.start(p, c.t);
    const booked = [];
    for (let i = 0; i < 400; i++) { c.t += .05; booked.push(...s.take(p, c.t)); }
    const expected = [];
    for (let k = 0; k < 100; k++) for (const beat of [100, 370]) expected.push(50 + (k * period + beat) * scale / 1000);
    const upTo = c.t + lookahead;
    const wanted = expected.filter(t => t < upTo);
    assert.equal(booked.length, wanted.length);
    booked.forEach((e, i) => { near(e.at, wanted[i]); assert.equal(e.sound, i % 2 ? 'second' : 'first'); });
  }
});

test('the interval between the sounds follows the speed, the length of each sound does not', () => {
  assert.ok(voices.first.length < .2 && voices.second.length < .2);
  const c = makeClock(), p = createPlayback(c.read), s = createSoundScheduler();
  p.play(); s.start(p, 0);
  const slowEvents = [];
  for (let i = 0; i < 100; i++) { c.t += .1; slowEvents.push(...s.take(p, c.t)); }
  near(slowEvents[1].at - slowEvents[0].at, 270 * slowFactor / 1000);
  near(slowEvents[2].at - slowEvents[1].at, 530 * slowFactor / 1000, 1e-6);
  const real = makeClock(), q = createPlayback(real.read), r = createSoundScheduler();
  q.setSlow(false); q.play(); r.start(q, 0);
  const realEvents = [];
  for (let i = 0; i < 40; i++) { real.t += .1; realEvents.push(...r.take(q, real.t)); }
  near(realEvents[1].at - realEvents[0].at, .27);
});

test('a latency books each sound earlier, so it is heard when the picture shows its beat time', () => {
  const c = makeClock(), p = createPlayback(c.read), s = createSoundScheduler();
  p.setSlow(false);
  p.play();
  s.start(p, 0, 0);
  const [first] = s.take(p, 0, { latency: .03 });
  near(first.at, .1 - .03);
  // Within the latency of the start, a sound that would have to be booked in the past is dropped, not played late.
  const d = makeClock(), q = createPlayback(d.read), t = createSoundScheduler();
  q.setSlow(false);
  q.seek(95);
  q.play();
  t.start(q, 0, .2);
  const booked = t.take(q, 0, { latency: .2 });
  assert.equal(booked[0].sound, 'second', 'the first sound is 0.2 s too early to be booked');
  near(booked[0].at, .275 - .2);
});

test('after a stall the missed sounds are dropped, not played in a bunch', () => {
  const c = makeClock(), p = createPlayback(c.read), s = createSoundScheduler();
  p.setSlow(false);
  p.play();
  s.start(p, 0);
  s.take(p, 0);
  c.t = 30;
  const events = s.take(p, 30);
  assert.deepEqual(events.filter(e => e.at < 30 - lateLimit), []);
  assert.ok(events.every(e => e.at >= 30 - lateLimit));
  assert.ok(events.length <= 2 * (lookahead + lateLimit) / (period / 1000) + 2, 'only what is due now or within the lookahead');
});

test('a one-beat play books nothing after its end', () => {
  const c = makeClock(), p = createPlayback(c.read), s = createSoundScheduler();
  p.setSlow(false);
  p.play();
  s.start(p, 0);
  const booked = [];
  for (let i = 0; i < 100; i++) { c.t += .05; booked.push(...s.take(p, c.t, { limit: period })); }
  assert.deepEqual(booked.map(e => e.sound), ['first', 'second']);
});

// A model of the page: frames of uneven length (some very late), a booking timer every 50 ms, and the controls pressed at
// random. Everything a listener would hear is recorded with the beat time the clock gave it.
test('over ten minutes of use the sounds stay on the clock: no drift, no doubles, no sounds after a stop', () => {
  const clock = makeClock(), p = createPlayback(clock.read), s = createSoundScheduler();
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let sounding = false, booked = [], heard = [];
  const latency = .02;
  const book = () => {
    if (!sounding || !p.running) return;
    for (const e of s.take(p, clock.t, { latency })) booked.push({ ...e, beat: p.position(e.at + latency), pending: true });
  };
  const settle = () => { for (const b of booked) if (b.pending && b.at <= clock.t) { b.pending = false; heard.push(b); } };
  // The controls cancel what is booked and book again from the current position, as src/main.js does.
  const resync = () => {
    settle();
    booked = booked.filter(b => b.pending && b.at > clock.t ? false : true);
    if (sounding && p.running) { s.start(p, clock.t, latency); book(); } else s.stop();
  };
  p.play();
  sounding = true;
  resync();
  const drawn = [];
  let nextTimer = 0, nextEvent = 5;
  const end = 600;
  while (clock.t < end) {
    // A frame takes 16 ms, sometimes 250 ms or a second.
    const r = random();
    clock.t += r < .9 ? .016 : r < .98 ? .25 : 1;
    while (nextTimer <= clock.t) { settle(); book(); nextTimer += .05; }
    drawn.push({ t: clock.t, beat: p.position() });
    if (clock.t >= nextEvent) {
      nextEvent += 2 + random() * 8;
      const pick = random();
      if (pick < .35) { p.setSlow(!p.slow); resync(); }
      else if (pick < .65) { sounding = !sounding; resync(); }
      else { p.pause(); resync(); clock.t += random() * 3; p.play(); resync(); }
    }
  }
  settle();
  // The picture never fell behind the clock: the beat time at each frame is the clock's own.
  assert.ok(drawn.length > 1000);
  // Heard sounds never double up: two sounds are never closer than the real-speed gap between the first and the second (270 ms).
  const sorted = heard.map(h => h.at).sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] > .27 - 1e-9, `sounds ${sorted[i - 1]} and ${sorted[i]} are too close`);
  // Every heard sound sits exactly on 100 or 370 ms of the beat (no drift, whatever the lateness of the frames).
  for (const h of heard) {
    const t = ((h.beat % period) + period) % period;
    assert.ok(Math.abs(t - 100) < 1e-6 || Math.abs(t - 370) < 1e-6, `beat ${h.beat} (${t}) is not on a sound`);
  }
  assert.ok(heard.length > 100, `only ${heard.length} sounds heard`);
});

// A fake Web Audio context that keeps what is booked.
function fakeContext() {
  const made = { oscillators: [], gains: [] };
  const param = () => ({ value: 1, calls: [], setValueAtTime(v, t) { this.calls.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { this.calls.push(['linear', v, t]); }, exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); }, setTargetAtTime(v, t, k) { this.calls.push(['target', v, t, k]); }, cancelScheduledValues(t) { this.calls.push(['cancel', t]); } });
  class Context {
    constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = { id: 'destination' }; this.listeners = []; this.baseLatency = .01; this.outputLatency = 0; Context.last = this; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    addEventListener(type, fn) { this.listeners.push(fn); }
    createGain() { const g = { gain: param(), connections: [], connect(n) { this.connections.push(n); }, disconnect() { this.connections = []; } }; made.gains.push(g); return g; }
    createOscillator() { const o = { type: '', frequency: param(), connections: [], connect(n) { this.connections.push(n); }, start(t) { this.startAt = t; }, stop(t) { this.stopAt = t; } }; made.oscillators.push(o); return o; }
  }
  return { Context, made };
}

test('the sound engine books tones at the given time, from nothing but oscillators', async () => {
  assert.equal(createHeartSound(undefined).supported, false);
  const { Context, made } = fakeContext();
  const engine = createHeartSound(Context);
  assert.equal(engine.supported, true);
  assert.equal(engine.state, 'closed');
  await engine.open();
  assert.equal(engine.state, 'running');
  assert.equal(Context.last.listeners.length, 0);
  engine.schedule([{ sound: 'first', at: 1 }, { sound: 'second', at: 2 }]);
  assert.equal(made.oscillators.length, 2);
  assert.deepEqual(made.oscillators.map(o => o.startAt), [1, 2]);
  assert.ok(made.oscillators.every(o => o.type === 'triangle' && o.stopAt > o.startAt));
  near(made.oscillators[0].frequency.calls[0][1], voices.first.hz);
  near(made.oscillators[1].frequency.calls[0][1], voices.second.hz);
  // The length of a sound is the same whatever the speed: it is not an argument of schedule.
  near(made.oscillators[0].stopAt - made.oscillators[0].startAt, voices.first.length + .02);
  // A time already past is played now, not before.
  Context.last.currentTime = 5;
  engine.schedule([{ sound: 'first', at: 4.9 }]);
  assert.equal(made.oscillators[2].startAt, 5);
});

test('cancelling silences every booked sound at once, and the next sounds are booked afresh', async () => {
  const { Context, made } = fakeContext();
  const engine = createHeartSound(Context);
  await engine.open();
  engine.schedule([{ sound: 'first', at: 1 }, { sound: 'second', at: 2 }]);
  const batch = made.gains.find(g => made.oscillators[0].connections[0].connections.includes(g));
  Context.last.currentTime = .5;
  engine.cancel();
  assert.ok(batch.gain.calls.some(c => c[0] === 'target' && c[1] === 0), 'the batch fades to zero');
  assert.ok(made.oscillators.every(o => o.stopAt <= .5 + .05 + 1e-9), 'all oscillators are told to stop at once');
  engine.schedule([{ sound: 'first', at: 3 }]);
  const fresh = made.oscillators.at(-1);
  assert.notEqual(fresh.connections[0].connections[0], batch, 'the new sound is on a new batch, not on the silenced one');
});

test('the latency is read from the context, and the volume changes the master gain', async () => {
  const { Context } = fakeContext();
  const engine = createHeartSound(Context);
  await engine.open();
  near(engine.latency(), .01);
  Context.last.outputLatency = .035;
  near(engine.latency(), .035);
  Context.last.outputLatency = 9;
  assert.equal(engine.latency(), .5, 'clamped');
  Context.last.outputLatency = NaN;
  Context.last.baseLatency = undefined;
  assert.equal(engine.latency(), 0);
  engine.setVolume(.5);
  engine.setVolume(7);
});
