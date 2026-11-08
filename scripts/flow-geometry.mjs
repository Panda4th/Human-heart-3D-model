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

// For a point on a tube's axis: the distance to the tube's outer wall, as the smallest over `count` rays spread around the
// axis, perpendicular to `tangent`, of the distance to the LAST wall each ray crosses. A vessel mesh made of several
// overlapping shells has walls inside the lumen where one shell's end lies inside another, and those must not count as
// the vessel wall, so the outermost crossing is used. Infinity when any ray crosses nothing (it leaves through an
// opening, or the point is outside the vessel), which is how a point that is not enclosed is told apart.
export function wallDistanceAround(solid, point, tangent, count = 12) {
  const t = tangent.map(x => x / Math.hypot(...tangent));
  const helper = Math.abs(t[1]) < .9 ? [0, 1, 0] : [1, 0, 0];
  let u = [t[1] * helper[2] - t[2] * helper[1], t[2] * helper[0] - t[0] * helper[2], t[0] * helper[1] - t[1] * helper[0]];
  u = u.map(x => x / Math.hypot(...u));
  const w = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  let nearest = Infinity;
  for (let k = 0; k < count; k++) {
    const angle = 2 * Math.PI * k / count, dir = [0, 1, 2].map(i => Math.cos(angle) * u[i] + Math.sin(angle) * w[i]);
    const hits = rayHits(solid, point, dir);
    if (!hits.length) return Infinity;
    nearest = Math.min(nearest, hits.at(-1));
  }
  return nearest;
}

// Checks one blood-flow route against the cavities and vessels it should run through. `curve` is the curve the viewer
// draws through the stored points (it needs getLength, getPointAt and getTangentAt, each returning something with
// toArray). It is sampled every millimetre and each sample is one of:
//   - a cavity: inside one of regions.cavities (id -> solid);
//   - the vessel: enclosed by one of regions.vessels (solids) with at least minWall mm to the outer wall;
//   - a gap: neither. The meshes have no wall opening where a vein or vena cava enters an atrium, and nothing around the
//     root of a valve, so a short gap is expected there. A gap is accepted only when it is at most maxGap mm long and
//     either lies within valveGate mm of a valve centre, or joins a vessel to a cavity.
// The cavities visited must come in `expectedOrder`. Returns { samples, order, gaps, longestGap, problems }.
export function checkRoute(curve, regions, expectedOrder, { minWall = 1, maxGap = 10, valveGate = 8 } = {}) {
  const n = Math.ceil(curve.getLength()), kinds = [], nearValve = [];
  for (let i = 0; i <= n; i++) {
    const p = curve.getPointAt(i / n).toArray(), tangent = curve.getTangentAt(i / n).toArray();
    const owner = Object.keys(regions.cavities).find(id => inside(regions.cavities[id], p));
    if (owner) { kinds.push(owner); nearValve.push(false); continue; }
    // Infinity means a ray left through an opening: not enclosed.
    const enclosed = Object.values(regions.vessels).some(solid => { const wall = wallDistanceAround(solid, p, tangent); return Number.isFinite(wall) && wall >= minWall; });
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
