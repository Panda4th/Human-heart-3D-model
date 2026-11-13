import { Matrix4, Vector3 } from 'three';

// Explanatory heartbeat. Kept free of WebGL so Node tests can check it.
//
// Timing: OpenStax Anatomy and Physiology 2e, 19.3 Cardiac Cycle (read 2026-11-08). Atrial systole lasts about 100 ms
// and ends before ventricular systole; ventricular systole lasts 270 ms (isovolumic contraction, then ejection);
// ventricular diastole about 430 ms (isovolumic relaxation, then late diastole). The page names no heart rate;
// the three add up to 800 ms, which is 75 beats a minute. The page gives no durations for the sub-phases.
export const cycle = { atrialSystole: 100, ventricularSystole: 270, ventricularDiastole: 430 };
export const period = cycle.atrialSystole + cycle.ventricularSystole + cycle.ventricularDiastole;
// The slow speed stretches one beat to period * slowFactor ms, so the phases can be followed by eye.
export const slowFactor = 5;
// Time within the beat, 0 <= t < period, for any beat time in ms (negative times and times after the first beat included).
export const timeInBeat = ms => ((ms % period) + period) % period;

const smooth = x => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
// How far each pair of chambers is contracted at time ms, 0 (relaxed) to 1 (most contracted). Only the order and
// the length of the phases come from the source. The shape of each rise and fall is chosen for display: the atria
// rise and fall within atrial systole; the ventricles rise through ventricular systole and relax over the first half
// of ventricular diastole.
export function contraction(ms) {
  const t = timeInBeat(ms);
  const a = cycle.atrialSystole, v = a + cycle.ventricularSystole;
  const atria = t < a ? Math.sin(Math.PI * t / a) ** 2 : 0;
  const ventricles = t < a ? 0 : t < v ? smooth((t - a) / cycle.ventricularSystole) : 1 - smooth((t - v) / (cycle.ventricularDiastole / 2));
  return { atria, ventricles };
}

// Screen text for each phase. The valve states follow OpenStax 19.3. The valve meshes are one moment of the source
// data and do not move; the text says what the valves do. `short` is the one line shown on a phone.
export const phases = [
  { id: 'atrial', name: '心房の収縮', time: '約0.1秒', short: '房室弁 開 ／ 動脈弁 閉', valves: '房室弁（三尖弁・僧帽弁）は開き、動脈弁（肺動脈弁・大動脈弁）は閉じています。心房が縮み、心室を満たす血液の残り20〜30%を送り込みます。' },
  { id: 'ventricular', name: '心室の収縮', time: '約0.27秒', short: '房室弁 閉 → 動脈弁 開', valves: '房室弁が閉じます。はじめは4つの弁がすべて閉じたまま心室の圧が上がり（等容性収縮）、その後、動脈弁が開いて血液を送り出します（駆出）。' },
  { id: 'relaxation', name: '心室の弛緩', time: '約0.43秒', short: '動脈弁 閉 → 房室弁 開', valves: '動脈弁が閉じます。はじめは4つの弁がすべて閉じたまま心室が緩み（等容性弛緩）、その後、房室弁が開いて心房から心室へ血液が流れ込みます。' },
];
export function phaseAt(ms) {
  const t = timeInBeat(ms);
  return t < cycle.atrialSystole ? 0 : t < cycle.atrialSystole + cycle.ventricularSystole ? 1 : 2;
}

// One step of the beat clock. With `once` (reduced motion: one beat per press) the time stops at the end of the first beat,
// so that whatever is advanced with it (the blood-flow particles) never goes past the beat it was asked to play.
export function stepBeat(time, delta, once) {
  const next = once ? Math.min(time + delta, period) : time + delta;
  return { next, done: once && next >= period };
}

// Which valves are open at time ms. OpenStax 19.3 gives the order (atrioventricular valves open in atrial systole and
// again once the ventricle has relaxed; semilunar valves open only after isovolumic contraction and close at the end of
// ventricular systole) but no length for the two isovolumic periods, in which all four valves are closed. The lengths
// below are chosen for display, not taken from the source; the blood-flow particles follow these windows.
export const isovolumic = { contraction: 50, relaxation: 80 };
export function valvesAt(ms) {
  const t = timeInBeat(ms);
  const atrial = cycle.atrialSystole, systole = atrial + cycle.ventricularSystole;
  return {
    atrioventricular: t < atrial || t >= systole + isovolumic.relaxation,
    arterial: t >= atrial + isovolumic.contraction && t < systole,
  };
}

// Peak pull toward each chamber's centre, as a fraction of the distance, before the fall-off below. Chosen for
// display, not measured: the walls move a few millimetres.
const amplitude = { atria: .15, ventricles: .25 };
const chamberGroup = { lv: 'ventricles', rv: 'ventricles', ra: 'atria', la: 'atria' };

// Centre (mean wall vertex) and spread (root-mean-square distance of the wall vertices) of each chamber's wall, in
// the millimetre frame of the parts.
function beatCenters(parts) {
  return Object.entries(chamberGroup).map(([id, group]) => {
    const mesh = parts.get(id).children.find(o => o.isMesh);
    const p = mesh.geometry.attributes.position, center = new Vector3(), v = new Vector3();
    for (let i = 0; i < p.count; i++) center.add(v.fromBufferAttribute(p, i));
    center.divideScalar(p.count);
    let sum = 0;
    for (let i = 0; i < p.count; i++) sum += v.fromBufferAttribute(p, i).distanceToSquared(center);
    return { id, group, center, sigma: Math.sqrt(sum / p.count) };
  });
}

// Weight of each centre at a point. reach is a Gaussian fall-off with the chamber's spread, so the motion fades away
// from the heart. share splits a point between the chambers by the same distances, sharpened by `sharpness`, so a
// ventricle's contraction hardly pulls the atria and the other way round. The displacement is a sum over the centres
// of weight * contraction * (centre - point). It depends only on the position, so points shared by two chambers'
// walls, and vessels lying on the wall, move together and the surface does not tear.
const sharpness = 4;
function weights(centers, x, y, z) {
  const r2 = centers.map(c => ((c.center.x - x) ** 2 + (c.center.y - y) ** 2 + (c.center.z - z) ** 2) / (c.sigma * c.sigma));
  const least = Math.min(...r2), share = r2.map(r => Math.exp(-sharpness * (r - least) / 2)), total = share.reduce((a, b) => a + b);
  return centers.map((c, i) => amplitude[c.group] * Math.exp(-r2[i] / 2) * share[i] / total);
}

// Deform every drawn geometry under root (the millimetre frame) on the CPU. Moving the vertices themselves keeps the
// cut face (drawn from the same geometry by the stencil), clicking and label anchors in step with what is drawn.
// Geometries are deformed once even when several meshes share them (the cross-section copies). Objects placed with
// their own transform (the conduction nodes) move as a whole by the displacement at their origin. Helper subtrees
// (the cut-face quads) are skipped. Vertex normals are kept from the rest shape; the change is a few millimetres.
export function createBeat(root, parts) {
  const centers = beatCenters(parts);
  const deformed = [], moved = [], seen = new Set();
  root.updateWorldMatrix(true, true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert(), rel = new Matrix4(), identity = new Matrix4();
  const near = (a, b) => a.elements.every((e, i) => Math.abs(e - b.elements[i]) < 1e-9);
  const visit = object => {
    if (object.userData.helper) return;
    if ((object.isMesh || object.isLine) && object.geometry) {
      rel.multiplyMatrices(toRoot, object.matrixWorld);
      if (near(rel, identity)) {
        if (!seen.has(object.geometry)) {
          seen.add(object.geometry);
          const attribute = object.geometry.attributes.position, rest = Float32Array.from(attribute.array);
          const w = centers.map(() => new Float32Array(attribute.count));
          for (let i = 0; i < attribute.count; i++) weights(centers, rest[3 * i], rest[3 * i + 1], rest[3 * i + 2]).forEach((k, c) => { w[c][i] = k; });
          deformed.push({ geometry: object.geometry, attribute, rest, w });
        }
      } else if (object.parent && near(new Matrix4().multiplyMatrices(toRoot, object.parent.matrixWorld), identity)) {
        moved.push({ object, rest: object.position.clone(), w: weights(centers, object.position.x, object.position.y, object.position.z) });
      }
    }
    for (const child of object.children) visit(child);
  };
  visit(root);
  let state = { atria: 0, ventricles: 0 };
  const factors = () => centers.map(c => state[c.group]);
  function set(next) {
    state = { atria: next.atria, ventricles: next.ventricles };
    const s = factors();
    for (const { geometry, attribute, rest, w } of deformed) {
      const a = attribute.array;
      for (let i = 0, j = 0; i < attribute.count; i++, j += 3) {
        let dx = 0, dy = 0, dz = 0;
        for (let c = 0; c < centers.length; c++) {
          const k = s[c] * w[c][i];
          if (k === 0) continue;
          const o = centers[c].center;
          dx += k * (o.x - rest[j]); dy += k * (o.y - rest[j + 1]); dz += k * (o.z - rest[j + 2]);
        }
        a[j] = rest[j] + dx; a[j + 1] = rest[j + 1] + dy; a[j + 2] = rest[j + 2] + dz;
      }
      attribute.needsUpdate = true;
      geometry.computeBoundingSphere();
      if (geometry.boundingBox) geometry.computeBoundingBox();
    }
    for (const { object, rest, w } of moved) {
      object.position.copy(rest);
      centers.forEach((c, i) => object.position.addScaledVector(new Vector3().subVectors(c.center, rest), s[i] * w[i]));
    }
  }
  // The displaced position of a point given in the millimetre frame, for label anchors.
  function displace(point) {
    const [x, y, z] = point, w = weights(centers, x, y, z), s = factors(), out = [x, y, z];
    centers.forEach((c, i) => {
      const k = s[i] * w[i];
      out[0] += k * (c.center.x - x); out[1] += k * (c.center.y - y); out[2] += k * (c.center.z - z);
    });
    return out;
  }
  return { set, displace };
}
