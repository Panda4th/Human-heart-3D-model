// Convert BodyParts3D OBJ files into the compact mesh bundle embedded in index.html.
// Usage: node scripts/prepare-bodyparts3d.mjs <BodyParts3D_3.0_obj_99.zip> <partof_BP3D_4.0_obj_99.zip>
// Downloads (free, no registration): https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
// and https://dbarchive.biosciencedbc.jp/data/bodyparts3d/20110915/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { MeshoptSimplifier } from 'meshoptimizer';

const [v3Path, v4Path] = process.argv.slice(2);
if (!v3Path || !v4Path) throw new Error('Usage: node scripts/prepare-bodyparts3d.mjs <v3 zip> <v4 partof zip>');

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
  ao: part(['FMA3736', 'FMA3768', 'FMA3784', 'FJ3479', 'FJ3483'], [[Y, 1175, 1], [Y, 1355, -1], [X, 45, -1]]),
  pa: part(['FJ2966', 'FJ2924', 'FJ3019'], [[X, -45, 1], [X, 70, -1]]),
  vc: part(['FMA4720', 'FMA10951'], [[Y, 1165, 1]]),
  pv: part(['FJ2925', 'FJ2933', 'FJ2944', 'FJ2950', 'FJ2955', 'FJ3020', 'FJ3040']),
  ca: part(v4ByName(coronaryArtery), [], .4),
  cv: part(v4ByName(cardiacVein), [], .4),
};

// Binary layout: "BP3D", uint32 JSON length, JSON, then per part Int16 positions (0.01 mm steps
// around the heart centre) and Uint16 indices, each 4-byte aligned.
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const mesh of Object.values(parts)) mesh.positions.forEach((v, i) => {
  min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v);
});
const center = [0, 1, 2].map(k => Math.round((min[k] + max[k]) / 2 * 100) / 100);
const step = .01, chunks = [], meta = { format: 1, unit: 'mm', step, center, parts: [] };
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
