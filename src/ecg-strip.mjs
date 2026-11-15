// The schematic ECG strip of the conduction view, drawn from the beat time (conduction-timing.mjs has the waves).
// Moved out of main.js (Issue #50 E4).
import { ecgAt, ecgBumps, waveAge } from './conduction-timing.mjs';

// The strip shows the last `span` ms of the beat clock across `now` units of the SVG, with the current time at its right end; `base`
// is the baseline's y and `amp` the height of an R wave of 1 (SVG units, viewBox 320x64 in template.html).
export const ecgSpan = 1000, ecgNow = 276, ecgBase = 46, ecgAmp = 34;

export function createEcgStrip(trace, marks) {
  const scale = ecgNow / ecgSpan, names = { P: 'P', R: 'QRS', T: 'T' };
  let key = '';
  return {
    draw(beatTime) {
      // Same beat time: nothing to redraw (the strip is a function of the beat time only).
      const next = String(beatTime);
      if (next === key) return;
      key = next;
      let d = '';
      for (let x = 0; x <= ecgNow; x += 1.5) d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${(ecgBase - ecgAt(beatTime - (ecgNow - x) / scale) * ecgAmp).toFixed(1)}`;
      trace.setAttribute('d', d);
      // Letters over the waves: P and T, and QRS at the R peak. They are drawn where the wave of a beat in view is.
      for (const text of marks) {
        const bump = ecgBumps.find(b => b.name === text.dataset.wave);
        // The newest occurrence of this wave in view, found from the beat time (which keeps growing while the beat plays).
        const age = waveAge(beatTime, bump.mean, 6 / scale, (ecgNow - 6) / scale), x = age === null ? -1 : ecgNow - age * scale;
        text.toggleAttribute('hidden', x < 0);
        if (x >= 0) { text.setAttribute('x', x.toFixed(1)); text.setAttribute('y', (ecgBase - Math.max(bump.height, 0) * ecgAmp - 5).toFixed(1)); text.textContent = names[bump.name]; }
      }
    },
    // Draw again at the next call even at the same beat time (the strip was hidden or its view changed).
    invalidate() { key = ''; },
  };
}
