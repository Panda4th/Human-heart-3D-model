const {test,expect}=require('@playwright/test');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const url = pathToFileURL(path.resolve('index.html')).href;
// Number of pixels that belong to the model: the background is blue-grey and dark, the heart is clearly redder or brighter.
const modelPixels = (page, png) => page.evaluate(async b64 => {
  const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
  const { data } = g.getImageData(0, 0, image.width, image.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 90 || data[i] - data[i + 2] > 25) count++;
  return count;
}, png.toString('base64'));
// Rendering happens in the next animation frame after a state change, so a screenshot taken right away can
// still show the previous frame. Wait for the frame to be drawn before comparing pictures.
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
// Under load the screenshot can still show the previous frame for a while after the frame was drawn (seen in CI on
// main 91d3d5d, and locally with all CPUs busy: 5 of 10 runs). Take pictures until two in a row are the same. A picture
// that keeps changing, as while the model rotates, never settles and fails the test.
const stableShot = async (locator, tries = 40) => {
  let previous = await locator.screenshot();
  for (let i = 0; i < tries; i++) {
    await locator.page().waitForTimeout(50);
    const next = await locator.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error('the canvas picture did not settle');
};
// Viewport position of a label's anchor, read at the moment of the click so that scrolling cannot make it stale.
const anchorOf = (page, text) => page.locator('canvas').evaluate((canvas, text) => {
  const label = [...document.querySelectorAll('.model-label')].find(e => e.textContent.includes(text)), box = canvas.getBoundingClientRect();
  return { x: box.left + box.width * parseFloat(label.style.left) / 100, y: box.top + box.height * parseFloat(label.style.top) / 100 };
}, text);
const clickAnchor = async (page, text, dx = 0) => {
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await settle(page);
  const point = await anchorOf(page, text);
  await page.mouse.click(point.x + dx, point.y);
};
for (const width of [1440,390,320]) test(`offline model and interactions at width ${width}`, async ({browser}, testInfo) => {
  const mobile = width < 700;
  const context = await browser.newContext({viewport:{width,height:900},hasTouch:mobile,isMobile:mobile});
  await context.setOffline(true);
  const page=await context.newPage(), errors=[], requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url())) requests.push(r.url());});
  await page.addInitScript(() => {
    window.renderRequests=0;
    const original=window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame=cb=>{window.renderRequests++; return original(cb);};
  });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('.part:visible')).toHaveCount(10);
  await expect(page.locator('#anatomy-note')).toBeVisible();
  await page.getByRole('button',{name:'大動脈',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('大動脈');
  const c=page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  await c.focus();
  const original = await stableShot(c);
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  const rotated = await stableShot(c);
  expect(rotated.equals(original)).toBe(false);
  await page.keyboard.press('+');
  await settle(page);
  expect((await stableShot(c)).equals(rotated)).toBe(false);
  await page.locator('#reset').click();
  await settle(page);
  await c.focus();
  expect((await stableShot(c)).equals(original)).toBe(true);
  // A drag that returns to its origin must not select the mesh under the release.
  const box = await c.boundingBox(); const x=box.x+box.width*.5,y=box.y+box.height*.5;
  await page.mouse.move(x,y); await page.mouse.down();
  await page.mouse.move(x+40,y,{steps:6}); await page.mouse.move(x,y,{steps:6}); await page.mouse.up();
  await expect(page.locator('#name')).toHaveText('大動脈');
  if (mobile) {
    const client=await context.newCDPSession(page);
    const beforePinch = await modelPixels(page, await stableShot(c));
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-30,y,id:1},{x:x+30,y,id:2}]});
    for (const d of [40,50,60]) await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-d,y,id:1},{x:x+d,y,id:2}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect(page.locator('#name')).toHaveText('大動脈');
    // Spreading two fingers must zoom in (the model covers more pixels); a pan or a rotation would not do that.
    await settle(page);
    expect(await modelPixels(page, await stableShot(c))).toBeGreaterThan(beforePinch * 1.1);
  }
  await page.locator('#reset').click();
  await settle(page);
  // Auto-rotation must turn the model, say that the view is no longer a named one, and stop moving when switched off.
  const stillView = await stableShot(c);
  await page.locator('#rotate').click();
  await expect(page.locator('#orientation')).toContainText('自由視点');
  await expect.poll(async () => (await c.screenshot()).equals(stillView), {timeout:5000}).toBe(false);
  await page.locator('#rotate').click();
  await expect(page.locator('#rotate')).toHaveAttribute('aria-pressed','false');
  await settle(page);
  const stoppedView = await stableShot(c);
  await page.waitForTimeout(400); await settle(page);
  expect((await stableShot(c)).equals(stoppedView)).toBe(true);
  await page.locator('#reset').click();
  await page.locator('#rotate').click();
  await expect(page.locator('#rotate')).toHaveAttribute('aria-pressed','true');
  await page.locator('#reset').click();
  await expect(page.locator('#rotate')).toHaveAttribute('aria-pressed','false');
  await page.screenshot({path:testInfo.outputPath('exterior.png'),fullPage:!mobile});
  await page.locator('#mode-conduction').click();
  await expect(page.locator('.part:visible')).toHaveCount(7);
  await expect(page.locator('#name')).toHaveText('洞房結節');
  await expect(page.locator('#previous')).toBeDisabled();
  await c.screenshot();
  await page.getByRole('button',{name:'房室結節',exact:true}).click();
  await settle(page);
  await clickAnchor(page,'洞房結節');
  await expect(page.locator('#name')).toHaveText('洞房結節');
  // The dashed atrial line is 1 px wide; a click slightly beside it must still select it.
  await clickAnchor(page,'心房への広がり',1.5);
  await expect(page.locator('#name')).toHaveText('心房への広がり');
  await page.getByRole('button',{name:'洞房結節',exact:true}).click();
  for(const name of ['心房への広がり','房室結節','ヒス束','右脚','左脚','プルキンエ線維']) {
    await page.locator('#next').click(); await expect(page.locator('#name')).toHaveText(name);
  }
  await expect(page.locator('#next')).toBeDisabled();
  await page.locator('#view-back').click(); await expect(page.locator('#orientation')).toContainText('背面');
  await page.locator('#view-left').click(); await expect(page.locator('#orientation')).toContainText('身体の左側');
  await page.locator('#view-front').click();
  await page.getByRole('button',{name:'房室結節',exact:true}).click();
  await page.screenshot({path:testInfo.outputPath('conduction.png'),fullPage:!mobile});
  await expect(page.locator('#labels .model-label:visible')).toHaveText('房室結節');
  await page.locator('#mode-interior').click();
  await expect(page.locator('#conduction-note')).toBeHidden();
  await expect(page.locator('#interior-note')).toBeVisible();
  await expect(page.locator('.part:visible')).toHaveCount(9);
  await expect(page.locator('#name')).toHaveText('僧帽弁');
  await page.getByRole('button',{name:'大動脈弁',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('大動脈弁');
  await c.scrollIntoViewIfNeeded();
  const cutBefore = await stableShot(c);
  await page.locator('#cut-depth').fill('0');
  await settle(page);
  expect((await stableShot(c)).equals(cutBefore)).toBe(false);
  const interiorBox = await c.boundingBox();
  await page.mouse.click(interiorBox.x + interiorBox.width*.5, interiorBox.y + interiorBox.height*.6);
  await expect(page.locator('#name')).toHaveText(/^(左心室|右心室|右心房|左心房|僧帽弁|三尖弁|大動脈弁|肺動脈弁|乳頭筋)$/);
  // The cut face of the wall is a drawn surface (flat colour 201,132,120), so a click on it must select the chamber it
  // belongs to. It used to select whatever lay behind it (a valve, a vessel). Sample pixels inside the face, away from its edges.
  await page.getByRole('button',{name:'大動脈弁',exact:true}).click();
  await settle(page);
  const facePoints = await page.evaluate(async b64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, image.width, image.height);
    const isFace = (x, y) => { const i = (y * width + x) * 4; return Math.abs(data[i] - 201) < 3 && Math.abs(data[i + 1] - 132) < 3 && Math.abs(data[i + 2] - 120) < 3; };
    const points = [];
    for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
      if ([[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => isFace(x + dx, y + dy))) points.push([x + .5, y + .5]);
    }
    return points.filter((_, i) => i % Math.ceil(points.length / 14) === 0);
  }, (await stableShot(c)).toString('base64'));
  expect(facePoints.length).toBeGreaterThan(8);
  await c.scrollIntoViewIfNeeded();
  const faceBox = await c.boundingBox();
  for (const [fx, fy] of facePoints) {
    await page.mouse.click(faceBox.x + fx, faceBox.y + fy);
    await expect(page.locator('#name'), `cut face at ${fx},${fy}`).toHaveText(/^(左心室|右心室|右心房|左心房)$/);
    await page.getByRole('button',{name:'大動脈弁',exact:true}).click();
  }
  // The conduction overlay is cut by the same plane. Every conduction point lies in front of the cut at
  // slider 0.9, so there the overlay must add nothing; unclipped, the nodes would float in front of the cut.
  await page.getByRole('button',{name:'大動脈弁',exact:true}).click();
  await settle(page);
  const overlayOffAt0 = await stableShot(c);
  await page.locator('#cut-depth').fill('0.9');
  await settle(page);
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  const overlayOffBehind = await stableShot(c);
  await page.locator('#interior-conduction').click();
  await expect(page.locator('#interior-conduction')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.part:visible')).toHaveCount(16);
  await expect(page.locator('#conduction-note')).toBeVisible();
  // Clicking the button scrolled the page. A canvas at a different fractional scroll position differs in its first pixel row,
  // so put the page back where overlayOffBehind was taken (the selected aortic valve may now show a cut notice that shifts the layout).
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page);
  expect((await stableShot(c)).equals(overlayOffBehind)).toBe(true);
  await page.locator('#cut-depth').fill('0');
  await settle(page);
  expect((await stableShot(c)).equals(overlayOffAt0)).toBe(false);
  await page.getByRole('button',{name:'洞房結節',exact:true}).click();
  await expect(page.locator('#labels .model-label:visible')).toHaveText('洞房結節');
  await page.getByRole('button',{name:'大動脈弁',exact:true}).click();
  await settle(page);
  await clickAnchor(page,'洞房結節');
  await expect(page.locator('#name')).toHaveText('洞房結節');
  await page.locator('#cut-depth').fill('0.9');
  await expect(page.locator('#labels .model-label:visible')).toHaveCount(0);
  await page.locator('#cut-depth').fill('0');
  await page.screenshot({path:testInfo.outputPath('interior-conduction.png'),fullPage:!mobile});
  await page.locator('#interior-conduction').click();
  await expect(page.locator('#name')).toHaveText('僧帽弁');
  await expect(page.locator('.part:visible')).toHaveCount(9);
  await expect(page.locator('#conduction-note')).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('interior.png'),fullPage:!mobile});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if (mobile) {
    // On a phone the page does not scroll: the model and the selected part's description are fixed at the top,
    // and the part list scrolls in its own box below them, so nothing passes underneath the model.
    await page.locator('main').evaluate(m=>{m.scrollTop=m.scrollHeight;});
    await page.locator('.part:visible').last().click();
    await expect(page.locator('#name')).toHaveText('乳頭筋');
    await expect.poll(()=>page.evaluate(()=>{
      const r=document.querySelector('canvas').getBoundingClientRect(), d=document.querySelector('.detail').getBoundingClientRect();
      const m=document.querySelector('main').getBoundingClientRect(), b=document.querySelector('.part[aria-pressed=true]').getBoundingClientRect();
      const atModel=document.elementFromPoint(r.left+r.width/2,r.top+r.height*.9), atNote=document.elementFromPoint(d.left+d.width/2,d.bottom-4);
      return r.top>=0 && r.bottom<=d.top+1 && d.bottom<=m.top+1 && m.bottom<=innerHeight+1 && b.top>=m.top && b.bottom<=m.bottom
        && atModel===document.querySelector('canvas') && document.querySelector('.detail').contains(atNote)
        && document.scrollingElement.scrollHeight<=innerHeight && document.querySelector('main').scrollTop>0;
    }),{message:'model and description stay fixed; the part list scrolls in its own box below them'}).toBe(true);
    // The model stayed black on the user's iPhone when the canvas sat inside the scrolling box under
    // position:fixed (7535baf). Keep the canvas out of any scrolling box and any fixed element.
    expect(await page.evaluate(()=>{
      const bad=[];
      for (let el=document.querySelector('canvas').parentElement; el && el!==document.body; el=el.parentElement) {
        const s=getComputedStyle(el);
        if (s.position==='fixed' || /auto|scroll/.test(s.overflowY)) bad.push(el.tagName+'.'+el.className);
      }
      return bad;
    })).toEqual([]);
    await page.screenshot({path:testInfo.outputPath('interior-scrolled.png')});
    await page.locator('main').evaluate(m=>{m.scrollTop=0;});
  }
  await page.locator('#mode-exterior').click();
  await expect(page.locator('#interior-note')).toBeHidden();
  await expect(page.locator('#cut')).toBeHidden();
  await expect(page.locator('.part:visible')).toHaveCount(10);
  await expect(page.locator('#name')).toHaveText('左心室');
  await page.getByRole('button',{name:'冠動脈',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('冠動脈');
  await c.scrollIntoViewIfNeeded();
  const anatomyBox = await c.boundingBox();
  await page.mouse.click(anatomyBox.x + anatomyBox.width*.5, anatomyBox.y + anatomyBox.height*.55);
  await expect(page.locator('#name')).toHaveText(/^(左心室|右心室|右心房|左心房|冠動脈|冠静脈)$/);
  await page.locator('#view-back').click();
  await page.screenshot({path:testInfo.outputPath('exterior-back.png'),fullPage:!mobile});
  await page.waitForTimeout(100);
  const frames=await page.evaluate(()=>window.renderRequests);
  await page.waitForTimeout(250);
  expect(await page.evaluate(()=>window.renderRequests)).toBe(frames);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(requests).toEqual([]);
  await context.close();
});
// Number of pixels whose colour is within `tolerance` (per channel) of the given colour.
const countColor = (page, png, [r, g, b], tolerance) => page.evaluate(async ([b64, r, g, b, tolerance]) => {
  const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - r) <= tolerance && Math.abs(data[i + 1] - g) <= tolerance && Math.abs(data[i + 2] - b) <= tolerance) count++;
  return count;
}, [png.toString('base64'), r, g, b, tolerance]);
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
  await expect(page.locator('#labels .model-label:visible')).toHaveText('ヒス束');
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
for (const width of [1440, 390]) test(`the two bundle branches are selected and drawn separately at width ${width}`, async ({ browser }) => {
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
  // The label of each branch sits on its own path: clicking at the anchor picks that branch.
  await clickAnchor(page, '左脚');
  await expect(page.locator('#name')).toHaveText('左脚');
  await page.getByRole('button', { name: '右脚', exact: true }).click();
  await settle(page);
  await clickAnchor(page, '右脚');
  await expect(page.locator('#name')).toHaveText('右脚');
  await context.close();
});
test('WebGL failure leaves an explanation and source links',async({page})=>{
  await page.addInitScript(()=>{HTMLCanvasElement.prototype.getContext=()=>null;});
  await page.goto(url);
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#mode-conduction')).toBeDisabled();
  await expect(page.locator('#msd-reference')).toBeVisible();
});
test('context loss stops controls and explains recovery',async({page})=>{
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await page.locator('canvas').evaluate(c=>c.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
  await expect(page.locator('#error')).toContainText('再読み込み');
  await expect(page.locator('#rotate')).toBeDisabled();
  await expect(page.locator('html')).toHaveAttribute('data-ready','false');
});

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
