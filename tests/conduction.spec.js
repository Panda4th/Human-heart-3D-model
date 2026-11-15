// The conduction view: parts, the impulse and the schematic ECG.
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const { url, settle, stableShot, clickAnchor, whitePixels } = require('./helpers.js');

for (const width of [1440, 390]) test(`His intervals select independently at width ${width}`, async ({browser}, testInfo) => {
  const context = await browser.newContext({viewport:{width,height:900},hasTouch:width<700,isMobile:width<700});
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await page.locator('#mode-conduction').click();
  for (const name of ['ヒス束（近位区間）','ヒス束（分岐区間）']) {
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.locator('#name')).toHaveText(name);
    await expect(page.locator('#labels .model-label:visible')).toHaveText(name);
    await clickAnchor(page,name);
    await expect(page.locator('#name')).toHaveText(name);
  }
  await page.screenshot({path:testInfo.outputPath('his-branching.png'),fullPage:width>=700});
  await page.locator('#mode-interior').click();
  await expect(page.getByRole('button',{name:'ヒス束（分岐区間）',exact:true})).toBeHidden();
  await page.locator('#interior-conduction').click();
  await page.locator('#cut-depth').fill('-0.6');
  await page.getByRole('button',{name:'ヒス束（分岐区間）',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('ヒス束（分岐区間）');
  await context.close();
});

for (const width of [1440, 390]) test(`the two bundle branches are selected and drawn separately at width ${width}`, async ({ browser }, testInfo) => {
  const mobile = width < 700;
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-conduction').click();
  const c = page.locator('canvas');
  await page.getByRole('button', { name: '右脚', exact: true }).click();
  await expect(page.locator('#name')).toHaveText('右脚');
  await expect(page.locator('#labels .model-label:visible')).toHaveText('右脚');
  await settle(page);
  await c.scrollIntoViewIfNeeded();
  const right = await stableShot(c);
  await page.getByRole('button', { name: '左脚', exact: true }).click();
  await expect(page.locator('#name')).toHaveText('左脚');
  await expect(page.locator('#labels .model-label:visible')).toHaveText('左脚');
  await settle(page);
  expect((await stableShot(c)).equals(right)).toBe(false);
  await expect(page.locator('#description')).toContainText('幅のある面');
  await page.screenshot({path:testInfo.outputPath('left-bundle-front.png'),fullPage:!mobile});
  await page.locator('#view-left').click();
  await settle(page); await stableShot(c);
  await page.screenshot({path:testInfo.outputPath('left-bundle-side.png'),fullPage:!mobile});
  await page.locator('#view-front').click(); await settle(page);
  // The label of each branch sits on its own path: clicking at the anchor picks that branch.
  await clickAnchor(page, '左脚');
  await expect(page.locator('#name')).toHaveText('左脚');
  await page.getByRole('button', { name: '右脚', exact: true }).click();
  await settle(page);
  await clickAnchor(page, '右脚');
  await expect(page.locator('#name')).toHaveText('右脚');
  await context.close();
});

// Stage B, the impulse and the schematic ECG on the beat clock (conduction-timing.mjs). The page's clock is the fake one: stopped with
// pauseAt() once the page has loaded and moved only by runFor(), so each stop falls at the beat time planned (real speed: 1 ms is 1 ms).
test('conduction view: the impulse and the ECG follow the beat clock', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: 0 });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.clock.pauseAt(60000);
  const click = id => page.evaluate(i => document.getElementById(i).click(), id);
  // The strip is only in the conduction view, and at rest the parts keep their plain look (no head, no impulse text).
  await expect(page.locator('#ecg-panel')).toBeHidden();
  await expect(page.locator('#propagation-note')).toBeHidden();
  await click('mode-conduction');
  await click('beat-speed');
  await page.clock.runFor(30);
  await expect(page.locator('#ecg-panel')).toBeVisible();
  await expect(page.locator('#propagation-note')).toBeVisible();
  await expect(page.locator('#beat-electric')).toBeHidden();
  // [beat time, text of the stretch, the head is drawn]. The stops keep off the edges of the stretches (75, 100, 175, -25 ms), where a
  // clock a hair off would read the neighbour. The last point of the strip must be the schematic ECG at that beat time (the wiring;
  // where the waves sit is checked by tests/conduction-timing.test.mjs).
  const { ecgAt } = await import('../src/conduction-timing.mjs');
  const stops = [[20, /房室結節/, false], [80, /ヒス束と左右の脚/, true], [105, /プルキンエ線維/, true], [125, /プルキンエ線維/, true], [340, /T波/, false], [740, /洞房結節から心房/, true]];
  const lastY = () => page.evaluate(() => Number(document.getElementById('ecg-trace').getAttribute('d').split('L').pop().split(' ')[1]));
  const c = page.locator('canvas');
  let at = 0;
  const counts = {};
  for (const [ms, text] of stops) {
    await click('beat-play');
    await page.clock.runFor(ms - at);
    at = ms;
    await click('beat-play'); // the stop draws the beat exactly where the clock is
    await page.clock.runFor(30);
    await expect(page.locator('#beat-electric')).toHaveText(text);
    // 0.2: src/ecg-strip.mjs writes y with one decimal (an error of up to 0.05), and the last point is at the beat time itself (276 is a multiple of
    // the 1.5 step). The tolerance had no reason recorded; this one was written for Issue #50 F3.
    expect(Math.abs(await lastY() - (46 - ecgAt(ms) * 34)), `strip at ${ms} ms`).toBeLessThan(.2);
    await page.clock.resume();
    counts[ms] = await whitePixels(page, await stableShot(c));
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 50000);
  }
  // Measured (Chromium, SwiftShader, 1280x720): 0, 0, 102, 24, 0, 0 white pixels at 20, 80, 105, 125, 340 and 740 ms. A head that lies
  // behind the see-through walls (the His bundle, the atria) is tinted and not white, so only the Purkinje heads, at the apex, are
  // counted; where no head can be drawn (the AV node's wait, the recovery) the count must be 0.
  expect(counts[20]).toBe(0);
  expect(counts[340]).toBe(0);
  expect(counts[105]).toBeGreaterThan(40);
  expect(counts[125]).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

// Review of PR #49: the labels of the strip came from a fixed list of beats, so after a few beats of play they were gone for good.
// The beat time keeps growing while the beat plays; the strip is a function of where it is within the beat, so after 4 or 10 whole
// beats the strip and its labels must be what they were. (fastForward moves the fake clock at once and draws one frame.)
test('conduction view: the ECG labels and the trace are the same after 4 and 10 whole beats', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: 0 });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.clock.pauseAt(60000);
  const click = id => page.evaluate(i => document.getElementById(i).click(), id);
  await click('mode-conduction');
  await click('beat-speed');
  const strip = () => page.evaluate(() => ({
    d: document.getElementById('ecg-trace').getAttribute('d'),
    labels: [...document.querySelectorAll('#ecg-panel text')].map(t => [t.dataset.wave, t.hasAttribute('hidden'), t.getAttribute('x'), t.getAttribute('y'), t.textContent]),
  }));
  const stopAt = async ms => {
    await click('beat-play');
    await ms();
    await click('beat-play');
    await page.clock.runFor(30);
    return strip();
  };
  const first = await stopAt(() => page.clock.runFor(405));
  expect(first.labels.map(l => l[1]), 'at 405 ms the P, QRS and T labels are shown').toEqual([false, false, false]);
  const fourBeats = await stopAt(() => page.clock.fastForward(4 * 800));
  expect(fourBeats).toEqual(first);
  const tenBeats = await stopAt(() => page.clock.fastForward(6 * 800));
  expect(tenBeats).toEqual(first);
  expect(errors).toEqual([]);
});

// The impulse is also drawn on the cross-section when the conduction overlay is on; the strip is only in the conduction view.
test('interior view: the impulse runs on the conduction overlay and the strip stays out', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-interior').click();
  await page.locator('#interior-conduction').click();
  await expect(page.locator('#ecg-panel')).toBeHidden();
  await expect(page.locator('#propagation-note')).toBeHidden();
  await expect(page.locator('#beat-electric')).toBeHidden();
  await page.locator('#beat-play').click();
  await page.waitForTimeout(900);
  await expect(page.locator('#beat-electric')).toHaveText(/^刺激：/);
  await page.locator('#beat-play').click();
  // Leaving the conduction parts hides the impulse text again once the overlay is off and the beat is at rest.
  await page.locator('#mode-exterior').click();
  await expect(page.locator('#beat-electric')).toBeHidden();
  await page.locator('#mode-conduction').click();
  await expect(page.locator('#ecg-panel')).toBeVisible();
  expect(errors).toEqual([]);
});
