// Convert BodyParts3D OBJ files into the compact mesh bundle embedded in index.html.
// Usage: node scripts/prepare-bodyparts3d.mjs <BodyParts3D_3.0_obj_99.zip> <partof_BP3D_4.0_obj_99.zip>
// Add --inspect-landmarks for a read-only JSON sensitivity report (no bundle is written).
// Downloads (free, no registration): https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
// and https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';
import { CatmullRomCurve3, Vector3 } from 'three';
import { checkRoute, inside, makeSolid, nearestVertexDistance } from './flow-geometry.mjs';

const [v3Path, v4Path] = process.argv.slice(2);
if (!v3Path || !v4Path) throw new Error('Usage: node scripts/prepare-bodyparts3d.mjs <v3 zip> <v4 partof zip>');

// The 4.0 download is served from a LATEST path, so the same URL could one day return different data.
// The bundle was made from these exact files (fetched 2026-11-07; the server lists both as last modified
// in 2011 and 2013). Refuse any other input rather than silently produce a different model.
// ALLOW_UNVERIFIED_INPUT=1 skips the check for deliberate experiments; do not commit output made that way.
const expectedSha256 = {
  [v3Path]: '2125f6d761b14ead4ee64f71713f56f3f0f29982693ff20aac63474470cb92f4', // BodyParts3D_3.0_obj_99.zip
  [v4Path]: '9fbc713fffeee924a5a657d9813d84d7eb957bded63adb854931dd5e3eb61c97', // partof_BP3D_4.0_obj_99.zip
};
const inputSha256 = {};
for (const [path, expected] of Object.entries(expectedSha256)) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  inputSha256[path] = actual;
  if (actual !== expected && process.env.ALLOW_UNVERIFIED_INPUT !== '1') throw new Error(`${path}: SHA-256 ${actual} does not match the recorded ${expected}`);
}

function readZip(path) {
  const buf = readFileSync(path), entries = new Map();
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0, n = buf.readUInt16LE(end + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('latin1', p + 46, p + 46 + nameLength).replaceAll('\\', '/').split('/').pop();
    entries.set(name.replace(/\.obj$/, ''), () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('latin1');
    });
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}
const v3 = readZip(v3Path), v4 = readZip(v4Path);

// BodyParts3D: +x = patient's left, +y = posterior, +z = superior (mm).
// Viewer: +X = patient's left, +Y = superior, +Z = anterior.
function parseObj(text, zOffset = 0) {
  const positions = [], indices = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      positions.push(x, z + zOffset, -y);
    } else if (line.startsWith('f ')) {
      const face = line.slice(2).trim().split(/\s+/).map(v => parseInt(v, 10) - 1);
      for (let i = 1; i + 1 < face.length; i++) indices.push(face[0], face[i], face[i + 1]);
    }
  }
  return { positions, indices };
}
function merge(meshes) {
  const positions = [], indices = [];
  for (const m of meshes) {
    const base = positions.length / 3;
    for (const v of m.positions) positions.push(v);
    for (const i of m.indices) indices.push(i + base);
  }
  return { positions, indices };
}
// Cut the mesh with axis-aligned planes [axis, value, +1 keeps greater | -1 keeps smaller].
// Triangles are split at the plane, so vessel ends stay straight instead of jagged.
function clip(mesh, planes) {
  const positions = [...mesh.positions], indices = [];
  const point = i => positions.slice(i * 3, i * 3 + 3);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    let polygon = mesh.indices.slice(t, t + 3);
    for (const [axis, value, sign] of planes) {
      const next = [];
      polygon.forEach((a, k) => {
        const b = polygon[(k + 1) % polygon.length], pa = point(a), pb = point(b);
        const da = sign * (pa[axis] - value), db = sign * (pb[axis] - value);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const f = da / (da - db);
          positions.push(...pa.map((v, j) => v + (pb[j] - v) * f));
          next.push(positions.length / 3 - 1);
        }
      });
      polygon = next;
      if (polygon.length < 3) break;
    }
    for (let k = 1; k + 1 < polygon.length; k++) indices.push(polygon[0], polygon[k], polygon[k + 1]);
  }
  return { positions, indices };
}
// Weld duplicated OBJ vertices so the simplifier and smooth normals see a connected surface.
function weld(mesh) {
  const map = new Map(), positions = [], remap = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const key = [0, 1, 2].map(k => Math.round(mesh.positions[i * 3 + k] * 100)).join(',');
    if (!map.has(key)) { map.set(key, positions.length / 3); positions.push(...mesh.positions.slice(i * 3, i * 3 + 3)); }
    remap.push(map.get(key));
  }
  const indices = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = mesh.indices.slice(t, t + 3).map(i => remap[i]);
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) indices.push(...tri);
  }
  return { positions, indices };
}
await MeshoptSimplifier.ready;
function simplify(mesh, ratio) {
  const positions = new Float32Array(mesh.positions);
  const target = Math.max(3, Math.floor(mesh.indices.length * ratio / 3) * 3);
  const [indices] = MeshoptSimplifier.simplify(new Uint32Array(mesh.indices), positions, 3, target, .02, ['Prune']);
  return compact({ positions: mesh.positions, indices: [...indices] });
}
function compact(mesh) {
  const map = new Map(), positions = [], indices = [];
  for (const i of mesh.indices) {
    if (!map.has(i)) { map.set(i, positions.length / 3); positions.push(...mesh.positions.slice(i * 3, i * 3 + 3)); }
    indices.push(map.get(i));
  }
  return { positions, indices };
}
const headerName = text => (/English name : (.*)/.exec(text)?.[1] ?? '').trim();
// BodyParts3D 3.0 file IDs start with FMA, 4.0 file IDs with FJ. Around the heart, 4.0 parts
// sit 10 mm lower than the same 3.0 parts (SVC, right coronary artery, coronary sinus), so
// 4.0 meshes are shifted up to meet the 3.0 heart wall.
const load = id => id.startsWith('FMA') ? parseObj(v3.get(id)()) : parseObj(v4.get(id)(), 10);

// Heart wall (BodyParts3D 3.0 has one mesh; 4.0 has no ventricular myocardium).
// Split it into chambers by the nearest 4.0 chamber cavity. Boundaries are estimates.
const wall = simplify(weld(load('FMA7274')), .22);
const cavities = { lv: 'FJ2422', rv: 'FJ2423', ra: 'FJ2424', la: 'FJ2425' };
const cavityPoints = Object.entries(cavities).map(([id, file]) => [id, load(file).positions]);
const chambers = Object.fromEntries(Object.keys(cavities).map(id => [id, []]));
for (let t = 0; t < wall.indices.length; t += 3) {
  const c = [0, 1, 2].map(k => (wall.positions[wall.indices[t] * 3 + k] + wall.positions[wall.indices[t + 1] * 3 + k] + wall.positions[wall.indices[t + 2] * 3 + k]) / 3);
  let best = null, bestDistance = Infinity;
  for (const [id, p] of cavityPoints) {
    for (let i = 0; i < p.length; i += 3) {
      const d = (p[i] - c[0]) ** 2 + (p[i + 1] - c[1]) ** 2 + (p[i + 2] - c[2]) ** 2;
      if (d < bestDistance) { bestDistance = d; best = id; }
    }
  }
  chambers[best].push(wall.indices[t], wall.indices[t + 1], wall.indices[t + 2]);
}

const coronaryArtery = /coronary artery|conus artery/i, cardiacVein = /cardiac vein|coronary sinus|marginal vein|posterior vein of left ventricle/i;
const v4ByName = re => [...v4.keys()].filter(id => id.startsWith('FJ') && re.test(headerName(v4.get(id)().slice(0, 1500))));
const part = (ids, planes = [], ratio = .5) => simplify(weld(clip(merge(ids.map(load)), planes)), ratio);

// The aorta is six separate shells, and each one is closed by a flat cap where the next begins. Where two of them
// meet, the caps stay inside the vessel, and the thin gap between the rims showed on screen as a dark line and a
// small step. Cut the caps away from the shells, then join the open rims with a strip of triangles.
const dropTriangles = (mesh, drop) => {
  const indices = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ids = mesh.indices.slice(t, t + 3), p = ids.map(i => mesh.positions.slice(i * 3, i * 3 + 3));
    const u = p[1].map((v, k) => v - p[0][k]), w = p[2].map((v, k) => v - p[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (!drop(p, Math.abs(n[1]) / (Math.hypot(...n) || 1))) indices.push(...ids);
  }
  return { positions: mesh.positions, indices };
};
// The open rims of a mesh, each as a closed loop of vertex indices that follows the direction of its boundary edges.
function openRims(mesh) {
  const directed = new Set(), next = new Map();
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) directed.add(mesh.indices[t + k] + ',' + mesh.indices[t + (k + 1) % 3]);
  for (const key of directed) {
    const [a, b] = key.split(',').map(Number);
    if (!directed.has(b + ',' + a)) { if (next.has(a)) throw new Error('an aorta rim touches itself'); next.set(a, b); }
  }
  const loops = [], seen = new Set();
  for (const first of next.keys()) {
    if (seen.has(first)) continue;
    const loop = [first];
    seen.add(first);
    for (let v = next.get(first); v !== first; v = next.get(v)) {
      if (v === undefined || seen.has(v)) throw new Error('an aorta rim is not a closed loop');
      seen.add(v); loop.push(v);
    }
    loops.push(loop);
  }
  return loops;
}
// Join two rims of one mesh with a strip of triangles. At each step the shorter of the two possible new edges is taken.
function zipRims(mesh, loopA, loopB) {
  const P = mesh.positions, dist = (a, b) => Math.hypot(...[0, 1, 2].map(k => P[a * 3 + k] - P[b * 3 + k]));
  // Rims of two shells that face each other run in opposite directions, so walk B backwards, from the vertex closest to A's first.
  const reversed = [...loopB].reverse();
  let start = 0;
  reversed.forEach((v, j) => { if (dist(loopA[0], v) < dist(loopA[0], reversed[start])) start = j; });
  const b = [...reversed.slice(start), ...reversed.slice(0, start)], out = [...mesh.indices];
  let i = 0, m = 0;
  while (i < loopA.length || m < b.length) {
    const a0 = loopA[i % loopA.length], a1 = loopA[(i + 1) % loopA.length], c0 = b[m % b.length], c1 = b[(m + 1) % b.length];
    if (m >= b.length || (i < loopA.length && dist(a1, c0) <= dist(a0, c1))) { out.push(a1, a0, c0); i++; } else { out.push(c0, c1, a0); m++; }
  }
  return { positions: mesh.positions, indices: out };
}
const centroid = (mesh, loop) => [0, 1, 2].map(k => loop.reduce((sum, v) => sum + mesh.positions[v * 3 + k], 0) / loop.length);
// A cap triangle lies in a narrow height band at a joint and faces mostly up or down.
const capTriangle = (lowest, highest, where = () => true, facing = .7) => (p, ny) => ny > facing && p.every(q => q[1] >= lowest && q[1] <= highest && where(q));
// The three main aorta shells (ascending FMA3736, arch FMA3768, descending FMA3784) with the caps between them cut away
// and the rims joined. Joints in viewer mm: ascending top and the arch's front end near z 112-138, the arch's back end
// and the descending top near z 54-77.
function joinedAorta() {
  const shells = [
    dropTriangles(weld(load('FMA3736')), capTriangle(1300.5, 1400)),
    dropTriangles(weld(load('FMA3768')), capTriangle(0, 1304.8, q => q[2] > 100 || q[2] < 90)),
    dropTriangles(weld(load('FMA3784')), capTriangle(1298, 1400, () => true, .8))
  ];
  const mesh = merge(shells), sizes = shells.map(shell => shell.positions.length / 3), base = [0, sizes[0], sizes[0] + sizes[1]];
  const rims = shells.map((shell, k) => openRims(shell).map(loop => loop.map(v => v + base[k])));
  // Rim counts are checked so that a cap left in place, or a piece of the tube cut away by mistake, stops the build.
  if (rims[0].length !== 1 || rims[1].length !== 2 || rims[2].length !== 1) throw new Error(`aorta rims: ${rims.map(r => r.length)} (expected 1, 2, 1)`);
  const nearest = (target, loops) => {
    const c = centroid(mesh, target), d = loop => Math.hypot(...centroid(mesh, loop).map((v, k) => v - c[k]));
    return loops.reduce((best, loop) => d(loop) < d(best) ? loop : best);
  };
  return zipRims(zipRims(mesh, rims[0][0], nearest(rims[0][0], rims[1])), nearest(rims[2][0], rims[1]), rims[2][0]);
}
// Viewer axes in mm: 0 = patient's left, 1 = superior. Cuts keep vessel stubs near the heart.
const X = 0, Y = 1;
const parts = {
  ...Object.fromEntries(Object.entries(chambers).map(([id, indices]) => [id, compact({ positions: wall.positions, indices })])),
  ao: simplify(weld(clip(merge([joinedAorta(), ...['FJ3417', 'FJ3479', 'FJ3483'].map(load)]), [[Y, 1175, 1], [Y, 1355, -1], [X, 45, -1]])), .5),
  pa: part(['FJ2966', 'FJ2924', 'FJ3019'], [[X, -45, 1], [X, 70, -1]]),
  vc: part(['FMA4720', 'FMA10951'], [[Y, 1165, 1]]),
  pv: part(['FJ2925', 'FJ2933', 'FJ2944', 'FJ2950', 'FJ2955', 'FJ3020', 'FJ3040']),
  ca: part(v4ByName(coronaryArtery), [], .4),
  cv: part(v4ByName(cardiacVein), [], .4),
  // Interior view: 4.0 valve leaflets and papillary muscles. Leaflet meshes include strands that
  // look like chordae tendineae; 4.0 has no separate chordae mesh.
  mv: part(['FJ2420', 'FJ2432'], [], .3),
  tv: part(['FJ2421', 'FJ2433', 'FJ2436'], [], .3),
  aov: part(['FJ2426', 'FJ2431', 'FJ2435']),
  pov: part(['FJ2417', 'FJ2427', 'FJ2434']),
  pm: part(['FJ2418', 'FJ2429', 'FJ2419', 'FJ2430', 'FJ2437']),
  // The four cavities are not drawn (anatomy.mjs has no definition for them). They are kept in the bundle so that the
  // unit tests can check the blood-flow routes against them without the BodyParts3D zips.
  cavlv: weld(load(cavities.lv)), cavrv: weld(load(cavities.rv)), cavra: weld(load(cavities.ra)), cavla: weld(load(cavities.la)),
};

// Anchor points for the explanatory conduction overlay. BodyParts3D has no conduction-system
// meshes, so positions are derived from nearby structures in the usual textbook relation:
// SA node at the SVC-right atrium junction, AV node at the apex of the triangle of Koch, His bundle to the
// septal crest beneath the non-coronary and right coronary aortic cusps,
// bundle branches on each side of the ventricular septum, Purkinje fibres on the cavity walls.
const pts = id => { const p = load(id).positions, out = []; for (let i = 0; i < p.length; i += 3) out.push(p.slice(i, i + 3)); return out; };
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (set, q) => set.reduce((best, p) => d2(p, q) < d2(best, q) ? p : best);
const mean = set => [0, 1, 2].map(k => set.reduce((s, p) => s + p[k], 0) / set.length);
const lerp = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const extreme = (set, score) => set.reduce((best, p) => score(p) > score(best) ? p : best);
const cav = Object.fromEntries(Object.entries(cavities).map(([id, file]) => [id, pts(file)]));
// Follow a polyline over a surface: sample it and snap each sample to the nearest surface vertex.
const along = (surface, via, samples = 7) => {
  const out = [];
  for (let s = 0; s + 1 < via.length; s++) for (let i = 0; i < samples; i++) out.push(nearest(surface, lerp(via[s], via[s + 1], i / samples)));
  out.push(nearest(surface, via.at(-1)));
  let line = out.filter((p, i) => i === 0 || d2(p, out[i - 1]) > 4);
  // Snapping zigzags between neighbouring vertices; smooth it while keeping both ends.
  for (let pass = 0; pass < 4; pass++) line = line.map((p, i) => i === 0 || i === line.length - 1 ? p : lerp(p, mean([line[i - 1], line[i + 1]]), .6));
  return line;
};
const svc = pts('FJ3645'), svcBottom = Math.min(...svc.map(p => p[1]));
// OpenStax A&P 2e 19.2: SA node in the superior and posterior walls of the RA near the SVC orifice.
const sa = extreme(svc.filter(p => p[1] < svcBottom + 6), p => -p[2]);
// Septal tricuspid leaflet hinge: the part of the leaflet touching the RA cavity.
const septalLeaflet = pts('FJ2436');
const hingeWithin = mm => septalLeaflet.filter(p => d2(nearest(cav.ra, p), p) < mm ** 2);
const septalHinge = hingeWithin(4);
// Aortic cusps. The data names them anterior, left posterior and right posterior. The coronary trunks show which is
// which: the right coronary trunk (FJ2723) starts nearest the anterior cusp, the left (FJ2737) nearest the left
// posterior cusp, so the right posterior cusp is the non-coronary cusp (measured 2026-11-07, see README).
const nonCoronary = pts('FJ2431'), rightCoronary = pts('FJ2435');
// Stephenson et al. 2017 (Sci Rep 7:7188): the conduction axis originates at the apex of the triangle of Koch, whose
// base is the coronary sinus ostium and whose sides are the septal leaflet hinge and the tendon of Todaro, meeting at the
// central fibrous body by the aortic root. The tendon and the central fibrous body are not in the data, so the apex is
// taken as the hinge point nearest the non-coronary cusp. (Until 2026-11-07 the node sat midway between the sinus
// ostium and the hinge's centre, a third of the way from the ostium to this apex.)
const avFromHinge = hinge => {
  if (!hinge.length) throw new Error('No septal leaflet vertices within the hinge candidate range');
  return hinge.reduce((best, p) => d2(nearest(nonCoronary, p), p) < d2(nearest(nonCoronary, best), best) ? p : best);
};
const av = avFromHinge(septalHinge);
const septumLV = cav.lv.filter(p => d2(nearest(cav.rv, p), p) < 15 ** 2);
const septumRV = cav.rv.filter(p => d2(nearest(cav.lv, p), p) < 15 ** 2);
// Branching bundle: on the crest of the septum beneath the non-coronary and right coronary cusps (Stephenson 2017,
// Chen et al. 2025). Taken as the septal point of the LV cavity closest to both cusps' lowest points. No distance is
// set; the distances it gives are measured afterwards, so their agreement with the papers is built in, not a check.
// This LV-side proxy is not an identified tissue boundary or RBB origin. Kawashima/Sato 2021
// distinguish the LBB take-off along the branching bundle from its distal continuation into RBB.
const nadir = set => extreme(set, p => -p[1]);
const [nccNadir, rccNadir] = [nadir(nonCoronary), nadir(rightCoronary)];
const bifurcationFromSeptum = septum => {
  if (!septum.length) throw new Error('No LV vertices within the septal candidate range');
  return septum.reduce((best, p) => Math.sqrt(d2(p, nccNadir)) + Math.sqrt(d2(p, rccNadir)) < Math.sqrt(d2(best, nccNadir)) + Math.sqrt(d2(best, rccNadir)) ? p : best);
};
const bifurcation = bifurcationFromSeptum(septumLV);
// Schematic take-offs are separate. Reuse the LV anchor for the left take-off;
// the nearest RV septal vertex (already the old right path's first surface point)
// marks the distal continuation into RBB. Neither is a histologically identified boundary.
const rightOrigin = nearest(septumRV, bifurcation);
if (process.argv.includes('--inspect-landmarks')) {
  const rounded = p => p.map(v => Math.round(v * 10000) / 10000);
  const delta = (a, b) => rounded(b.map((v, k) => v - a[k]));
  const axis = (a, b) => ({ start: rounded(a), end: rounded(b), delta: delta(a, b), length: Math.sqrt(d2(a, b)) });
  const nearestRV = rightOrigin;
  console.log(JSON.stringify({
    schema: 1,
    unit: 'mm',
    axes: ['patient left', 'superior', 'anterior'],
    inputs: { v3Sha256: inputSha256[v3Path], v4Sha256: inputSha256[v4Path], matchRecorded: Object.keys(expectedSha256).every(path => expectedSha256[path] === inputSha256[path]) },
    interpretation: 'Algorithm sensitivity only; no anatomical validation. No bundle is written.',
    pointRoles: {
      av: 'Valve-derived proxy, not an observed compact-node distal boundary',
      bifurcation: 'LV-side left take-off proxy, not an observed histological boundary',
      nearestRV: 'RV-side right take-off proxy, not an observed RBB origin',
    },
    nominal: { hingeRange: 4, septumRange: 15, ...axis(av, bifurcation) },
    displayed: axis(av.map(v => Math.round(v * 10) / 10), bifurcation.map(v => Math.round(v * 10) / 10)),
    hingeSweep: [3, 4, 5, 6].map(mm => ({ hingeRange: mm, ...axis(avFromHinge(hingeWithin(mm)), bifurcation) })),
    septumSweep: [10, 15, 20].map(mm => ({ septumRange: mm, ...axis(av, bifurcationFromSeptum(cav.lv.filter(p => d2(nearest(cav.rv, p), p) < mm ** 2))) })),
    schematicSegments: { proximal: axis(av, bifurcation), branching: axis(bifurcation, rightOrigin), overallAxis: axis(av, rightOrigin) },
    endpointCounterexample: {
      warning: 'Changing the schematic endpoint changes the axis definition; agreement of its sign is NOT anatomical validation.',
      ...axis(av, nearestRV),
    },
    missingObservedBoundaries: ['compact-node distal end', 'penetrating/branching bundle junction', 'RBB origin', 'membranous septum'],
  }, null, 2));
  process.exit(0);
}
const mitral = mean([...pts('FJ2420'), ...pts('FJ2432')]);
const lvApex = extreme(cav.lv, p => d2(p, mitral));
const rvModerator = extreme(pts('FJ2419'), p => -p[1]); // base of the anterior papillary muscle
const laAppendage = extreme(pts('FJ2438'), p => p[0] + p[1] * .5);
const lvLateral = mean(pts('FJ2429')), lvAnterior = mean(pts('FJ2418'));
const tricuspidAnterior = mean(pts('FJ2421')), pulmonary = mean([...pts('FJ2417'), ...pts('FJ2427'), ...pts('FJ2434')]);
const atrialWall = [...pts('FJ2439'), ...pts('FJ2438')];
const round = set => set.map(p => p.map(v => Math.round(v * 10) / 10));
// Keep schematic paths attached to the nodes that define them. Snapping is useful on a
// chamber surface, but the His segment crosses the septum and is not an LV-surface path.
const anchored = (line, start, end) => line.map((p, i) => i === 0 ? start : i === line.length - 1 ? end : p);
const rightEnd = nearest(cav.rv, rvModerator);
// Keep the existing RV surface samples; its first point is rightOrigin.
const rightSeptal = along(septumRV, [bifurcation, lerp(bifurcation, rvModerator, .5)]);
// The papillary-muscle base is outside the septal candidate patch. Continue over
// the RV endocardium rather than snapping its distal route back onto the septum.
const rightDistal = along(cav.rv, [rightSeptal.at(-1), rightEnd]);
// Explanatory LBB sheet and three directional routes. Widths are display parameters,
// not measured fascicular dimensions. Stay on the LV side of the septal candidate patch.
const leftCentral = along(septumLV, [bifurcation, lerp(bifurcation, lvApex, .5), lvApex]);
const leftLateralNetwork = along(cav.lv, [lvApex, lvLateral, lerp(lvLateral, mitral, .6)]);
const leftAnteriorNetwork = along(cav.lv, [lvApex, lvAnterior, lerp(lvAnterior, mitral, .6)]);
const fanGuide = leftCentral.slice(0, 4);
const down = fanGuide.at(-1).map((v, k) => v - fanGuide[0][k]);
const downLength = Math.hypot(...down);
const tangent = down.map(v => v / downLength);
// Derive the transverse direction from the nearby surface rather than a body axis
// that may point through the surface and collapse the sheet when snapped.
const localOffsets = septumLV.filter(p => d2(p, bifurcation) < downLength ** 2).map(p => p.map((v, k) => v - bifurcation[k]));
const transverse = localOffsets.map(v => {
  const projection = v.reduce((sum, x, k) => sum + x * tangent[k], 0);
  return v.map((x, k) => x - projection * tangent[k]);
});
const side = extreme(transverse, v => v.reduce((sum, x) => sum + x * x, 0));
const sideLength = Math.hypot(...side);
const across = side.map(v => v / sideLength * (side[2] < 0 ? -1 : 1));
// Limit the patch to the ventricular side of the existing basal proxy (not an aortic leaflet).
const fanSurface = septumLV.filter(p => p[1] <= bifurcation[1] + .01);
const fanRows = fanGuide.map((center, row) => [-1, -.5, 0, .5, 1].map(t =>
  nearest(fanSurface, center.map((v, k) => v + across[k] * t * (4.5 + row)))));
const fanPoints = round(fanRows.flat()), fanIndices = [];
for (let row = 0; row < fanRows.length - 1; row++) for (let col = 0; col < 4; col++) {
  const a = row * 5 + col, b = a + 1, c = a + 5, d = c + 1;
  for (const tri of [[a, c, b], [b, c, d]]) {
    const [p, q, r] = tri.map(i => fanPoints[i]);
    const u = q.map((v, k) => v - p[k]), v = r.map((x, k) => x - p[k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (Math.hypot(...n) > .001) fanIndices.push(...tri); // discard collapsed grid triangles after snapping
  }
}
const fanMesh = weld({ positions: fanPoints.flat(), indices: fanIndices });
const fanSeen = new Set(), fanUnique = [];
for (let i = 0; i < fanMesh.indices.length; i += 3) {
  const tri = fanMesh.indices.slice(i, i + 3), key = [...tri].sort((a, b) => a - b).join(',');
  if (!fanSeen.has(key)) { fanSeen.add(key); fanUnique.push(...tri); }
}
fanMesh.indices = fanUnique;
// Join directional routes to points of the existing left Purkinje paths. The posterior
// papillary muscle is absent from the data: do not invent it or claim a muscle attachment.
const leftAnterior = anchored(along(cav.lv, [fanRows.at(-1)[4], nearest(leftAnteriorNetwork, lvAnterior)]).map(p => nearest(cav.lv, p)), fanRows.at(-1)[4], nearest(leftAnteriorNetwork, lvAnterior));
const leftPosterior = anchored(along(cav.lv, [fanRows.at(-1)[0], nearest(leftLateralNetwork, lvLateral)]).map(p => nearest(cav.lv, p)), fanRows.at(-1)[0], nearest(leftLateralNetwork, lvLateral));
const conduction = {
  nodes: { sa: round([sa])[0], av: round([av])[0] },
  junctions: { leftOrigin: round([bifurcation])[0], rightOrigin: round([rightOrigin])[0] },
  leftBundle: { sheet: fanMesh, directions: ['anterior', 'septal', 'posterior'] },
  paths: {
    atria: [round(anchored(along(cav.ra, [sa, lerp(sa, av, .5), av]), sa, av)), round(anchored(along(atrialWall, [sa, lerp(sa, laAppendage, .5), laAppendage]), sa, laAppendage))],
    his: [round([av, bifurcation])],
    branchingHis: [round([bifurcation, rightOrigin])],
    branches: [
      round(leftCentral),
      round(anchored([...rightSeptal, ...rightDistal.slice(1)], rightOrigin, rightEnd)),
    ],
    leftFascicles: [round(leftAnterior), round(leftCentral), round(leftPosterior)],
    purkinje: [
      round(leftLateralNetwork),
      round(leftAnteriorNetwork),
      round(along(cav.rv, [rvModerator, tricuspidAnterior])),
      round(along(cav.rv, [rvModerator, lerp(rvModerator, pulmonary, .7)])),
    ],
  },
};

// Blood-flow routes for the explanatory motion. Not streamlines: each route is a smooth line that follows the middle of
// the vessel or cavity and passes through the middle of each valve opening. It stays inside the cavities and vessels except
// for a few short stretches where the data has no opening (checked below). Veins and venae cavae
// (inflow) are followed toward the heart, arteries (outflow) away from it. Right side: vena cava, right atrium, tricuspid
// valve, right ventricle, pulmonary valve, pulmonary trunk, one pulmonary artery. Left side: pulmonary vein, left atrium,
// mitral valve, left ventricle, aortic valve, ascending aorta, aortic arch.
const vsub = (a, b) => a.map((v, k) => v - b[k]);
const vadd = (a, b) => a.map((v, k) => v + b[k]);
const vmul = (a, s) => a.map(v => v * s);
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vunit = a => vmul(a, 1 / (Math.hypot(...a) || 1));
const dist = (a, b) => Math.sqrt(d2(a, b));
const meshVertices = mesh => { const out = []; for (let i = 0; i < mesh.positions.length; i += 3) out.push(mesh.positions.slice(i, i + 3)); return out; };
const endNear = (mesh, ref, n = 12) => mean(meshVertices(mesh).sort((a, b) => d2(a, ref) - d2(b, ref)).slice(0, n));
const endFar = (mesh, ref, n = 12) => mean(meshVertices(mesh).sort((a, b) => d2(b, ref) - d2(a, ref)).slice(0, n));

// Cut a tube's surface with the plane through p perpendicular to d: the centre and rms radius of the cut curve near p.
function cutCentre(mesh, p, d, radius) {
  const at = i => mesh.positions.slice(i * 3, i * 3 + 3), segments = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [0, 1, 2].map(k => at(mesh.indices[t + k])), s = v.map(q => vdot(vsub(q, p), d)), cut = [];
    for (let k = 0; k < 3; k++) {
      const a = s[k], b = s[(k + 1) % 3];
      if ((a >= 0) !== (b >= 0)) cut.push(lerp(v[k], v[(k + 1) % 3], a / (a - b)));
    }
    if (cut.length === 2 && dist(lerp(cut[0], cut[1], .5), p) < radius) segments.push(cut);
  }
  if (segments.length < 4) return null;
  let total = 0, centre = [0, 0, 0];
  for (const [a, b] of segments) { const l = dist(a, b); total += l; centre = vadd(centre, vmul(lerp(a, b, .5), l)); }
  centre = vmul(centre, 1 / total);
  const spread = segments.reduce((s, [a, b]) => s + dist(a, b) * d2(lerp(a, b, .5), centre), 0) / total;
  return { centre, radius: Math.sqrt(spread) };
}
// Follow a tube from `start` toward `toward` in steps, moving to the centre of each cut. Cuts at the capped ends are
// small (the cap is flat, so the cut curve shrinks), so the stations at both ends whose radius is under 60% of the median
// are dropped.
function centreline(mesh, start, toward, { step = 3, radius = 24 } = {}) {
  // Start 2 mm inside the end: a cut exactly in the plane of a flat cap has no usable cut curve.
  let d = vunit(vsub(toward, start)), p = vadd(start, vmul(d, 2));
  const stations = [];
  for (let i = 0; i < 300; i++) {
    const cut = cutCentre(mesh, p, d, radius);
    if (!cut) break;
    stations.push(cut);
    const previous = stations.length > 1 ? vunit(vsub(cut.centre, stations.at(-2).centre)) : d;
    d = vunit(vadd(vmul(d, .5), vmul(previous, .5)));
    p = vadd(cut.centre, vmul(d, step));
  }
  const median = stations.map(s => s.radius).sort((a, b) => a - b)[Math.floor(stations.length / 2)];
  while (stations.length && stations[0].radius < .6 * median) stations.shift();
  while (stations.length && stations.at(-1).radius < .6 * median) stations.pop();
  if (stations.length < 3) throw new Error('a vessel centreline is too short');
  return stations.map(s => s.centre);
}
// The vessel's centreline from the end nearest `from` to the far end, as an ordered list of points.
const vesselFrom = (mesh, from, opts) => centreline(mesh, endNear(mesh, from), endFar(mesh, from), opts);
// ... or from the far end to the end nearest `to` (toward the heart).
const vesselTo = (mesh, to, opts) => centreline(mesh, endFar(mesh, to), endNear(mesh, to), opts);
// Continue `first` with `second` (which starts near its end): cut `first` where it comes closest to the start of `second`.
function chain(first, second) {
  let cut = 0;
  first.forEach((p, i) => { if (d2(p, second[0]) < d2(first[cut], second[0])) cut = i; });
  return [...first.slice(0, cut + 1), ...second];
}

// Cavity solids, the centre of the largest sphere that fits in each (searched on a 3 mm grid), and each valve opening.
const cavityMesh = Object.fromEntries(Object.keys(cavities).map(id => [id, parts['cav' + id]]));
const cavitySolid = Object.fromEntries(Object.entries(cavityMesh).map(([id, mesh]) => [id, makeSolid(mesh)]));
function widestPoint(id) {
  const { min, max } = cavitySolid[id];
  let best = null;
  for (let x = min[0]; x <= max[0]; x += 3) for (let y = min[1]; y <= max[1]; y += 3) for (let z = min[2]; z <= max[2]; z += 3) {
    if (!inside(cavitySolid[id], [x, y, z])) continue;
    const clearance = nearestVertexDistance(cavityMesh[id], [x, y, z]);
    if (!best || clearance > best.clearance) best = { point: [x, y, z], clearance };
  }
  return best.point;
}
const core = Object.fromEntries(Object.keys(cavities).map(id => [id, widestPoint(id)]));
// A valve opening: the leaflet vertices that touch the chambers on both sides of the valve (the ring where the valve is
// attached), or for a semilunar valve those touching the ventricle (the cusps' base). The centre is their mean and the
// radius their rms distance from it. Both depend on the touching range, so the range is a display parameter.
function valveOpening(files, sides, range) {
  const ring = files.flatMap(pts).filter(p => sides.every(id => nearestVertexDistance(cavityMesh[id], p) < range));
  if (ring.length < 50) throw new Error(`valve ring of ${files}: only ${ring.length} vertices touch ${sides}`);
  const centre = mean(ring);
  return { centre, radius: Math.sqrt(ring.reduce((s, p) => s + d2(p, centre), 0) / ring.length) };
}
const opening = {
  tricuspid: valveOpening(['FJ2421', 'FJ2433', 'FJ2436'], ['ra', 'rv'], 4),
  mitral: valveOpening(['FJ2420', 'FJ2432'], ['la', 'lv'], 5),
  aortic: valveOpening(['FJ2426', 'FJ2431', 'FJ2435'], ['lv'], 2.5),
  pulmonary: valveOpening(['FJ2417', 'FJ2427', 'FJ2434'], ['rv'], 2.5),
};

// Vessel meshes as unsimplified solids for the centrelines; the checks below use the simplified parts that are shipped.
// clip() leaves the vertices it cut away in the array, so compact() keeps only those still used.
const cutAt = (id, planes) => compact(weld(clip(load(id), planes)));
const vessels = {
  svc: weld(load('FMA4720')), ivc: cutAt('FMA10951', [[Y, 1165, 1]]),
  trunk: weld(load('FJ2966')), lpa: cutAt('FJ2924', [[X, 70, -1]]), rpa: cutAt('FJ3019', [[X, -45, 1]]),
  // Each pulmonary vein is its longest part, the trunk. The other parts of the left veins (FJ2925, FJ2944, FJ2950) are
  // tributaries lying beside it; cutting them together puts the middle of the cut outside every one of them.
  lspv: weld(load('FJ2933')), lipv: weld(load('FJ2955')), rspv: weld(load('FJ3020')), ripv: weld(load('FJ3040')),
  ascending: weld(load('FMA3736')), arch: weld(load('FMA3768')),
};
// A branch that continues `trunkLine`: traced from its far end (a clean cross-section) back toward the trunk and stopped
// once it is within 8 mm of the trunk's middle line, because near the junction the two shells overlap and the cuts are
// not a tube any more. Returned from the junction outward.
function branchFrom(trunkLine, mesh, opts) {
  const back = vesselTo(mesh, trunkLine.at(-1), opts);
  const stop = back.findIndex(p => trunkLine.some(q => dist(p, q) < 8));
  return back.slice(0, stop < 0 ? back.length : stop + 1).reverse();
}
const pulmonaryOutflow = branch => { const trunk = vesselFrom(vessels.trunk, opening.pulmonary.centre, { radius: 22 }); return chain(trunk, branchFrom(trunk, vessels[branch], { radius: 22 })); };
const aorticOutflow = (() => { const ascending = vesselFrom(vessels.ascending, opening.aortic.centre, { radius: 22 }); return chain(ascending, branchFrom(ascending, vessels.arch, { radius: 24 })); })();

// A route is described by control points; marks name the ones that are chamber middles or valve centres.
function buildRoute({ id, side, outlet, inflow, atrium, atrioventricular, ventricle, arterial, outflow }) {
  const control = [], index = {};
  const mark = (name, p) => { index[name] = control.length; control.push(p); };
  control.push(...inflow);
  mark('atrium', core[atrium]); mark('atrioventricular', opening[atrioventricular].centre);
  mark('ventricle', core[ventricle]); mark('arterial', opening[arterial].centre);
  control.push(...outflow);
  // Resample every 2 mm, smooth with the valve centres held fixed, and store every 3 mm.
  const dense = [control[0]], pinned = new Map();
  for (let i = 1; i < control.length; i++) {
    const n = Math.max(1, Math.round(dist(control[i - 1], control[i]) / 2));
    for (let k = 1; k <= n; k++) dense.push(lerp(control[i - 1], control[i], k / n));
    for (const name of ['atrioventricular', 'arterial']) if (index[name] === i) pinned.set(dense.length - 1, name);
  }
  pinned.set(0, 'start'); pinned.set(dense.length - 1, 'end');
  let line = dense;
  for (let pass = 0; pass < 40; pass++) line = line.map((p, i) => pinned.has(i) ? p : lerp(p, mean([line[i - 1], line[i + 1]]), .5));
  const lengths = [0];
  line.forEach((p, i) => { if (i) lengths.push(lengths[i - 1] + dist(p, line[i - 1])); });
  // The ends are cut open at the vessels' clip planes, where a vessel is not closed around the line, so 10 mm are left off each end.
  const trim = 10, count = Math.round((lengths.at(-1) - 2 * trim) / 3), points = [];
  for (let k = 0; k <= count; k++) {
    const s = trim + (lengths.at(-1) - 2 * trim) * k / count;
    let j = 1; while (j < lengths.length - 1 && lengths[j] < s) j++;
    points.push(lerp(line[j - 1], line[j], (s - lengths[j - 1]) / (lengths[j] - lengths[j - 1] || 1)));
  }
  const rounded = round(points), marks = {};
  for (const name of ['atrium', 'ventricle']) marks[name] = rounded.reduce((best, p, i) => dist(p, core[name === 'atrium' ? atrium : ventricle]) < dist(rounded[best], core[name === 'atrium' ? atrium : ventricle]) ? i : best, 0);
  for (const [name, valve] of [['atrioventricular', atrioventricular], ['arterial', arterial]]) marks[name] = rounded.reduce((best, p, i) => dist(p, opening[valve].centre) < dist(rounded[best], opening[valve].centre) ? i : best, 0);
  return { id, side, outlet, points: rounded, marks };
}
const routeSpecs = [
  { id: 'svc', side: 'right', outlet: 'lpa', inflow: vesselTo(vessels.svc, core.ra), atrium: 'ra', atrioventricular: 'tricuspid', ventricle: 'rv', arterial: 'pulmonary', outflow: pulmonaryOutflow('lpa') },
  { id: 'ivc', side: 'right', outlet: 'rpa', inflow: vesselTo(vessels.ivc, core.ra), atrium: 'ra', atrioventricular: 'tricuspid', ventricle: 'rv', arterial: 'pulmonary', outflow: pulmonaryOutflow('rpa') },
  ...['lspv', 'lipv', 'rspv', 'ripv'].map(id => ({ id, side: 'left', outlet: 'arch', inflow: vesselTo(vessels[id], core.la, { radius: 18 }), atrium: 'la', atrioventricular: 'mitral', ventricle: 'lv', arterial: 'aortic', outflow: aorticOutflow })),
];
const flow = {
  valves: Object.fromEntries(Object.entries(opening).map(([id, v]) => [id, { center: round([v.centre])[0], radius: Math.round(v.radius * 10) / 10 }])),
  routes: routeSpecs.map(buildRoute),
};

// Build-time check (checkRoute in flow-geometry.mjs, which the unit tests run too): along the curve the viewer will draw
// through the stored points, every millimetre must be inside a cavity or the vessel; the few short stretches that are
// not are the valve roots and the entries of veins through the atrial wall, where the meshes have no opening.
const vesselSolids = { vc: makeSolid(parts.vc), pa: makeSolid(parts.pa), pv: makeSolid(parts.pv), ao: makeSolid(parts.ao) };
const vesselsOf = { right: ['vc', 'pa'], left: ['pv', 'ao'] }, expectedOrder = { right: ['ra', 'rv'], left: ['la', 'lv'] };
for (const route of flow.routes) {
  const curve = new CatmullRomCurve3(route.points.map(p => new Vector3(...p)), false, 'centripetal');
  const regions = { cavities: cavitySolid, vessels: Object.fromEntries(vesselsOf[route.side].map(id => [id, vesselSolids[id]])), valves: flow.valves };
  const result = checkRoute(curve, regions, expectedOrder[route.side]);
  console.log(`route ${route.id.padEnd(5)} ${String(route.points.length).padStart(3)} points, ${result.samples} samples, cavities ${result.order}, gaps ${result.gaps.map(g => `${g.length} mm ${g.atValve ? 'at a valve' : 'at a junction'}`).join('; ') || 'none'}`);
  if (result.problems.length) throw new Error(`route ${route.id}: ${result.problems.join('; ')}`);
}

// Binary layout: "BP3D", uint32 JSON length, JSON, then per part Int16 positions (0.01 mm steps
// around the heart centre) and Uint16 indices, each 4-byte aligned.
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const mesh of Object.values(parts)) mesh.positions.forEach((v, i) => {
  min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v);
});
const center = [0, 1, 2].map(k => Math.round((min[k] + max[k]) / 2 * 100) / 100);
const step = .01, chunks = [], meta = { format: 6, unit: 'mm', step, center, parts: [], conduction, flow };
let offset = 0;
for (const [id, mesh] of Object.entries(parts)) {
  const count = mesh.positions.length / 3;
  if (count > 65535) throw new Error(`${id} has too many vertices for Uint16 indices`);
  const positions = Int16Array.from(mesh.positions, (v, i) => Math.round((v - center[i % 3]) / step));
  const indices = Uint16Array.from(mesh.indices);
  meta.parts.push({ id, vertices: count, indices: indices.length, positionOffset: offset, indexOffset: offset + positions.byteLength });
  const indexBytes = Buffer.from(indices.buffer), pad = (4 - indexBytes.length % 4) % 4;
  chunks.push(Buffer.from(positions.buffer), indexBytes, Buffer.alloc(pad));
  offset += positions.byteLength + indexBytes.length + pad;
}
let json = Buffer.from(JSON.stringify(meta));
json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const head = Buffer.alloc(8);
head.write('BP3D', 0, 'latin1');
head.writeUInt32LE(json.length, 4);
mkdirSync('src/data', { recursive: true });
writeFileSync('src/data/bodyparts3d-heart.bin', Buffer.concat([head, json, ...chunks]));
for (const p of meta.parts) console.log(p.id.padEnd(3), String(p.vertices).padStart(6), 'vertices', String(p.indices / 3).padStart(6), 'triangles');
console.log('Wrote src/data/bodyparts3d-heart.bin', 8 + json.length + offset, 'bytes');
