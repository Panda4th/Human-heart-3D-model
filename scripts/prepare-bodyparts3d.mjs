// Convert BodyParts3D OBJ files into the compact mesh bundle embedded in index.html.
// Usage: node scripts/prepare-bodyparts3d.mjs <BodyParts3D_3.0_obj_99.zip> <partof_BP3D_4.0_obj_99.zip>
// Downloads (free, no registration): https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
// and https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';

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
for (const [path, expected] of Object.entries(expectedSha256)) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
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
// Viewer axes in mm: 0 = patient's left, 1 = superior. Cuts keep vessel stubs near the heart.
const X = 0, Y = 1;
const parts = {
  ...Object.fromEntries(Object.entries(chambers).map(([id, indices]) => [id, compact({ positions: wall.positions, indices })])),
  ao: part(['FMA3736', 'FMA3768', 'FMA3784', 'FJ3417', 'FJ3479', 'FJ3483'], [[Y, 1175, 1], [Y, 1355, -1], [X, 45, -1]]),
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
};

// Anchor points for the explanatory conduction overlay. BodyParts3D has no conduction-system
// meshes, so positions are derived from nearby structures in the usual textbook relation:
// SA node at the SVC-right atrium junction, AV node between the coronary sinus ostium and the
// septal tricuspid leaflet hinge, His bundle to the septal crest below the non-coronary aortic cusp,
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
const sinus = pts('FJ2655'), sinusRight = Math.min(...sinus.map(p => p[0]));
const sinusOstium = mean(sinus.filter(p => p[0] < sinusRight + 5));
// Septal tricuspid leaflet hinge: the part of the leaflet touching the RA cavity.
const septalLeaflet = pts('FJ2436');
const septalHinge = mean(septalLeaflet.filter(p => d2(nearest(cav.ra, p), p) < 4 ** 2));
// The RA cavity mesh has no vertex there (tricuspid orifice), so keep the midpoint itself.
const av = lerp(sinusOstium, septalHinge, .5);
const septumLV = cav.lv.filter(p => d2(nearest(cav.rv, p), p) < 15 ** 2);
const septumRV = cav.rv.filter(p => d2(nearest(cav.lv, p), p) < 15 ** 2);
const nonCoronaryCusp = extreme(pts('FJ2431'), p => -p[1]);
const bifurcation = nearest(septumLV, [nonCoronaryCusp[0], nonCoronaryCusp[1] - 12, nonCoronaryCusp[2]]);
const mitral = mean([...pts('FJ2420'), ...pts('FJ2432')]);
const lvApex = extreme(cav.lv, p => d2(p, mitral));
const rvModerator = extreme(pts('FJ2419'), p => -p[1]); // base of the anterior papillary muscle
const laAppendage = extreme(pts('FJ2438'), p => p[0] + p[1] * .5);
const lvLateral = mean(pts('FJ2429')), lvAnterior = mean(pts('FJ2418'));
const tricuspidAnterior = mean(pts('FJ2421')), pulmonary = mean([...pts('FJ2417'), ...pts('FJ2427'), ...pts('FJ2434')]);
const atrialWall = [...pts('FJ2439'), ...pts('FJ2438')];
const round = set => set.map(p => p.map(v => Math.round(v * 10) / 10));
const conduction = {
  nodes: { sa: round([sa])[0], av: round([av])[0] },
  paths: {
    atria: [round(along(cav.ra, [sa, lerp(sa, av, .5), av])), round(along(atrialWall, [sa, lerp(sa, laAppendage, .5), laAppendage]))],
    his: [round(along(septumLV, [av, bifurcation], 4).map((p, i) => i === 0 ? av : p))],
    branches: [
      round(along(septumLV, [bifurcation, lerp(bifurcation, lvApex, .5), lvApex])),
      round([bifurcation, ...along(septumRV, [bifurcation, lerp(bifurcation, rvModerator, .5)]), nearest(cav.rv, rvModerator)]),
    ],
    purkinje: [
      round(along(cav.lv, [lvApex, lvLateral, lerp(lvLateral, mitral, .6)])),
      round(along(cav.lv, [lvApex, lvAnterior, lerp(lvAnterior, mitral, .6)])),
      round(along(cav.rv, [rvModerator, tricuspidAnterior])),
      round(along(cav.rv, [rvModerator, lerp(rvModerator, pulmonary, .7)])),
    ],
  },
};

// Binary layout: "BP3D", uint32 JSON length, JSON, then per part Int16 positions (0.01 mm steps
// around the heart centre) and Uint16 indices, each 4-byte aligned.
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const mesh of Object.values(parts)) mesh.positions.forEach((v, i) => {
  min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v);
});
const center = [0, 1, 2].map(k => Math.round((min[k] + max[k]) / 2 * 100) / 100);
const step = .01, chunks = [], meta = { format: 3, unit: 'mm', step, center, parts: [], conduction };
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
