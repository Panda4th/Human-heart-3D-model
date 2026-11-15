// The phase box: the name of the current period of the beat, the valves and (with the conduction system shown) the impulse.
// Moved out of main.js (Issue #50 E4). Where the box sits at each window size is decided in layout.mjs.
import { stretchText } from './conduction-timing.mjs';
import { phaseAt, phases } from './heartbeat.mjs';

// impulseShown: whether the conduction system is shown, so that the impulse line can appear in the box.
export function createPhaseBox($, impulseShown) {
  const box = $('beat-phase'), lines = [$('beat-phase-name'), $('beat-phase-short'), $('beat-electric')];
  let shown = -1;
  // The phase box under the model (upright phone) keeps the height of its tallest text, or the model box changed size each time
  // the impulse line wrapped differently (review of PR #51: 186-201px at 320x520). In the side column (761-999px) the list scrolls
  // under the box, so the box's height is kept clear when the focus scrolls the list (review of PR #51: Shift+Tab hid the focused
  // button under it).
  function fit() {
    box.style.minHeight = '';
    if (!box.hidden && getComputedStyle(box).position === 'static') {
      const saved = lines.map(e => [e.textContent, e.hidden]);
      let tallest = 0;
      for (const phase of phases) for (const text of impulseShown() ? Object.values(stretchText) : ['']) {
        lines[0].textContent = `${phase.name}（${phase.time}）`;
        lines[1].textContent = phase.short;
        lines[2].textContent = text;
        lines[2].hidden = !text;
        tallest = Math.max(tallest, box.getBoundingClientRect().height);
      }
      saved.forEach(([text, hidden], i) => { lines[i].textContent = text; lines[i].hidden = hidden; });
      box.style.minHeight = `${Math.ceil(tallest)}px`;
    }
    const aside = document.querySelector('aside');
    aside.style.scrollPaddingTop = box.parentElement === aside && !box.hidden ? `${Math.ceil(box.getBoundingClientRect().height) + 8}px` : '';
  }
  new ResizeObserver(fit).observe(box);
  // flowView: in the flow view the leaflets are drawn, and they are closed together for only part of the two periods in which all
  // four valves are closed (README, 血流の模式弁尖); the text says so instead of describing the whole period.
  function show(beatTime, flowView) {
    const index = phaseAt(beatTime);
    if (box.hidden) { box.hidden = false; fit(); }
    $('beat-note').hidden = false;
    if (index === shown) return;
    shown = index;
    const phase = phases[index];
    $('beat-phase-name').textContent = `${phase.name}（${phase.time}）`;
    $('beat-phase-short').textContent = phase.short;
    $('beat-phase-valves').textContent = phase.valves + (flowView && index > 0 ? ` この画面の弁尖が4つとも閉じるのは、この時期のうち約${index === 1 ? '0.01' : '0.02'}秒だけです。` : '');
  }
  return {
    fit, show,
    // The text is written again at the next show (a view was changed: the flow view's sentence differs).
    reset() { shown = -1; },
    get shown() { return shown; },
    get visible() { return !box.hidden; },
  };
}
