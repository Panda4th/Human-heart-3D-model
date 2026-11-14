import { cycle, period, timeInBeat } from './heartbeat.mjs';

// Explanatory timing of the electrical impulse on the beat clock, and the schematic electrocardiogram drawn from it. Kept free of
// WebGL so Node tests can check it.
//
// Durations of the four stretches: OpenStax Anatomy and Physiology 2e, 19.2 Cardiac Muscle and Electrical Activity (the HTML was
// read directly on 2026-11-14): the impulse takes about 50 ms from the SA node to the AV node; about 100 ms to pass through the AV
// node; about 25 ms down the bundle branches to the apex; and about 75 ms to reach all ventricular muscle cells through the
// Purkinje fibers. The page also says the total from the SA node to depolarization of the ventricles is about 225 ms, but the four
// durations add up to 250 ms; the source does not reconcile the two, and the four durations are used here.
export const conductionTimes = { atria: 50, avNode: 100, bundles: 25, purkinje: 75 };
// The same page: the atria begin contracting about 25 ms after the start of the P wave, and the ventricles begin to contract as the
// QRS complex reaches the peak of the R wave. The repolarization of a contractile cell lasts about 75 ms, and its whole action
// potential 250 to 300 ms.
export const repolarization = 75;

// Where the impulse sits on the beat clock. The beat clock (heartbeat.mjs, OpenStax 19.3) starts with the atrial contraction and
// has the ventricular contraction start at cycle.atrialSystole. The source puts this start after the impulse has reached the
// ventricular muscle (its step 5, then step 6), so the Purkinje stretch is placed to begin when the ventricles begin to contract.
// Everything before it follows from the durations above. The SA node therefore fires 75 ms before the beat clock's zero, in the
// end of the previous beat, and the atria begin to contract 75 ms after it, not the 25 ms of the source: with the 25 ms the
// ventricles would contract before the impulse reached them (display alignment, not a measurement).
export const sinusFire = cycle.atrialSystole - (conductionTimes.bundles + conductionTimes.avNode + conductionTimes.atria);
const span = (from, length) => ({ from, to: from + length, length });
export const stretches = {
  atria: span(sinusFire, conductionTimes.atria),
};
stretches.avNode = span(stretches.atria.to, conductionTimes.avNode);
stretches.bundles = span(stretches.avNode.to, conductionTimes.bundles);
stretches.purkinje = span(stretches.bundles.to, conductionTimes.purkinje);
// The T wave: repolarization of the ventricles, ending where the ventricular systole of the beat clock ends.
export const repolarizationWindow = span(cycle.atrialSystole + cycle.ventricularSystole - repolarization, repolarization);

// State of one stretch at beat time ms (not wrapped; the impulse comes back every beat). `progress` runs 0 to 1 while the impulse
// is in the stretch. `age` is the time since it left the stretch, or -1 while it is inside; it is where the glow fades.
export function stretchAt(stretch, ms) {
  const t = timeInBeat(ms - stretch.from);
  return t < stretch.length ? { active: true, progress: t / stretch.length, age: -1 } : { active: false, progress: 1, age: t - stretch.length };
}

// Which of the four stretches the impulse is in at ms, or null (between the end of the Purkinje stretch and the next beat's SA
// firing, when the ventricles recover).
export function stretchNameAt(ms) {
  for (const name of Object.keys(stretches)) if (stretchAt(stretches[name], ms).active) return name;
  return null;
}

// Where the impulse is in the bundle stretch (25 ms) when it is in each part, as fractions of the stretch. `lengths` are the arc
// lengths of the paths: the impulse runs down the His bundle (both intervals) first and then along the branches in parallel, each
// branch reaching its end at the end of the stretch. pulseAt (the head) and glowAt (the glow) both use this split, so the glow never
// runs ahead of the head.
export function bundleSplit(lengths) {
  const trunk = lengths.his + lengths.bhis, branches = Math.max(lengths.lbb, lengths.rbb), total = trunk + branches;
  const share = trunk / total, split = lengths.his / total;
  return { his: [0, split], bhis: [split, share], lbb: [share, 1], rbb: [share, 1] };
}

// Where along each part's path the impulse is, as a 0-to-1 fraction of that path, or null while it is not inside.
export function pulseAt(ms, lengths) {
  const out = {};
  const atria = stretchAt(stretches.atria, ms), bundles = stretchAt(stretches.bundles, ms), purkinje = stretchAt(stretches.purkinje, ms);
  out.atria = atria.active ? atria.progress : null;
  const split = bundleSplit(lengths);
  const within = ([a, b], p) => p >= a && p < b ? (p - a) / (b - a) : null;
  const p = bundles.active ? bundles.progress : -1;
  for (const id of ['his', 'bhis', 'lbb', 'rbb']) out[id] = within(split[id], p);
  out.purkinje = purkinje.active ? purkinje.progress : null;
  return out;
}

// When the impulse is in each part, as a window on the beat clock. The bundle parts take their share of the bundle stretch from
// bundleSplit, so each is in its own window, in the order of the path; the other parts are in their whole stretch (the SA node
// with the atrial stretch).
export function partWindows(lengths) {
  const b = stretches.bundles, split = bundleSplit(lengths);
  const sub = ([a, z]) => span(b.from + a * b.length, (z - a) * b.length);
  return {
    sa: stretches.atria, atria: stretches.atria, av: stretches.avNode,
    his: sub(split.his), bhis: sub(split.bhis), lbb: sub(split.lbb), rbb: sub(split.rbb),
    purkinje: stretches.purkinje,
  };
}

// How strongly each part glows at ms (0 to 1): 0 until the impulse reaches it, fully while it is in it, and fading over `fade` ms
// from the moment it has left it. The glow comes back with the impulse in the next beat.
export const fade = 120;
export function glowAt(ms, lengths) {
  const out = {};
  for (const [id, window] of Object.entries(partWindows(lengths))) {
    const s = stretchAt(window, ms);
    out[id] = s.active ? 1 : s.age < 3 * fade ? Math.exp(-s.age / fade) : 0;
  }
  return out;
}

// How long ago (ms) the newest occurrence of a wave, `mean` ms into the beat, was at beat time `beatTime` (not wrapped), counting
// only occurrences between minAge and maxAge ago; null if none. The beat time keeps growing while the beat plays, so the occurrence
// is found from the beat time and not from a fixed list of beats.
export function waveAge(beatTime, mean, minAge, maxAge) {
  const newest = timeInBeat(beatTime - mean);
  for (let age = newest; age <= maxAge; age += period) if (age >= minAge) return age;
  return null;
}

// Screen text for the stretch the impulse is in (conduction view).
export const stretchText = {
  atria: '刺激：洞房結節から心房へ広がる（約0.05秒）',
  avNode: '刺激：房室結節でいったん待つ（約0.1秒）',
  bundles: '刺激：ヒス束と左右の脚を心尖へ下る（約0.025秒）',
  purkinje: '刺激：プルキンエ線維から心室の筋へ（約0.075秒）',
  recovery: '刺激：心室が元に戻る（心電図のT波）',
};
export function stretchTextAt(ms) {
  const name = stretchNameAt(ms);
  if (name) return stretchText[name];
  const t = repolarizationWindow, r = stretchAt(t, ms);
  return r.active ? stretchText.recovery : '刺激：次の発火を待つ';
}

// The schematic electrocardiogram: a sum of Gaussian bumps, each placed on the stretches above. P: the atrial stretch. QRS: the
// bundle and Purkinje stretches, with the R peak where the ventricles begin to contract. T: the repolarization window. Where the
// bumps sit comes from the source's durations; their heights and widths are chosen for display (no axis, no millivolts).
const bump = (ms, mean, sigma, height) => {
  const d = ((ms - mean + period / 2) % period + period) % period - period / 2;
  return height * Math.exp(-d * d / (2 * sigma * sigma));
};
export const ecgBumps = [
  { name: 'P', mean: (stretches.atria.from + stretches.atria.to) / 2, sigma: stretches.atria.length / 4, height: .18 },
  { name: 'Q', mean: stretches.bundles.from + 10, sigma: 5, height: -.12 },
  { name: 'R', mean: cycle.atrialSystole, sigma: 7, height: 1 },
  { name: 'S', mean: stretches.purkinje.from + 30, sigma: 12, height: -.28 },
  { name: 'T', mean: (repolarizationWindow.from + repolarizationWindow.to) / 2, sigma: repolarization / 4, height: .3 },
];
export const ecgAt = ms => ecgBumps.reduce((sum, b) => sum + bump(ms, b.mean, b.sigma, b.height), 0);
