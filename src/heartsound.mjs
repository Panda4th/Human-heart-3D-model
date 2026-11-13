import { cycle, period, slowFactor } from './heartbeat.mjs';

// Synthetic heart sounds that follow the explanatory beat (Issue #31). Kept free of the browser so Node tests can check the
// timing: the Web Audio part takes the context class as an argument.
//
// One clock decides everything. The playback clock maps a time source (seconds) to the beat time (ms). The picture reads the
// beat time from it on every frame, and the sounds are booked at the source times it gives for their beat times. A late
// frame therefore never moves the sounds: the next frame draws whatever state the clock is at.
//
// The sounds: the first sound at the start of ventricular systole (the atrioventricular valves close), the second at the
// start of ventricular relaxation (the arterial valves close), as in NHLBI "How the Heart Beats". They match the explanatory
// beat in heartbeat.mjs; they do not claim that the valve meshes move.
export const soundBeats = { first: cycle.atrialSystole, second: cycle.atrialSystole + cycle.ventricularSystole };
// Seconds of the time source booked ahead; a booked sound is cancelled and booked again whenever the clock changes.
export const lookahead = .5;
// A sound that should already have started more than this many seconds ago is dropped, never played late or in a bunch.
export const lateLimit = .04;
export const maxLatency = .5;

// Sounds whose beat time lies in [from, to), in order. The beat repeats every `period`.
export function soundsBetween(from, to) {
  const out = [];
  if (!(to > from)) return out;
  for (let k = Math.floor(from / period); k * period < to; k++) {
    for (const [sound, beat] of Object.entries(soundBeats)) {
      const t = k * period + beat;
      if (t >= from && t < to) out.push({ sound, beat: t });
    }
  }
  return out;
}

// The beat time as a function of a time source. `source` returns seconds (performance.now() / 1000, or the audio context's
// currentTime). The beat time is not wrapped: it keeps growing, so a caller can tell the end of a one-beat play.
// While paused the position is fixed; changing the speed or the source starts from the current position.
export function createPlayback(source) {
  let read = source, running = false, slow = true, anchorSource = read(), anchorBeat = 0;
  const msPerSecond = () => (slow ? 1 / slowFactor : 1) * 1000;
  const position = at => running ? anchorBeat + (at - anchorSource) * msPerSecond() : anchorBeat;
  const anchor = beat => { anchorSource = read(); anchorBeat = beat; };
  return {
    get running() { return running; },
    get slow() { return slow; },
    now: () => read(),
    position: (at = read()) => position(at),
    // Source time at which the clock reaches `beat` (only while running).
    sourceTime: beat => anchorSource + (beat - anchorBeat) / msPerSecond(),
    play() { if (!running) { anchor(anchorBeat); running = true; } },
    pause() { if (running) { const beat = position(read()); running = false; anchorBeat = beat; } },
    // Put the clock at `beat` (running or not).
    seek(beat) { anchor(beat); },
    setSlow(value) { const beat = position(read()); slow = value; anchor(beat); },
    // Read another time source from now on, at the same position. `beat` overrides the position read from the old source,
    // for when the old source has stopped (an interrupted audio context).
    useSource(next, beat = position(read())) { read = next; anchor(beat); },
  };
}

// Books the sounds for the playback clock. `until` is the beat time up to which sounds have been handed out; null means idle.
// `latency` (seconds) is how long a booked sound takes to reach the listener: the sound is booked that much earlier so that
// it is heard when the picture shows its beat time. `limit` stops the booking at a beat time (the end of a one-beat play).
export function createSoundScheduler() {
  let until = null;
  return {
    get active() { return until !== null; },
    // Begin booking at the current position of the clock. Sounds that would have to be booked in the past (within `latency`
    // of the position) are skipped: they are already on their way to the listener, or cannot be early. Booking them again
    // after a stop would sound them twice.
    start(playback, now, latency = 0) { until = playback.position(now + latency); },
    stop() { until = null; },
    take(playback, now, { latency = 0, limit = Infinity } = {}) {
      if (until === null || !playback.running) return [];
      const horizon = Math.min(playback.position(now + latency + lookahead), limit);
      const events = [];
      for (const { sound, beat } of soundsBetween(until, horizon)) {
        const at = playback.sourceTime(beat) - latency;
        if (at >= now - lateLimit) events.push({ sound, at });
      }
      until = Math.max(until, horizon);
      return events;
    },
  };
}

// Tone of each sound, chosen for display: a short triangle tone that falls in pitch. The triangle's upper partials keep it
// audible on small speakers, which cannot play the fundamental. The lengths do not change with the playback speed.
export const voices = {
  first: { hz: 90, fall: .6, length: .14, peak: .9 },
  second: { hz: 130, fall: .6, length: .1, peak: .7 },
};

// The synthetic heart sound on a Web Audio context. Nothing is loaded: the tones are generated.
export function createHeartSound(Context) {
  let context = null, master = null, generation = null, volume = .5;
  const supported = typeof Context === 'function';
  const gainOf = v => v * v;
  const newGeneration = () => {
    generation = { gain: context.createGain(), oscillators: new Set() };
    generation.gain.connect(master);
  };
  return {
    supported,
    get context() { return context; },
    get state() { return context ? context.state : 'closed'; },
    // Create the context, if needed, and ask it to run. Call it inside the tap that turns the sound on.
    open() {
      if (!context) {
        context = new Context();
        master = context.createGain();
        master.gain.value = gainOf(volume);
        master.connect(context.destination);
        newGeneration();
      }
      return Promise.resolve(context.resume());
    },
    onStateChange(handler) { context.addEventListener('statechange', handler); },
    now: () => context.currentTime,
    // Seconds from booking to hearing, as the context reports it (outputLatency, else baseLatency). 0 when unknown. Whether
    // it is right for a given device, Bluetooth included, is not verified.
    latency() {
      const { outputLatency, baseLatency } = context;
      const value = Number.isFinite(outputLatency) && outputLatency > 0 ? outputLatency : Number.isFinite(baseLatency) ? baseLatency : 0;
      return Math.min(maxLatency, Math.max(0, value));
    },
    setVolume(value) {
      volume = Math.min(1, Math.max(0, value));
      if (master) master.gain.setTargetAtTime(gainOf(volume), context.currentTime, .02);
    },
    // Book sounds: [{ sound: 'first' | 'second', at }] with `at` in context seconds.
    schedule(events) {
      for (const { sound, at } of events) {
        const v = voices[sound], start = Math.max(at, context.currentTime);
        const oscillator = context.createOscillator(), envelope = context.createGain();
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(v.hz, start);
        oscillator.frequency.exponentialRampToValueAtTime(v.hz * v.fall, start + v.length);
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(v.peak, start + .008);
        envelope.gain.exponentialRampToValueAtTime(.001, start + v.length);
        oscillator.connect(envelope);
        envelope.connect(generation.gain);
        oscillator.start(start);
        oscillator.stop(start + v.length + .02);
        generation.oscillators.add(oscillator);
        const owner = generation;
        oscillator.onended = () => owner.oscillators.delete(oscillator);
      }
    },
    // Silence everything booked or sounding, without a click: the batch fades out in a few milliseconds and the next sounds
    // go to a new batch.
    cancel() {
      if (!context) return;
      const old = generation, t = context.currentTime;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, .004);
      for (const oscillator of old.oscillators) oscillator.stop(t + .05);
      setTimeout(() => old.gain.disconnect(), 200);
      newGeneration();
    },
  };
}
