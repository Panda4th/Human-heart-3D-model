// Where the parts of the page sit at each window size. The rules are in template.html; this moves the elements that CSS alone cannot
// place (a phone shows the model above a scrolling part, and the keyboard follows the DOM order). Moved out of main.js (Issue #50 E4).

// The breakpoints of the CSS media queries in template.html. CSS cannot read a variable inside a media query, so the CSS writes the
// same numbers; tests/layout.spec.js checks that this file and the CSS place the elements the same way on both sides of each one.
export const phoneMaxWidth = 760; // a phone layout up to this width
export const phoneMaxSidewaysHeight = 480; // a phone layout this low or lower is a phone held sideways
export const sideColumnMaxWidth = 999; // a PC window up to this width puts the phase box at the top of the side column
export const phoneQuery = `(max-width:${phoneMaxWidth}px)`;

// Phone layout: the model, the description and the two cut notices go to #pinned above the scrolling <main>, and back to their
// places on wider screens. Moving the canvas keeps its WebGL context. See the phone rules in template.html.
export function arrangeLayout(canvas, $) {
  const phone = matchMedia(phoneQuery);
  const moved = [canvas.closest('.viewport'), document.querySelector('.detail'), $('cut-notice'), $('pick-note')].map(el => {
    const home = document.createComment('');
    el.before(home);
    return [el, home];
  });
  // On a phone, CSS `order` shows the ECG strip and the step buttons right under the mode buttons and the view buttons under the
  // interior overlay buttons; the keyboard follows the DOM, so they are moved there too, or Tab went back up the page (Issue #50 C3).
  const reordered = [
    [$('ecg-panel'), () => document.querySelector('.stage-heading')],
    [$('steps'), () => $('ecg-panel')],
    [document.querySelector('nav.views'), () => $('interior-overlay')],
  ].map(([el, after]) => {
    const home = document.createComment('');
    el.before(home);
    return [el, home, after];
  });
  // On a PC the ECG strip (conduction view) goes to the top of the side column. On the model's bottom left it lay over the vessels in
  // many windows from 761 to 1280px (model pixels under it: 811 at 800x700, 185 at 1024x768, 49 at 1280x1024); on the bottom right it
  // covered more, and a row of its own under the model took about 95px from the model's box (Issue #50 recheck, C1).
  const ecgAside = () => document.querySelector('aside').prepend($('ecg-panel'));
  const place = () => {
    for (const [el, home] of moved) phone.matches ? $('pinned').append(el) : home.after(el);
    for (const [el, home, after] of reordered) phone.matches ? after().after(el) : home.after(el);
    if (!phone.matches) ecgAside();
  };
  // The phase box (shown once the beat has been played) lies on the model's top left corner where the model leaves room for it. In a
  // PC window below 1000px and on an upright phone the model fills its box, and the box covered the top of the vessels in every corner
  // (Issue #50 B2/C1), so there it leaves the model: on an upright phone it goes under the model (the model keeps its size, the
  // scrolling part below gets shorter), in a PC window from 761 to 999px to the top of the side column. A phone held sideways keeps it on
  // the model, whose box is wide and low there. See the rules in template.html.
  const phaseBox = $('beat-phase'), phaseHome = document.createComment('');
  phaseBox.before(phaseHome);
  const upright = matchMedia(`${phoneQuery} and (min-height:${phoneMaxSidewaysHeight + 1}px)`);
  const narrow = matchMedia(`(min-width:${phoneMaxWidth + 1}px) and (max-width:${sideColumnMaxWidth}px)`);
  // Elements are moved only when their place changes: re-attaching the model and the description loses the focus and the
  // description's scroll position (review of PR #51), so `place` runs only when the phone layout starts or ends, and the phase box
  // moves only when its own place changes. `place` moves the model, so after it the box is placed again. In the side column the box is
  // prepended, so it stays above the ECG strip.
  let phaseAt = null;
  const placePhase = (force = false) => {
    const at = upright.matches ? 'under' : narrow.matches ? 'aside' : 'home';
    if (at === phaseAt && !force) return;
    phaseAt = at;
    if (at === 'under') canvas.closest('.viewport').after(phaseBox);
    else if (at === 'aside') document.querySelector('aside').prepend(phaseBox);
    else phaseHome.after(phaseBox);
  };
  phone.addEventListener('change', () => { place(); placePhase(true); });
  for (const query of [upright, narrow]) query.addEventListener('change', () => placePhase());
  place();
  placePhase(true);
}
