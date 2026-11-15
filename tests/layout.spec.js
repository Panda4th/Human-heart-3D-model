// Layout at PC and phone sizes: where the boxes sit, sizes, scrolling and the keyboard order.
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const { url, modelPixels, settle, fakeAudio } = require('./helpers.js');

// A phone held sideways: the scrolling box must keep enough height to reach the controls (Codex review on PR #12).
for (const [width,height] of [[667,375],[760,412],[568,320]]) test(`controls stay reachable on a short phone screen ${width}x${height}`, async ({browser}) => {
  const context = await browser.newContext({viewport:{width,height},hasTouch:true,isMobile:true});
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  const main = await page.locator('main').boundingBox();
  expect(main.height).toBeGreaterThanOrEqual(60);
  expect(main.y + main.height).toBeLessThanOrEqual(height + 1);
  await page.locator('#mode-interior').scrollIntoViewIfNeeded();
  await expect(page.locator('#mode-interior')).toBeInViewport();
  await page.locator('.part:visible').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.part:visible').last()).toBeInViewport();
  await context.close();
});

// A new part must show its description from the top, whichever way it was chosen (Review of main be90ada, item 6).
test('selecting another part scrolls the description box back to its top on a phone', async ({browser}) => {
  const context = await browser.newContext({viewport:{width:667,height:375},hasTouch:true,isMobile:true});
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  const scrolled = () => page.locator('.detail').evaluate(e => { e.scrollTop = 9999; return e.scrollTop; });
  await page.getByRole('button',{name:'大動脈',exact:true}).click();
  expect(await scrolled()).toBeGreaterThan(0);
  await page.getByRole('button',{name:'右心室',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('右心室');
  expect(await page.locator('.detail').evaluate(e => e.scrollTop)).toBe(0);
  expect(await scrolled()).toBeGreaterThan(0);
  await page.locator('#mode-conduction').click();
  expect(await page.locator('.detail').evaluate(e => e.scrollTop)).toBe(0);
  // A tap on the model: in the exterior view the middle of the model is a heart part.
  await page.locator('#mode-exterior').click();
  expect(await scrolled()).toBeGreaterThan(0);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click(box.x + box.width * .5, box.y + box.height * .6);
  await expect(page.locator('#name')).not.toHaveText('心臓を観察する');
  expect(await page.locator('.detail').evaluate(e => e.scrollTop)).toBe(0);
  await context.close();
});

// On a phone every block of the scrolling box must use the full width (Review item 12: align-items:start shrank them).
for (const width of [320,390]) test(`phone blocks fill the width at ${width}px`, async ({browser}) => {
  const context = await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:true});
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  const widths = await page.evaluate(() => {
    const main = document.querySelector('main').clientWidth, w = sel => Math.round(document.querySelector(sel).getBoundingClientRect().width);
    return {main, heading: w('.stage-heading'), tools: w('nav.tools'), footer: w('main > footer')};
  });
  expect(widths.heading).toBe(widths.main); expect(widths.tools).toBe(widths.main); expect(widths.footer).toBe(widths.main);
  await context.close();
});

// Stage A (2026-11-14), the PC layout at 1280x800: the page fits one screen, so the beat and sound buttons are not cut off, and the
// model's box is tall (it was 470 px, 59% of the window; the heart is larger because the camera distance is unchanged and the box is
// taller). Measured in Chromium at 1280x800: the box is 610 px in the exterior, conduction and flow views and 560 px in the interior view.
test('PC layout: the tool row is on screen, the model box is tall, the lower buttons share the upper text size', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  for (const mode of ['exterior', 'conduction', 'interior', 'flow']) {
    await page.locator(`#mode-${mode}`).click();
    await settle(page);
    const m = await page.evaluate(() => {
      const box = s => document.querySelector(s).getBoundingClientRect(), size = s => getComputedStyle(document.querySelector(s)).fontSize;
      return { canvas: box('canvas').height, stageBottom: box('.stage').bottom, play: box('#beat-play').bottom, sound: box('#heart-sound').bottom, height: innerHeight,
        upper: size('#mode-exterior'), views: size('#view-front'), lower: ['#in', '#rotate', '#reset', '#beat-play', '#beat-speed', '#heart-sound'].map(size) };
    });
    expect(m.canvas, `${mode}: model box height`).toBeGreaterThanOrEqual(540);
    expect(m.stageBottom, `${mode}: stage inside the window`).toBeLessThanOrEqual(m.height + 1);
    expect(m.play, `${mode}: beat button inside the window`).toBeLessThanOrEqual(m.height);
    expect(m.sound, `${mode}: sound button inside the window`).toBeLessThanOrEqual(m.height);
    // The lower row used to inherit 16px while the mode and view buttons had 12px.
    expect(m.lower, `${mode}: lower buttons`).toEqual(m.lower.map(() => m.upper));
    expect(m.views).toBe(m.upper);
  }
  expect(errors).toEqual([]);
  await context.close();
});

// A notice (a part the cut removed, a clicked cut face) must not change the model's box: it used to sit in the heading, so showing it
// shrank the box, the camera was refitted, and the picture moved under the pointer (this broke the cut-face click test about 1 in 10).
test('PC layout: showing a notice does not move or resize the model box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-interior').click();
  await page.getByRole('button', { name: '大動脈弁', exact: true }).click();
  await settle(page);
  const rect = () => page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
  const before = await rect();
  await page.locator('#cut-depth').fill('0.9');
  await expect(page.locator('#cut-notice')).toBeVisible();
  await settle(page);
  expect(await rect()).toEqual(before);
  const box = await page.locator('canvas').boundingBox();
  await page.locator('#cut-depth').fill('0');
  await expect(page.locator('#cut-notice')).toBeHidden();
  // The clicked-cut-face note is laid out the same way; it is shown here directly (the click that shows it is tested elsewhere).
  await page.evaluate(() => { document.getElementById('pick-note').hidden = false; });
  await settle(page);
  expect(await rect()).toEqual(before);
  const note = await page.locator('#pick-note').boundingBox();
  expect(note.x >= box.x && note.y >= box.y && note.x + note.width <= box.x + box.width && note.y + note.height <= box.y + box.height, 'the note is on the model box').toBe(true);
  await context.close();
});

// The phase box starts at the left edge of the text column: the heading on the PC, the description on a phone (it used to start 12px / 8px
// from the model's edge, left of the text).
for (const [name, viewport, mobile] of [['PC', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) test(`${name} layout: the phase box starts at the left edge of the text`, async ({ browser }) => {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-phase')).toBeVisible();
  const [box, text] = await page.evaluate(mobile => [document.querySelector('#beat-phase').getBoundingClientRect().left,
    document.querySelector(mobile ? '#name' : '#mode-title').getBoundingClientRect().left], mobile);
  expect(Math.abs(box - text)).toBeLessThanOrEqual(1);
  await page.locator('#beat-play').click();
  await context.close();
});

// Review of PR #46: from 761px the PC layout applies, but the stage is only the window minus the 330px side column (431px at 761px).
// The heading and the mode buttons, and the cut slider and the two overlay buttons, shared a row and overlapped below about 1000px
// (measured: the title text and the mode buttons overlapped by 39px at 900px; the slider and the overlay buttons at 761-900px).
// Boxes are compared, and the slider is operated with the real pointer (fill() cannot show that something covers it).
for (const width of [761, 800, 900, 1024, 1280]) test(`PC layout at width ${width}: heading, mode buttons, slider and overlay buttons do not overlap`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  const boxes = () => page.evaluate(() => {
    const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const text = s => { const range = document.createRange(); range.selectNodeContents(document.querySelector(s)); const r = range.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    return { number: text('#mode-number'), title: text('#mode-title'), modes: box('.modes'), views: box('nav.views'), cut: box('#cut'), overlay: box('#interior-overlay'), tools: box('nav.tools'),
      stageRight: box('.stage').r, stageBottom: box('.stage').b, height: innerHeight };
  });
  const apart = (a, b) => a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;
  for (const mode of ['exterior', 'conduction', 'interior', 'flow']) {
    await page.locator(`#mode-${mode}`).click();
    await settle(page);
    const m = await boxes();
    expect(apart(m.title, m.modes), `${mode}: title and mode buttons`).toBe(true);
    expect(apart(m.number, m.modes), `${mode}: label and mode buttons`).toBe(true);
    expect(m.modes.r, `${mode}: mode buttons inside the stage`).toBeLessThanOrEqual(m.stageRight);
    expect(m.stageBottom, `${mode}: stage inside the window`).toBeLessThanOrEqual(m.height + 1);
    if (mode === 'interior') {
      expect(apart(m.cut, m.overlay), 'slider and overlay buttons').toBe(true);
      expect(m.overlay.r).toBeLessThanOrEqual(m.stageRight);
      expect(apart(m.cut, m.tools) && apart(m.overlay, m.tools), 'rows above the tool row').toBe(true);
      // The slider answers the pointer at its left, middle and right, and the overlay buttons stay as they were.
      const slider = await page.locator('#cut-depth').boundingBox();
      for (const fraction of [.1, .5, .9]) {
        const before = await page.inputValue('#cut-depth');
        await page.mouse.click(slider.x + slider.width * fraction, slider.y + slider.height / 2);
        expect(await page.inputValue('#cut-depth'), `slider at ${fraction}`).not.toBe(before);
        await page.mouse.click(slider.x + slider.width * (fraction === .1 ? .9 : .1), slider.y + slider.height / 2);
      }
      await expect(page.locator('#interior-flow')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#interior-conduction')).toHaveAttribute('aria-pressed', 'false');
    }
  }
  await context.close();
});

// The phase box (top left of the model) must not lie over the model in a narrow PC window. With the beat stopped mid-beat and the box,
// the labels and the strip hidden, count the model pixels in the box's area. Before the box was cut down below 1400px: 3382 at 1024x768
// (exterior view), 636 at 1280x800; after: 0 at both (and at 1100x800, 1366x768, 1360x1000, 1399x900 when measured by hand, with the longest impulse line).
for (const [width, height] of [[1024, 768], [1280, 800]]) for (const mode of ['exterior', 'conduction']) test(`PC layout: the phase box is clear of the model at ${width}x${height} (${mode})`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator(`#mode-${mode}`).click();
  await page.locator('#beat-play').click();
  await page.waitForTimeout(600);
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-phase')).toBeVisible();
  await settle(page);
  // The line about the impulse changes with where the beat stopped (the CI run of 93ff471 stopped at another stretch than the local one
  // and showed the longest text, which made the box 277px wide): measure with the longest text, whichever stretch it stopped in.
  await page.evaluate(() => { const e = document.getElementById('beat-electric'); if (!e.hidden) e.textContent = '刺激：ヒス束と左右の脚を心尖へ下る（約0.025秒）'; });
  await settle(page);
  const rect = await page.evaluate(() => { const r = document.getElementById('beat-phase').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  expect(rect.width, 'the box is capped').toBeLessThanOrEqual(200.5);
  await page.addStyleTag({ content: '#beat-phase,#labels,#ecg-panel{visibility:hidden}' });
  await settle(page);
  expect(await modelPixels(page, await page.screenshot({ clip: rect }))).toBe(0);
  await context.close();
});

// Issue #50 C3: on a phone, CSS order shows the ECG strip and the step buttons under the mode buttons and the view buttons under the
// interior overlay buttons. Tab must follow that order, top to bottom, through the scrolling part of the page.
for (const mode of ['conduction', 'interior']) test(`phone layout: Tab goes down the page in the ${mode} view`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator(`#mode-${mode}`).click();
  await page.locator(`#mode-${mode}`).focus();
  const tops = [];
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    tops.push(await page.evaluate(() => {
      const e = document.activeElement, main = document.querySelector('main');
      return main.contains(e) ? [e.id || e.textContent.trim(), e.getBoundingClientRect().top + main.scrollTop] : null;
    }));
  }
  const inMain = tops.filter(Boolean);
  expect(inMain.length).toBeGreaterThan(10);
  for (let i = 1; i < inMain.length; i++) expect(inMain[i][1], `${inMain[i - 1][0]} -> ${inMain[i][0]}`).toBeGreaterThanOrEqual(inMain[i - 1][1] - 1);
  await context.close();
});

// Issue #50 B2/C1: below 1000px and on an upright phone the model fills its box and the phase box covered the top of the vessels in every
// corner (99 model pixels under it at 761x800 in the conduction view, 170 in the interior view, 297 at 390x844). There it is moved off the
// model; a phone held sideways keeps it on the model, capped at 200px. Measured as in the test above, with the longest impulse line.
for (const [width, height, mobile] of [[761, 800, false], [900, 800, false], [999, 800, false], [390, 844, true], [320, 640, true], [568, 320, true], [667, 375, true]]) test(`the phase box is clear of the model at ${width}x${height}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  for (const mode of ['exterior', 'conduction', 'interior']) {
    await page.locator(`#mode-${mode}`).click();
    await page.locator('#beat-play').click();
    await page.waitForTimeout(600);
    await page.locator('#beat-play').click();
    await expect(page.locator('#beat-phase')).toBeVisible();
    // In the conduction view the impulse line is forced on with its longest text, wherever the beat stopped.
    if (mode === 'conduction') await page.evaluate(() => { const e = document.getElementById('beat-electric'); e.hidden = false; e.textContent = '刺激：ヒス束と左右の脚を心尖へ下る（約0.025秒）'; });
    await page.addStyleTag({ content: '#labels,#ecg-panel{visibility:hidden}' });
    await settle(page);
    const [rect, canvas] = await page.evaluate(() => [document.getElementById('beat-phase'), document.querySelector('canvas')].map(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }));
    const overCanvas = rect.x < canvas.x + canvas.width && rect.x + rect.width > canvas.x && rect.y < canvas.y + canvas.height && rect.y + rect.height > canvas.y;
    expect(overCanvas, `${mode}: the box is on the model only on a phone held sideways`).toBe(height <= 480);
    if (overCanvas) {
      const style = await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
      await settle(page);
      expect(await modelPixels(page, await page.screenshot({ clip: rect })), mode).toBe(0);
      await style.evaluate(e => e.remove());
    }
  }
  await context.close();
});

// Review of PR #51: the phase box at the top of the side column (761-999px) is opaque and the part buttons pass under it when the list
// scrolls; a click on it chose the button hidden under it.
test('a click on the phase box in the side column does not choose a part under it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-play').click();
  await page.locator('#beat-play').click();
  await page.evaluate(() => { document.querySelector('aside').scrollTop = 150; });
  const box = await page.locator('#beat-phase').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('#name')).toHaveText('左心室');
  await context.close();
});

// Review of PR #51: on a small upright phone the phase box under the model, a cut notice and the description left <main> (the buttons)
// 1px tall at 320x520. <main> keeps at least 100px: the description, the notices and then the model shrink.
// On a phone held sideways <main> keeps 60px instead, so that everything fits a screen 300px tall; the cut notice must not run over it.
for (const [width, height] of [[320, 520], [320, 568], [360, 560], [667, 375], [568, 320], [667, 300]]) test(`phone layout at ${width}x${height}: the buttons keep their room with the phase box and a cut notice`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  const click = id => page.evaluate(i => document.getElementById(i).click(), id);
  await click('mode-interior');
  await page.locator('#cut-depth').fill('0.9');
  await page.evaluate(() => document.querySelector('.part.cut-out').click());
  await expect(page.locator('#cut-notice')).toBeVisible();
  await click('beat-play');
  await click('beat-play');
  await expect(page.locator('#beat-phase')).toBeVisible();
  const main = await page.locator('main').boundingBox(), notice = await page.locator('#cut-notice').boundingBox();
  expect(main.height).toBeGreaterThanOrEqual(height <= 480 ? 59.5 : 99.5);
  expect(main.y + main.height).toBeLessThanOrEqual(height + 1);
  expect(notice.y + notice.height, 'the cut notice ends above the buttons').toBeLessThanOrEqual(main.y + .5);
  await context.close();
});

// Review of PR #51: under the model on a small upright phone, the phase box changed height when the impulse line wrapped differently,
// and the model box with it (186-201px at 320x520). It keeps the height of its tallest text.
test('phone layout at 320x520: the model box keeps its size while the beat plays in the conduction view', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 520 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => document.getElementById('mode-conduction').click());
  await page.evaluate(() => document.getElementById('beat-speed').click());
  await page.evaluate(() => document.getElementById('beat-play').click());
  const heights = new Set(), texts = new Set();
  for (let i = 0; i < 30; i++) {
    const [h, t] = await page.evaluate(() => [document.querySelector('canvas').getBoundingClientRect().height, document.getElementById('beat-electric').textContent]);
    heights.add(h); texts.add(t);
    await page.waitForTimeout(60);
  }
  expect(texts.size, 'the impulse line changed').toBeGreaterThan(1);
  expect([...heights]).toHaveLength(1);
  await context.close();
});

// Review of PR #51: from 761 to 999px the list of parts scrolls under the phase box at the top of the side column; a button reached by
// Shift+Tab was left focused but hidden under the box. Both directions must leave the focused button in view below the box.
test('side column at 800x700: a part button reached by Tab or Shift+Tab is not hidden under the phase box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-play').click();
  await page.locator('#beat-play').click();
  const visible = () => page.evaluate(() => {
    const e = document.activeElement, r = e.getBoundingClientRect(), box = document.getElementById('beat-phase').getBoundingClientRect();
    return { name: e.textContent.trim(), clear: !e.classList.contains('part') || r.top >= box.bottom - .5 };
  });
  await page.getByRole('button', { name: '左心室', exact: true }).focus();
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); const v = await visible(); expect(v.clear, `Tab to ${v.name}`).toBe(true); }
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Tab'); const v = await visible(); expect(v.clear, `Shift+Tab to ${v.name}`).toBe(true); }
  await context.close();
});

// Review of PR #51: the model and the description were taken out of the page and put back at every change of the phase box's media
// queries (turning a phone, resizing a PC window), which lost the focus and the description's scroll position.
test('turning a phone keeps the focus and the description scroll', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-conduction').click();
  await page.evaluate(() => { document.querySelector('.detail').scrollTop = 40; });
  await page.locator('#view-front').focus();
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('view-front');
  expect(await page.evaluate(() => document.querySelector('.detail').scrollTop)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(300); // leaving the phone layout moves the view buttons back (that loses the focus, as it should once)
  await page.locator('#view-front').focus();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('view-front');
  await context.close();
});

// Issue #50 recheck (C1): on the model's bottom left the ECG strip lay over the vessels in many PC windows (model pixels under it: 811 at
// 800x700, 185 at 1024x768, 49 at 1280x1024). From 761px it is in the side column, off the model, and in view when the view opens.
for (const [width, height] of [[761, 700], [800, 700], [1024, 768], [1280, 800], [1280, 1024], [1440, 900]]) test(`PC layout at ${width}x${height}: the ECG strip is off the model`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  // The side column is scrolled down first, as after reading the exterior's list (review of PR #52: the strip was left above the
  // visible part of the column when the view was entered from there).
  await page.evaluate(() => { document.querySelector('aside').scrollTop = 500; });
  await page.locator('#mode-conduction').click();
  await page.locator('#beat-play').click();
  await page.locator('#beat-play').click();
  const [ecg, canvas, aside] = await page.evaluate(() => ['#ecg-panel', 'canvas', 'aside'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
  const over = ecg.left < canvas.right && ecg.right > canvas.left && ecg.top < canvas.bottom && ecg.bottom > canvas.top;
  expect(over, 'the strip lies on the model box').toBe(false);
  expect(ecg.top, 'the strip starts inside the side column').toBeGreaterThanOrEqual(Math.max(aside.top, 0));
  expect(ecg.bottom, 'the strip ends inside the side column').toBeLessThanOrEqual(Math.min(aside.bottom, height));
  await context.close();
});

// Issue #50 recheck (F2): the phone layout, the place of the phase box and their CSS are switched by the same widths in
// src/layout.mjs (main.js until 2026-11-15) and in template.html (760/761, 999/1000, 480/481 high). A change on one side only must
// show: on each side of each boundary, where layout.mjs has put the model and the phase box must agree with the CSS that is in force.
for (const [width, height] of [[760, 800], [761, 800], [999, 800], [1000, 800], [760, 480], [760, 481]]) test(`at ${width}x${height} layout.mjs and the CSS agree on the layout`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-play').click();
  await page.locator('#beat-play').click();
  const m = await page.evaluate(() => {
    const box = document.getElementById('beat-phase');
    return { pinned: Boolean(document.querySelector('canvas').closest('#pinned')), phoneCss: getComputedStyle(document.body).overflow === 'hidden',
      boxInAside: box.parentElement.tagName === 'ASIDE', sticky: getComputedStyle(box).position === 'sticky',
      boxUnder: box.previousElementSibling?.classList.contains('viewport') ?? false, static: getComputedStyle(box).position === 'static' };
  });
  expect(m.pinned, 'model moved for the phone').toBe(width <= 760);
  expect(m.phoneCss, 'phone CSS').toBe(width <= 760);
  expect(m.boxInAside, 'box in the side column').toBe(width >= 761 && width <= 999);
  expect(m.sticky, 'side-column CSS').toBe(m.boxInAside);
  expect(m.boxUnder, 'box under the model').toBe(width <= 760 && height >= 481);
  expect(m.static, 'under-the-model CSS').toBe(m.boxUnder);
  await context.close();
});

// Issue #50 C5: "−" and "＋", the two sliders and the licence summary were under 44px with no reason recorded. On a phone they are
// 44px now; in a PC window only the summary is (the reason for the others is in the CSS).
for (const [width, height, mobile] of [[390, 844, true], [667, 375, true], [1280, 800, false]]) test(`control sizes at ${width}x${height}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-interior').click();
  const sizes = await page.evaluate(() => Object.fromEntries(['#in', '#out', '#cut-depth', '#heart-volume', 'footer summary']
    .map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [s, { width: b.width, height: b.height }]; })));
  expect(sizes['footer summary'].height, 'licence summary').toBeGreaterThanOrEqual(44);
  if (mobile) {
    for (const s of ['#in', '#out']) expect(sizes[s].width, s).toBeGreaterThanOrEqual(44);
    for (const s of ['#cut-depth', '#heart-volume']) expect(sizes[s].height, s).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});
