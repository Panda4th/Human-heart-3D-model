// The interior view (the cut).
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const { url, settle, stableShot, countColor } = require('./helpers.js');

for (const width of [1440, 390]) test(`cut view: removed parts, hidden labels, the clicked cut face and the dashed line at width ${width}`, async ({ browser }) => {
  const mobile = width < 700;
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  const c = page.locator('canvas'), part = name => page.locator('.part', { hasText: name }).first();
  await page.locator('#mode-interior').click();
  await page.locator('#interior-conduction').click();
  // 1. At 0.9 the whole conduction system is cut away: say so, mark the button, and offer a way back.
  await page.locator('#cut-depth').fill('0.9');
  await part('洞房結節').click();
  await expect(page.locator('#name')).toHaveText('洞房結節');
  await expect(page.locator('#cut-notice')).toBeVisible();
  await expect(part('洞房結節')).toHaveClass(/cut-out/);
  await expect(part('洞房結節')).toHaveAttribute('aria-description', /見えません/);
  await expect(part('僧帽弁')).not.toHaveClass(/cut-out/);
  await page.locator('#cut-restore').click();
  await expect(page.locator('#cut-notice')).toBeHidden();
  expect(Number(await page.inputValue('#cut-depth'))).toBeLessThan(0.9);
  await expect(page.locator('#labels .model-label:visible')).toHaveText('洞房結節');
  await expect(part('洞房結節')).not.toHaveClass(/cut-out/);
  // 2. At -0.3 seen from the front, the His bundle lies behind the cut wall; the Purkinje label is in view
  // (the same cases as the unit test).
  await page.locator('#cut-depth').fill('-0.3');
  await part('ヒス束').click();
  await expect(page.locator('#labels .model-label:visible')).toHaveText('ヒス束（近位区間）');
  await expect(page.locator('#labels .model-label.behind:visible')).toHaveCount(1);
  await part('プルキンエ線維').click();
  await expect(page.locator('#labels .model-label:visible')).toHaveText('プルキンエ線維');
  await expect(page.locator('#labels .model-label.behind:visible')).toHaveCount(0);
  await page.locator('#cut-depth').fill('0');
  // 3. A click on the cut face shows a ring and the chamber's own region in a brighter colour; a part button shows no ring.
  await part('大動脈弁').click();
  await settle(page);
  const regionColor = [255, 199, 158];
  expect(await countColor(page, await stableShot(c), regionColor, 6)).toBe(0);
  const facePoints = await page.evaluate(async b64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, image.width, image.height);
    const isFace = (x, y) => { const i = (y * width + x) * 4; return Math.abs(data[i] - 201) < 3 && Math.abs(data[i + 1] - 132) < 3 && Math.abs(data[i + 2] - 120) < 3; };
    const points = [];
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) if ([[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => isFace(x + dx, y + dy))) points.push([x + .5, y + .5]);
    return points.filter((_, i) => i % Math.ceil(points.length / 5) === 0);
  }, (await stableShot(c)).toString('base64'));
  expect(facePoints.length).toBeGreaterThan(2);
  await c.scrollIntoViewIfNeeded();
  const box = await c.boundingBox();
  const [fx, fy] = facePoints[Math.floor(facePoints.length / 2)];
  await page.mouse.click(box.x + fx, box.y + fy);
  await expect(page.locator('#name')).toHaveText(/^(左心室|右心室|右心房|左心房)$/);
  await expect(page.locator('#pick-mark')).toBeVisible();
  await expect(page.locator('#pick-note')).toBeVisible();
  await settle(page);
  expect(await countColor(page, await stableShot(c), regionColor, 6)).toBeGreaterThan(50);
  await page.locator('#cut-depth').fill('0.3'); // the ring marked a point on the old plane
  await expect(page.locator('#pick-mark')).toBeHidden();
  await expect(page.locator('#pick-note')).toBeHidden();
  await part('大動脈弁').click();
  await expect(page.locator('#pick-mark')).toBeHidden();
  await settle(page);
  expect(await countColor(page, await stableShot(c), regionColor, 6)).toBe(0);
  // Leaving the interior view clears the region.
  await part('左心室').click();
  await page.locator('#mode-exterior').click();
  await settle(page);
  expect(await countColor(page, await stableShot(c), regionColor, 6)).toBe(0);
  // 4. The dashed atrial line turns bright when it is the selected part, and dims when another part is selected.
  await page.locator('#mode-conduction').click();
  await part('心房への広がり').click();
  await settle(page);
  await c.scrollIntoViewIfNeeded();
  // The line is 1 px wide and blends with the background, so count pixels whose weakest channel is above 150
  // (measured at 1440 px: 96 with the line selected, 17 without; the labels and nodes are not that bright).
  const brightPixels = async () => countColor(page, await stableShot(c), [255, 255, 255], 105);
  const selectedLine = await brightPixels();
  await part('洞房結節').click();
  await settle(page);
  const otherSelected = await brightPixels();
  expect(selectedLine, 'selected dashed line').toBeGreaterThan(otherSelected + 30);
  expect(errors).toEqual([]);
  await context.close();
});

// Issue #50 C5: a part the cut removed was dimmed with opacity .55, which put its tag "断面で消えた" at 3.78:1. Name and tag must keep
// 4.5:1 against the button, and the button must not be see-through.
test('interior view: the name and the tag of a part the cut removed keep 4.5:1 contrast', async ({ page }) => {
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#mode-interior').click();
  await page.locator('#cut-depth').fill('0.9');
  const button = page.locator('.part.cut-out').first();
  await expect(button).toBeVisible();
  const result = await button.evaluate(b => {
    const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => { const [r, g, b2] = rgb(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b2; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
    const style = getComputedStyle(b), tag = getComputedStyle(b.querySelector('.cut-tag'));
    return { opacity: style.opacity, name: ratio(style.color, style.backgroundColor), tag: ratio(tag.color, style.backgroundColor) };
  });
  expect(result.opacity).toBe('1');
  expect(result.name).toBeGreaterThanOrEqual(4.5);
  expect(result.tag).toBeGreaterThanOrEqual(4.5);
});
