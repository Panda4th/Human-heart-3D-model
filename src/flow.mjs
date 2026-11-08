import { cycle, isovolumic, period, valvesAt } from './heartbeat.mjs';

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
//   - the lengths of the isovolumic periods (heartbeat.mjs), gap, the speeds and the particle count.
export const flowSettings = { gap: 4, ejectionFraction: .6, atrialShare: .25, spacing: 6.5, step: 4, warmUp: 4 };

const clamp01 = x => Math.min(1, Math.max(0, x));
const ejection = { from: cycle.atrialSystole + isovolumic.contraction, to: cycle.atrialSystole + cycle.ventricularSystole };
const filling = { from: ejection.to + isovolumic.relaxation, to: period };
// Times within a beat at which a valve opens or closes or the atrial speed changes. An integration step never crosses one, so
// every step has one valve state and one set of speeds, whatever the frame interval is.
const boundaries = [cycle.atrialSystole, ejection.from, ejection.to, filling.from, period];

// Arc length of every route point, the positions of the two valve mouths and the atrium centre along the route, and the
// speeds. A route is described by the mark indices of the generated data (README, 血流の経路).
function prepareRoute(route, settings) {
  const { points, marks } = route, cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    cum.push(cum[i - 1] + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  const length = cum.at(-1), atrium = cum[marks.atrium], av = cum[marks.atrioventricular], arterial = cum[marks.arterial];
  // Distance that the train of particles in the ventricular segment travels in one beat. Ejection moves it through the arterial
  // valve; the same distance comes in through the atrioventricular valve, a quarter of it in atrial systole.
  const travel = settings.ejectionFraction * (arterial - av);
  return {
    id: route.id, side: route.side, points, cum, length, atrium, av, arterial, travel,
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
function speedAt(r, p, ms, valves) {
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

export function createFlow(routes, overrides = {}) {
  const settings = { ...flowSettings, ...overrides };
  const state = routes.map(route => {
    const r = prepareRoute(route, settings), n = Math.round(r.length / settings.spacing);
    // Unwrapped positions, front particle first: u[0] > u[1] > ... > u[n - 1] > u[0] - length.
    const u = Float64Array.from({ length: n }, (_, i) => r.length * .97 - i * r.length / n);
    return { ...r, n, u };
  });
  const gate = (r, u, next, valves) => {
    // The particle is p along the route within its lap. A closed valve is a wall at arc length r.av or r.arterial in every lap.
    const p = u - Math.floor(u / r.length) * r.length, base = u - p;
    let limit = next;
    if (!valves.atrioventricular && p < r.av) limit = Math.min(limit, base + r.av - 1e-6);
    if (!valves.arterial && p < r.arterial) limit = Math.min(limit, base + r.arterial - 1e-6);
    return limit;
  };
  // Advance by dt ms from beat time ms.
  function integrate(ms, dt) {
    const valves = valvesAt(ms + dt / 2);
    for (const r of state) {
      for (let i = 0; i < r.n; i++) {
        const u = r.u[i], p = u - Math.floor(u / r.length) * r.length;
        let next = u + speedAt(r, p, ms + dt / 2, valves) * dt;
        next = gate(r, u, next, valves);
        const leader = i === 0 ? r.u[r.n - 1] + r.length : r.u[i - 1];
        next = Math.min(next, leader - settings.gap);
        r.u[i] = Math.max(u, next);
      }
    }
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
    let lo = 0, hi = r.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= p) lo = mid; else hi = mid; }
    const f = (p - r.cum[lo]) / (r.cum[hi] - r.cum[lo]), a = r.points[lo], b = r.points[hi];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
    const edge = Math.min(p, r.length - p);
    return clamp01(edge / fade);
  }
  return {
    count: total,
    routes: state,
    settings,
    advance,
    sample,
    side: k => { let ri = state.length - 1; while (offsets[ri] > k) ri--; return state[ri].side; },
    // Arc length of particle k along its route, for tests.
    arc: k => { let ri = state.length - 1; while (offsets[ri] > k) ri--; const r = state[ri], u = r.u[k - offsets[ri]]; return u - Math.floor(u / r.length) * r.length; },
  };
}
