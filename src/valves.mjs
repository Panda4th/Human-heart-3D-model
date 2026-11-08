// Schematic valve leaflets for the blood-flow view. Kept free of WebGL so Node tests can check the geometry.
//
// Not the valves of the source data (those are one frozen moment of the leaflets and cannot open) and not a model of how a
// valve moves. Each valve is a ring in the plane through its opening (meta.flow.valves: centre and radius), split into as many
// sector-shaped leaflets as the valve has cusps. A leaflet is attached along its arc on the ring; its free corner starts at
// the centre (closed: a flat disc) and swings outwards and downstream (open: the leaflets stand off the axis and leave a
// round passage). The shape, the number of leaflets and all sizes below are chosen for display; no source gives them.
// Only the leaflet count follows the part descriptions on screen (anatomy.mjs): tricuspid 3, mitral 2, aortic 3, pulmonary 3.

export const valveNames = ['tricuspid', 'mitral', 'aortic', 'pulmonary'];
export const valveKind = { tricuspid: 'atrioventricular', mitral: 'atrioventricular', aortic: 'arterial', pulmonary: 'arterial' };
export const leafletCount = { tricuspid: 3, mitral: 2, aortic: 3, pulmonary: 3 };
// ring: share of the stored opening radius that is drawn (the stored radius is the rms distance of the valve's attachment
// vertices, so the full radius reaches the walls). apex: how far from the axis the free corner stands when open, as a share
// of the drawn ring. lift: how far downstream it stands, same unit. arcSegments: triangles per leaflet along the arc.
// radius: the radius of a particle (the sphere drawn in main.js) and margin: the clearance kept beyond it.
export const valveSettings = { ring: .7, apex: .75, lift: .25, arcSegments: 4, particleRadius: 1.5, margin: .5 };

// Which valve a route passes. The right heart has the tricuspid and the pulmonary valve, the left heart the mitral and the aortic.
export const valveOfRoute = (side, kind) => ({ right: { atrioventricular: 'tricuspid', arterial: 'pulmonary' }, left: { atrioventricular: 'mitral', arterial: 'aortic' } })[side][kind];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => mul(a, 1 / (Math.hypot(...a) || 1));
const smooth = s => s * s * (3 - 2 * s);

// The direction of flow through each valve: the mean of the route directions at the valve, over the routes that pass it.
export function valveAxes(flow) {
  const sums = Object.fromEntries(valveNames.map(name => [name, [0, 0, 0]]));
  for (const route of flow.routes) {
    for (const kind of ['atrioventricular', 'arterial']) {
      const m = route.marks[kind], t = unit(sub(route.points[Math.min(m + 2, route.points.length - 1)], route.points[Math.max(m - 2, 0)]));
      const name = valveOfRoute(route.side, kind);
      sums[name] = add(sums[name], t);
    }
  }
  return Object.fromEntries(valveNames.map(name => [name, unit(sums[name])]));
}

export function createValve(name, spec, axis, settings = valveSettings) {
  const n = leafletCount[name], ring = spec.radius * settings.ring, w = unit(axis);
  // The ring's own directions: u is the world up direction made perpendicular to the axis. Where the first leaflet lies is arbitrary.
  const up = [0, 1, 0], u = unit(sub(up, mul(w, dot(up, w)))), v = cross(w, u);
  const radial = angle => add(mul(u, Math.cos(angle)), mul(v, Math.sin(angle)));
  const per = settings.arcSegments + 1, vertices = 1 + per;
  const indices = [];
  for (let j = 0; j < n; j++) for (let k = 0; k < settings.arcSegments; k++) indices.push(j * vertices, j * vertices + 1 + k, j * vertices + 2 + k);
  const lift = settings.lift * ring, zoneUp = settings.particleRadius + settings.margin;
  // Positions of all vertices when the valve is `openness` open (0 closed, 1 open), written to out (3 numbers per vertex).
  function pose(openness, out = new Float64Array(n * vertices * 3)) {
    const e = smooth(Math.min(1, Math.max(0, openness)));
    for (let j = 0; j < n; j++) {
      const middle = 2 * Math.PI * j / n, base = j * vertices * 3;
      const apex = add(add(spec.center, mul(radial(middle), settings.apex * ring * e)), mul(w, lift * e));
      out[base] = apex[0]; out[base + 1] = apex[1]; out[base + 2] = apex[2];
      for (let k = 0; k <= settings.arcSegments; k++) {
        const p = add(spec.center, mul(radial(middle - Math.PI / n + 2 * Math.PI / n * k / settings.arcSegments), ring));
        out.set(p, base + 3 + 3 * k);
      }
    }
    return out;
  }
  return {
    name, leaflets: n, center: spec.center, axis: w, ring, radius: spec.radius, lift,
    // Clearance kept between a particle's centre and a leaflet, and the distance upstream of the ring's plane at which a
    // particle waits for a closed valve (the closed leaflets lie in that plane).
    zoneUp,
    vertexCount: n * vertices, indices: Uint16Array.from(indices), pose,
  };
}

export function createValves(flow, settings = valveSettings) {
  const axes = valveAxes(flow);
  return Object.fromEntries(valveNames.map(name => [name, createValve(name, flow.valves[name], axes[name], settings)]));
}

// Distance from the point p to the triangle abc (all [x, y, z]).
export function pointTriangleDistance(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return Math.hypot(...sub(p, add(a, mul(ab, d1 / (d1 - d3)))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return Math.hypot(...sub(p, add(a, mul(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return Math.hypot(...sub(p, add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))))));
  const denom = 1 / (va + vb + vc), s = vb * denom, t = vc * denom;
  return Math.hypot(...sub(p, add(a, add(mul(ab, s), mul(ac, t)))));
}

// Distance from the point p to the nearest leaflet of a posed valve (positions as written by pose).
export function leafletDistance(valve, positions, p) {
  let best = Infinity;
  const at = i => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
  for (let t = 0; t < valve.indices.length; t += 3) best = Math.min(best, pointTriangleDistance(p, at(valve.indices[t]), at(valve.indices[t + 1]), at(valve.indices[t + 2])));
  return best;
}
