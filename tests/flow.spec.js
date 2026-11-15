// The blood-flow view and the flow overlay on the cut.
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const { url, settle, stableShot, particlePixels } = require('./helpers.js');

for (const width of [1440, 390]) test(`flow view: particles appear, move with the beat, stop when it stops and leave with the mode at width ${width}`, async ({ browser }) => {
  const mobile = width < 700;
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.renderRequests = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => { window.renderRequests++; return original(cb); };
  });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const exterior = await particlePixels(page, await stableShot(c));
  expect(exterior.red).toBe(0);
  await page.locator('#mode-flow').click();
  await expect(page.locator('#mode-flow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mode-number')).toHaveText('04 / FLOW');
  await expect(page.locator('#flow-note')).toBeVisible();
  await expect(page.locator('#conduction-note')).toBeHidden();
  await expect(page.locator('.part:visible')).toHaveCount(10);
  // The coronary arteries are on no route, so choosing them leaves every particle as it was: the thresholds below are unchanged.
  // (Choosing the right ventricle, as this test did before the route emphasis of stage B, now darkens the left-heart particles.)
  await page.getByRole('button', { name: '冠動脈', exact: true }).click();
  await expect(page.locator('#name')).toHaveText('冠動脈');
  await c.scrollIntoViewIfNeeded();
  const rest = await stableShot(c), restPixels = await particlePixels(page, rest);
  expect(restPixels.red).toBeGreaterThan(25); // was 40 before the red rule was tightened: 295 at 1440 px, 52 at 390 px
  expect(restPixels.blue).toBeGreaterThan(2 * exterior.blue + 50);
  // While the beat runs the picture keeps changing; the clock decides the phase, so a pause between two pictures is enough.
  await page.locator('#beat-play').click();
  const first = await c.screenshot();
  await page.waitForTimeout(700);
  expect((await c.screenshot()).equals(first)).toBe(false);
  await page.locator('#beat-play').click();
  const stopped = await stableShot(c);
  expect(stopped.equals(rest)).toBe(false);
  const frames = await page.evaluate(() => window.renderRequests);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.renderRequests)).toBe(frames);
  // Back in the exterior view the particles are gone and the walls are opaque again.
  await page.locator('#mode-exterior').click();
  await expect(page.locator('#flow-note')).toBeHidden();
  await settle(page);
  const after = await particlePixels(page, await stableShot(c));
  expect(after.red).toBe(0);
  expect(after.blue).toBeLessThan(restPixels.blue / 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

// Stage 4: the particles can be laid over the cross-section. They are cut by the same plane, move with the beat, leave when the
// overlay is turned off, and the choice is kept while another view is shown. Counts measured at slider 0.1, width 1440
// (SwiftShader): without the overlay blue 204 and red 0 (the venae cavae are blue); with it blue 1176 and red 63.
test('interior view: the flow overlay shows particles on the cut, follows the beat and is cut by the same plane', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  await page.locator('#mode-interior').click();
  await expect(page.locator('#flow-overlay-note')).toBeHidden();
  await expect(page.locator('#interior-flow')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#cut-depth').fill('0.1');
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const off = await stableShot(c), offPixels = await particlePixels(page, off);
  expect(offPixels.red).toBe(0);
  await page.locator('#interior-flow').click();
  await expect(page.locator('#interior-flow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#flow-overlay-note')).toBeVisible();
  await expect(page.locator('#flow-note')).toBeHidden();
  const on = await stableShot(c), onPixels = await particlePixels(page, on);
  expect(onPixels.red).toBeGreaterThan(20); // was 30 before the red rule was tightened: 39 at slider 0.1 (63 with the old rule on the old lighting)
  expect(onPixels.blue).toBeGreaterThan(offPixels.blue + 500); // about half the increase measured above (204 -> 1176)
  // A cut that keeps only the back leaves fewer particles than one near the middle.
  await page.locator('#cut-depth').fill('1.5');
  const back = await particlePixels(page, await stableShot(c));
  expect(back.blue + back.red).toBeLessThan((onPixels.blue + onPixels.red) / 4);
  await page.locator('#cut-depth').fill('0.1');
  expect((await stableShot(c)).equals(on)).toBe(true);
  // The picture keeps changing while the beat plays.
  await page.locator('#beat-play').click();
  const first = await c.screenshot();
  await page.waitForTimeout(700);
  expect((await c.screenshot()).equals(first)).toBe(false);
  await page.locator('#beat-play').click();
  // Another view does not show them; coming back keeps the choice.
  await page.locator('#mode-exterior').click();
  await expect(page.locator('#flow-overlay-note')).toBeHidden();
  await settle(page);
  expect((await particlePixels(page, await stableShot(c))).red).toBe(0);
  await page.locator('#mode-interior').click();
  await expect(page.locator('#interior-flow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#flow-overlay-note')).toBeVisible();
  await page.locator('#interior-flow').click();
  await expect(page.locator('#flow-overlay-note')).toBeHidden();
  await settle(page);
  expect((await particlePixels(page, await stableShot(c))).red).toBe(0);
  expect(errors).toEqual([]);
  await context.close();
});

// Reduced motion in the flow view (review of PR #30): the beat stops after one beat, the walls return to rest, and the particles
// stay drawn where that beat left them (they are not put back into a starting arrangement).
test('with reduced motion the flow view plays one beat, stops, and keeps drawing the particles', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  await page.locator('#mode-flow').click();
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const rest = await stableShot(c);
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生', { timeout: 15000 });
  const after = await stableShot(c), pixels = await particlePixels(page, after);
  expect(pixels.red).toBeGreaterThan(40);
  expect(after.equals(rest)).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

// Stage B, the blood-flow view: choosing a part emphasises the particles of the routes through it (flow.mjs, routesThrough).
// The phone width was added on 2026-11-14 (Issue #50 recheck, F1: the emphasis had been checked only at the default 1280x720).
// The floors for "particles are drawn" are about half of what was measured (Chromium, SwiftShader): blue 435 / red 157 at 1280x720 (floors
// 100 / 25, unchanged), blue 81 / red 33 at 390x844 (floors 40 / 15, new). The emphasis itself is checked by ratios, the same at both.
for (const [width, height, mobile, floor] of [[1280, 720, false, { blue: 100, red: 25 }], [390, 844, true, { blue: 40, red: 15 }]]) test(`flow view: choosing a part emphasises the routes through it and darkens the others at width ${width}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  const c = page.locator('canvas');
  await page.locator('#mode-flow').click();
  // The part that the view picks on entering does not emphasise anything: both sides are drawn alike.
  await expect(page.locator('#flow-route-note')).toContainText('部位を選ぶと');
  const all = await particlePixels(page, await stableShot(c));
  expect(all.blue).toBeGreaterThan(floor.blue);
  expect(all.red).toBeGreaterThan(floor.red);
  const pick = async name => { await page.getByRole('button', { name, exact: true }).click(); await settle(page); return particlePixels(page, await stableShot(c)); };
  // The right atrium is on the two right routes: the left-heart (red) particles go dark and small.
  const right = await pick('右心房');
  await expect(page.locator('#flow-route-note')).toContainText('上大静脈・下大静脈の2本、右心系');
  expect(right.red).toBeLessThan(all.red * .25);
  expect(right.blue).toBeGreaterThan(all.blue * .8);
  // The left ventricle is on the four left routes.
  const left = await pick('左心室');
  await expect(page.locator('#flow-route-note')).toContainText('左上肺静脈・左下肺静脈・右上肺静脈・右下肺静脈の4本、左心系');
  expect(left.blue).toBeLessThan(all.blue * .25);
  expect(left.red).toBeGreaterThan(all.red * .8);
  // The coronary arteries are on no route: nothing is darkened, and the note says so.
  const coronary = await pick('冠動脈');
  await expect(page.locator('#flow-route-note')).toContainText('通る経路はありません');
  expect(coronary.blue).toBeGreaterThan(all.blue * .8);
  expect(coronary.red).toBeGreaterThan(all.red * .8);
  // Back in the exterior view the note is gone, and coming back to the flow view starts without emphasis again.
  await page.locator('#mode-exterior').click();
  await expect(page.locator('#flow-route-note')).toBeHidden();
  await page.locator('#mode-flow').click();
  await expect(page.locator('#flow-route-note')).toContainText('部位を選ぶと');
  const again = await particlePixels(page, await stableShot(c));
  expect(again.blue).toBeGreaterThan(all.blue * .8);
  expect(again.red).toBeGreaterThan(all.red * .8);
  expect(errors).toEqual([]);
  await context.close();
});
