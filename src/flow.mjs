import { cycle, isovolumic, period, valvesAt } from './heartbeat.mjs';
import { createValves, leafletDistance, valveKind, valveNames, valveOfRoute } from './valves.mjs';

// Schematic blood-flow particles. Kept free of WebGL so Node tests can check it.
//
// Each route (meta.flow.routes) is a closed ring of particles: one that leaves the end of the vessel comes back in at its
// start. A particle moves along the route at a speed that depends on where it is and on the phase of the beat, and stops
// behind a closed valve, so the particles behind it queue up. Nothing here is a flow simulation: the speeds are display
// values, chosen so that in each beat the same amount of blood goes through the atrioventricular valve and the arterial valve.
//
// What follows the source (OpenStax Anatomy and Physiology 2e, 19.3, see heartbeat.mjs): the atrioventricular valves are open
// in atrial systole and in the filling that ends the ventricular diastole, the arterial valves only in the ejection, and the
// atrial systole delivers the last 20 to 30% of the ventricular filling. What is chosen for display:
//   - ejectionFraction: the share of the ventricular segment of the route that is emptied in one beat;
//   - atrialShare: 25%, the middle of the source's 20 to 30%;
//   - the lengths of the isovolumic periods (heartbeat.mjs), gap, the speeds and the particle count;
//   - the schematic leaflets (valves.mjs) and how long they take to swing (ramp, milliseconds).
//
// The leaflets are part of the simulation, not only a drawing. A particle may pass the wall in front of a valve only while
// the valve's binary window is open and its leaflets are completely open, and a leaflet only takes a pose that keeps the
// clearance (valves.mjs) from every particle near the valve; otherwise it waits. So a particle never meets a leaflet, moving or
// not, whatever the frame interval is.
export const flowSettings = { gap: 4, ejectionFraction: .6, atrialShare: .25, spacing: 6.5, step: 4, warmUp: 4, ramp: 25 };

const clamp01 = x => Math.min(1, Math.max(0, x));
const ejection = { from: cycle.atrialSystole + isovolumic.contraction, to: cycle.atrialSystole + cycle.ventricularSystole };
const filling = { from: ejection.to + isovolumic.relaxation, to: period };
// Times within a beat at which a valve opens or closes or the atrial speed changes. An integration step never crosses one, so
// every step has one valve state and one set of speeds, whatever the frame interval is.
const boundaries = [cycle.atrialSystole, ejection.from, ejection.to, filling.from, period];

// Arc length of the point of the polyline nearest to p, and its distance (the route passes a valve within a millimetre or two of
// the centre of its opening).
function arcNearest(points, cum, p) {
  let best = { arc: 0, distance: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], ab = [points[i][0] - a[0], points[i][1] - a[1], points[i][2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const length2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, f = Math.min(1, Math.max(0, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / length2));
    const distance = Math.hypot(ap[0] - ab[0] * f, ap[1] - ab[1] * f, ap[2] - ab[2] * f);
    if (distance < best.distance) best = { arc: cum[i - 1] + f * Math.sqrt(length2), distance };
  }
  return best;
}

// Arc length at which the polyline is `z` along the valve's axis from the plane of its ring, the crossing nearest to arc `near`.
function arcAtAxial(points, cum, valve, z, near) {
  const axial = p => (p[0] - valve.center[0]) * valve.axis[0] + (p[1] - valve.center[1]) * valve.axis[1] + (p[2] - valve.center[2]) * valve.axis[2];
  let best = null;
  for (let i = 1; i < points.length; i++) {
    const a = axial(points[i - 1]) - z, b = axial(points[i]) - z;
    if (a < 0 && b >= 0) {
      const arc = cum[i - 1] + (cum[i] - cum[i - 1]) * (-a / (b - a));
      if (best === null || Math.abs(arc - near) < Math.abs(best - near)) best = arc;
    }
  }
  if (best === null) throw new Error(`a route does not cross the plane ${z} mm from a valve`);
  return best;
}

// Arc length of every route point, the positions of the two valve mouths and the atrium centre along the route, the zone of
// each valve along the route, and the speeds. A route is described by the mark indices of the generated data (README, 血流の経路).
function prepareRoute(route, settings, valves) {
  const { points, marks } = route, cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    cum.push(cum[i - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  const length = cum.at(-1), atrium = cum[marks.atrium], av = cum[marks.atrioventricular], arterial = cum[marks.arterial];
  // Distance that the train of particles in the ventricular segment travels in one beat. Ejection moves it through the arterial
  // valve; the same distance comes in through the atrioventricular valve, a quarter of it in atrial systole.
  const travel = settings.ejectionFraction * (arterial - av);
  // Where the route passes each valve, in arc length: the plane of the valve's ring (centre) and the wall at which a particle
  // waits for a closed valve, one clearance (valves.mjs, zoneUp) upstream of that plane along the valve's axis. Both are the
  // crossing of the route with a plane perpendicular to the axis that lies nearest to the centre of the valve's opening.
  const zone = {}, valve = {};
  for (const kind of ['atrioventricular', 'arterial']) {
    valve[kind] = valveOfRoute(route.side, kind);
    const v = valves[valve[kind]], near = arcNearest(points, cum, v.center).arc;
    zone[kind] = { center: arcAtAxial(points, cum, v, 0, near), lo: arcAtAxial(points, cum, v, -(v.zoneUp + .1), near), hi: arcAtAxial(points, cum, v, v.lift + v.zoneUp, near) };
  }
  return {
    id: route.id, side: route.side, points, cum, length, atrium, av, arterial, travel, zone, valve,
    speed: {
      ejection: travel / (ejection.to - ejection.from),
      passive: (1 - settings.atrialShare) * travel / (filling.to - filling.from),
      atrial: settings.atrialShare * travel / cycle.atrialSystole,
      // Veins and arteries: spacing about twice the queue gap in the free stream.
      stream: travel / (period / 2),
    },
  };
}

// Speed at arc length p on the route r at time ms. The particle never enters a closed valve; that is the caller's job.
// Through a valve's zone (the stretch the leaflets reach, from the wall in front of it to `hi`) a particle is never slower than
// in the ejection: blood speeds up through the opening (a display value), and the zone is cleared soon after the valve's window
// ends, so that the leaflets can close without waiting for the slow flow behind it.
function speedAt(r, p, ms, valves) {
  const base = baseSpeedAt(r, p, ms, valves);
  for (const kind of ['atrioventricular', 'arterial']) if (p >= r.zone[kind].lo && p <= r.zone[kind].hi) return Math.max(base, r.speed.ejection);
  return base;
}
function baseSpeedAt(r, p, ms, valves) {
  // While the arterial valve is open the column of blood in the artery is pushed on at the speed of the ejection.
  if (p >= r.arterial) return valves.arterial ? r.speed.ejection : r.speed.stream;
  if (p >= r.av) {
    if (valves.arterial) return r.speed.ejection;
    const t = ((ms % period) + period) % period;
    return t < cycle.atrialSystole ? r.speed.atrial : r.speed.passive;
  }
  if (p >= r.atrium && valves.atrioventricular) {
    const t = ((ms % period) + period) % period;
    return t < cycle.atrialSystole ? r.speed.atrial : r.speed.passive;
  }
  return r.speed.stream;
}

// `flow` is meta.flow of the generated data: the routes and the valve openings.
export function createFlow(flow, overrides = {}) {
  const settings = { ...flowSettings, ...overrides };
  const valves = createValves(flow);
  // How far each valve's leaflets are open, 0 to 1. They start open: the particles are spread evenly at first and some may
  // stand in a zone whose valve is closed in the beat's first milliseconds; the warm-up lets them out and the leaflets close.
  const openness = Object.fromEntries(valveNames.map(name => [name, 1]));
  const state = flow.routes.map(route => {
    const r = prepareRoute(route, settings, valves), n = Math.round(r.length / settings.spacing);
    // Unwrapped positions, front particle first: u[0] > u[1] > ... > u[n - 1] > u[0] - length.
    const u = Float64Array.from({ length: n }, (_, i) => r.length * .97 - i * r.length / n);
    return { ...r, n, u };
  });
  // A valve lets particles in while its binary window is open and its leaflets are completely open. Otherwise the zone is
  // closed: a wall at the zone's start in every lap, in front of which the particles wait. A particle already inside a zone is
  // not held (the zone is cleared before the leaflets move).
  const gate = (r, u, next, admit) => {
    const p = u - Math.floor(u / r.length) * r.length, base = u - p;
    let limit = next;
    for (const kind of ['atrioventricular', 'arterial']) {
      if (!admit[kind] && p < r.zone[kind].lo) limit = Math.min(limit, base + r.zone[kind].lo - 1e-6);
    }
    return limit;
  };
  // Position of the particle at arc length p of route r, in the millimetre frame of the parts.
  function pointAt(r, p, out) {
    let lo = 0, hi = r.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= p) lo = mid; else hi = mid; }
    const f = (p - r.cum[lo]) / (r.cum[hi] - r.cum[lo]), a = r.points[lo], b = r.points[hi];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
    return out;
  }
  // Whether the leaflets of the valve, posed at openness e, keep the clearance from every particle near it (the particles of every
  // route that passes the valve, within `reach` of its plane along the route).
  const reach = 14, pose = {}, spot = [0, 0, 0];
  function keepsClearance(name, e) {
    const valve = valves[name], positions = valve.pose(e, pose[name] ??= new Float64Array(valve.vertexCount * 3));
    for (const r of state) for (const kind of ['atrioventricular', 'arterial']) {
      if (r.valve[kind] !== name) continue;
      const centre = r.zone[kind].center;
      for (let i = 0; i < r.n; i++) {
        const p = r.u[i] - Math.floor(r.u[i] / r.length) * r.length;
        if (Math.abs(p - centre) > reach) continue;
        if (leafletDistance(valve, positions, pointAt(r, p, spot)) < valve.zoneUp) return false;
      }
    }
    return true;
  }
  // Whether a particle is on the upstream side of the valve's plane, between the wall and the plane. It is moving on towards the
  // leaflets, so the leaflets must not close until it is through.
  function upstreamOccupied(name) {
    for (const r of state) for (const kind of ['atrioventricular', 'arterial']) {
      if (r.valve[kind] !== name) continue;
      const { lo, center } = r.zone[kind];
      for (let i = 0; i < r.n; i++) { const p = r.u[i] - Math.floor(r.u[i] / r.length) * r.length; if (p >= lo && p < center) return true; }
    }
    return false;
  }
  // Swing the leaflets over dt ms ending at beat time `end`. They open from `ramp` ms before the binary window (so that they are
  // completely open when it starts) and close after it has ended. They do not close while a particle is on the way to them
  // from upstream. A step that would bring a leaflet within the clearance of a particle is not taken (the leaflet waits where
  // it is, and the particle goes on), and neither is a step whose middle would.
  function swing(end, dt) {
    for (const name of valveNames) {
      const kind = valveKind[name], target = valvesAt(end)[kind] || valvesAt(end + settings.ramp)[kind], from = openness[name];
      if (!target && upstreamOccupied(name)) continue;
      const to = target ? Math.min(1, from + dt / settings.ramp) : Math.max(0, from - dt / settings.ramp);
      if (to !== from && keepsClearance(name, to) && keepsClearance(name, (from + to) / 2)) openness[name] = to;
    }
  }
  // Advance by dt ms from beat time ms.
  function integrate(ms, dt) {
    const binary = valvesAt(ms + dt / 2);
    for (const r of state) {
      // Admission is judged on the leaflets as they are at the start of the step.
      const admit = Object.fromEntries(['atrioventricular', 'arterial'].map(kind => [kind, binary[kind] && openness[r.valve[kind]] >= 1]));
      for (let i = 0; i < r.n; i++) {
        const u = r.u[i], p = u - Math.floor(u / r.length) * r.length;
        let next = u + speedAt(r, p, ms + dt / 2, binary) * dt;
        next = gate(r, u, next, admit);
        const leader = i === 0 ? r.u[r.n - 1] + r.length : r.u[i - 1];
        next = Math.min(next, leader - settings.gap);
        r.u[i] = Math.max(u, next);
      }
    }
    swing(ms + dt, dt);
  }
  // Move the particles from beat time `from` to `to` (milliseconds). `to` before `from` moves nothing.
  function advance(from, to) {
    for (let ms = from; ms < to;) {
      const t = ((ms % period) + period) % period, until = (boundaries.find(b => b > t + 1e-9) ?? period + boundaries[0]) - t;
      const dt = Math.min(settings.step, to - ms, until);
      integrate(ms, dt);
      ms += dt;
    }
  }
  // Start from the state the ring settles into: whole beats from an even spread, so that the state belongs to the beat start.
  advance(0, settings.warmUp * period);

  const offsets = [];
  let total = 0;
  for (const r of state) { offsets.push(total); total += r.n; }

  // Position of particle k (counted over all routes) in the millimetre frame of the parts, written to out, and its size
  // factor: it shrinks towards zero within `fade` mm of the ends of the route, where the ring wraps around.
  const fade = 12;
  function sample(k, out) {
    let ri = state.length - 1;
    while (offsets[ri] > k) ri--;
    const r = state[ri], u = r.u[k - offsets[ri]], p = u - Math.floor(u / r.length) * r.length;
    pointAt(r, p, out);
    const edge = Math.min(p, r.length - p);
    return clamp01(edge / fade);
  }
  return {
    count: total,
    routes: state,
    settings,
    valves,
    // How far the leaflets of a valve are open now (0 to 1), and their vertices in the millimetre frame of the parts.
    openness: name => openness[name],
    leaflets: (name, out) => valves[name].pose(openness[name], out),
    advance,
    sample,
    side: k => { let ri = state.length - 1; while (offsets[ri] > k) ri--; return state[ri].side; },
    // Arc length of particle k along its route, for tests.
    arc: k => { let ri = state.length - 1; while (offsets[ri] > k) ri--; const r = state[ri], u = r.u[k - offsets[ri]]; return u - Math.floor(u / r.length) * r.length; },
  };
}
