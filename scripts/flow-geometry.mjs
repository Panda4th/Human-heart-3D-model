// Ray tests on triangle meshes, shared by the generator (scripts/prepare-bodyparts3d.mjs) and the unit tests, so the build
// and the tests judge "inside the cavity" and "enclosed by the vessel" in the same way. A mesh is { positions, indices }
// with flat arrays, in millimetres.
export function makeSolid(mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], mesh.positions[i + a]); max[a] = Math.max(max[a], mesh.positions[i + a]);
  }
  return { positions: mesh.positions, indices: mesh.indices, min, max };
}

// Distances along the ray from `origin` in the unit direction `dir` to every triangle it crosses, nearest first.
export function rayHits(solid, origin, dir) {
  const { positions: P, indices: I } = solid, hits = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const hx = dir[1] * e2z - dir[2] * e2y, hy = dir[2] * e2x - dir[0] * e2z, hz = dir[0] * e2y - dir[1] * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det, sx = origin[0] - P[a], sy = origin[1] - P[a + 1], sz = origin[2] - P[a + 2];
    const u = f * (sx * hx + sy * hy + sz * hz);
    // A small tolerance keeps a ray that runs exactly along an edge from slipping between the two triangles that share it;
    // such a ray then counts both, and inside() merges hits closer than 0.02 mm.
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (dir[0] * qx + dir[1] * qy + dir[2] * qz);
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const distance = f * (e2x * qx + e2y * qy + e2z * qz);
    if (distance > 1e-9) hits.push(distance);
  }
  return hits.sort((x, y) => x - y);
}

// Directions with no particular relation to the mesh axes, so a ray rarely runs along an edge.
const directions = [[1, 1, 1], [-.3, .8, .52], [.2, -.6, .77], [.9, .1, -.42]].map(d => { const l = Math.hypot(...d); return d.map(x => x / l); });
// Whether the point is inside a closed mesh: an odd number of crossings along most of the rays. Hits closer than 0.02 mm
// are counted once, because the heart wall holds pairs of duplicated triangles (README, "壁の重複三角形").
export function inside(solid, point) {
  for (let a = 0; a < 3; a++) if (point[a] < solid.min[a] || point[a] > solid.max[a]) return false;
  let odd = 0;
  for (const dir of directions) {
    const hits = rayHits(solid, point, dir);
    if (hits.filter((h, i) => i === 0 || h - hits[i - 1] > .02).length % 2) odd++;
  }
  return odd >= 3;
}

// Distance from the point to the nearest vertex of the mesh. Meshes here have vertices a few mm apart.
export function nearestVertexDistance(mesh, point) {
  let best = Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    best = Math.min(best, (mesh.positions[i] - point[0]) ** 2 + (mesh.positions[i + 1] - point[1]) ** 2 + (mesh.positions[i + 2] - point[2]) ** 2);
  }
  return Math.sqrt(best);
}

// A vessel mesh is several shells (the pulmonary arteries are a trunk and two branches that overlap; the pulmonary veins
// are separate parts). Split it into connected components, and close each component's open rims with a fan of triangles so
// that a component that was cut open at a clip plane is a closed solid. The caps exist only for this test. Whether a point is
// in the vessel is then a question about each component on its own: inside one of them, not "some wall in every direction".
export function makeVessel(mesh) {
  const key = i => [0, 1, 2].map(k => Math.round(mesh.positions[i * 3 + k] * 100)).join(','), id = new Map(), vertexOf = [], position = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    if (!id.has(key(i))) { id.set(key(i), position.length); position.push(mesh.positions.slice(i * 3, i * 3 + 3)); }
    vertexOf.push(id.get(key(i)));
  }
  const triangles = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [0, 1, 2].map(k => vertexOf[mesh.indices[t + k]]);
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) triangles.push(tri);
  }
  const root = position.map((_, i) => i), find = i => root[i] === i ? i : (root[i] = find(root[i]));
  for (const [a, b, c] of triangles) { root[find(a)] = find(b); root[find(b)] = find(c); }
  const uses = new Map();
  for (const tri of triangles) for (let k = 0; k < 3; k++) {
    const a = tri[k], b = tri[(k + 1) % 3], edge = a < b ? a + ',' + b : b + ',' + a;
    uses.set(edge, (uses.get(edge) || 0) + 1);
  }
  const rim = [];
  for (const [edge, n] of uses) if (n === 1) rim.push(edge.split(',').map(Number));
  // Group the rim edges into loops (rim vertices that are joined by rim edges), and fan each loop to its centroid.
  const loopOf = new Map(), loopFind = i => { while (loopOf.has(i) && loopOf.get(i) !== i) i = loopOf.get(i); return i; };
  for (const [a, b] of rim) loopOf.set(loopFind(a), loopFind(b));
  const loops = new Map();
  for (const [a, b] of rim) { const r = loopFind(a); if (!loops.has(r)) loops.set(r, []); loops.get(r).push([a, b]); }
  const capped = triangles.map(t => [...t]);
  for (const edges of loops.values()) {
    const vertices = [...new Set(edges.flat())], centre = [0, 1, 2].map(k => vertices.reduce((sum, v) => sum + position[v][k], 0) / vertices.length);
    const apex = position.push(centre) - 1;
    for (const [a, b] of edges) capped.push([a, b, apex]);
  }
  const groups = new Map();
  // A cap triangle's first vertex is a rim vertex of the component it closes.
  for (const tri of capped) { const r = find(tri[0]); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(tri); }
  const components = [...groups.values()].map(tris => {
    const flat = [], remap = new Map(), indices = [];
    for (const tri of tris) for (const v of tri) { if (!remap.has(v)) { remap.set(v, flat.length / 3); flat.push(...position[v]); } indices.push(remap.get(v)); }
    return makeSolid({ positions: flat, indices });
  });
  return { components };
}

// The distance from a point to the nearest point of a triangle (Ericson, Real-Time Collision Detection, 5.1.5).
function triangleDistance(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (...w) => Math.hypot(p[0] - (a[0] * w[0] + b[0] * w[1] + c[0] * w[2]), p[1] - (a[1] * w[0] + b[1] * w[1] + c[1] * w[2]), p[2] - (a[2] * w[0] + b[2] * w[1] + c[2] * w[2]));
  if (d1 <= 0 && d2 <= 0) return at(1, 0, 0);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(0, 1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at(1 - v, v, 0); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at(1 - w, 0, w); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return at(0, 1 - w, w); }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return at(1 - v - w, v, w);
}

// How far the point is inside the vessel: the largest, over the components that contain it, of the shortest distance to
// that component's surface. -1 when no component contains it. The surface of one component can lie inside the lumen of
// another (a branch's end inside the trunk), so a point must be judged by the component it is in, and the best one
// counts: the true clearance to the outline of the union is at least that. Caps (see makeVessel) count as wall.
export function vesselClearance(vessel, point) {
  let best = -1;
  for (const solid of vessel.components) {
    if (!inside(solid, point)) continue;
    let nearest = Infinity;
    for (let t = 0; t < solid.indices.length; t += 3) {
      const at = i => [solid.positions[solid.indices[t + i] * 3], solid.positions[solid.indices[t + i] * 3 + 1], solid.positions[solid.indices[t + i] * 3 + 2]];
      nearest = Math.min(nearest, triangleDistance(point, at(0), at(1), at(2)));
    }
    best = Math.max(best, nearest);
  }
  return best;
}

// Checks one blood-flow route against the cavities and vessels it should run through. `curve` is the curve the viewer
// draws through the stored points (it needs getLength, getPointAt and getTangentAt, each returning something with
// toArray). It is sampled every millimetre and each sample is one of:
//   - a cavity: inside one of regions.cavities (id -> solid);
//   - the vessel: inside one of the components of regions.vessels (makeVessel results) with at least minWall mm to that
//     component's surface, measured in 3D;
//   - a gap: neither. The meshes have no wall opening where a vein or vena cava enters an atrium, and nothing around the
//     root of a valve, so a short gap is expected there. A gap is accepted only when it is at most maxGap mm long and
//     either lies within valveGate mm of a valve centre, or joins a vessel to a cavity.
// The cavities visited must come in `expectedOrder`. Returns { samples, order, gaps, longestGap, problems }.
export function checkRoute(curve, regions, expectedOrder, { minWall = 1, maxGap = 10, valveGate = 8 } = {}) {
  const n = Math.ceil(curve.getLength()), kinds = [], nearValve = [];
  for (let i = 0; i <= n; i++) {
    const p = curve.getPointAt(i / n).toArray();
    const owner = Object.keys(regions.cavities).find(id => inside(regions.cavities[id], p));
    if (owner) { kinds.push(owner); nearValve.push(false); continue; }
    const enclosed = Object.values(regions.vessels).some(vessel => vesselClearance(vessel, p) >= minWall);
    kinds.push(enclosed ? 'vessel' : 'gap');
    nearValve.push(Object.values(regions.valves).some(v => Math.hypot(p[0] - v.center[0], p[1] - v.center[1], p[2] - v.center[2]) < valveGate));
  }
  const order = [], gaps = [], problems = [];
  kinds.forEach((kind, i) => { if (kind !== 'vessel' && kind !== 'gap' && order.at(-1) !== kind) order.push(kind); });
  for (let i = 0; i < kinds.length;) {
    if (kinds[i] !== 'gap') { i++; continue; }
    let j = i; while (j < kinds.length && kinds[j] === 'gap') j++;
    const before = i ? kinds[i - 1] : null, after = j < kinds.length ? kinds[j] : null;
    const joins = before && after && (before === 'vessel') !== (after === 'vessel');
    const atValve = nearValve.slice(i, j).every(Boolean);
    gaps.push({ start: i, length: j - i, before, after, atValve, joins });
    if (j - i > maxGap) problems.push(`a ${j - i} mm stretch from ${i} mm is in neither a cavity nor the vessel`);
    else if (!atValve && !joins) problems.push(`a ${j - i} mm stretch from ${i} mm (between ${before} and ${after}) is not at a valve or a vessel-to-cavity junction`);
    i = j;
  }
  if (order.join() !== expectedOrder.join()) problems.push(`cavities visited ${order}, expected ${expectedOrder}`);
  return { samples: kinds.length, order, gaps, longestGap: Math.max(0, ...gaps.map(g => g.length)), problems };
}
