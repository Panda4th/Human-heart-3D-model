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
  await expect(page.locator('.part:visible')).toHaveCount(8);
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
  for(const name of ['心房への広がり','房室結節','ヒス束（近位区間）','ヒス束（分岐区間）','右脚','左脚','プルキンエ線維']) {
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
  await expect(page.locator('.part:visible')).toHaveCount(17);
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
for (const width of [1440, 390]) test(`His intervals select independently at width ${width}`, async ({browser}, testInfo) => {
  const context = await browser.newContext({viewport:{width,height:900},hasTouch:width<700,isMobile:width<700});
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await page.locator('#mode-conduction').click();
  const c = page.locator('canvas');
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
  await expect(page.locator('#description')).toContainText('全員共通の3本');
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

// The heartbeat runs only while playing, keeps its shape when stopped, and the cut face follows it.
for (const width of [1440, 390]) test(`heartbeat plays, shows its phase and stops drawing when stopped at width ${width}`, async ({ browser }) => {
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
  await expect(page.locator('#beat-phase')).toBeHidden();
  await page.locator('#mode-interior').click();
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const still = await stableShot(c);
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を止める');
  await expect(page.locator('#beat-play')).not.toHaveAttribute('aria-pressed');
  await expect(page.locator('#beat-phase')).toBeVisible();
  await expect(page.locator('#beat-note')).toBeVisible();
  await expect(page.locator('#beat-phase-name')).toHaveText(/^(心房の収縮|心室の収縮|心室の弛緩)（約/);
  await expect(page.locator('#beat-phase-valves')).toBeVisible({ visible: !mobile });
  // The beat must keep advancing: watch the phase name for 3 s (a full slow cycle is 4 s, and the atrial phase alone is
  // 0.5 s). This does not depend on how many frames a slow machine draws; the clock decides the phase.
  const seen = new Set();
  for (let i = 0; i < 15; i++) { seen.add(await page.locator('#beat-phase-name').textContent()); await page.waitForTimeout(200); }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を再生');
  await expect(page.locator('#beat-phase')).toBeVisible();
  const stopped = await stableShot(c);
  expect(stopped.equals(still)).toBe(false);
  const frames = await page.evaluate(() => window.renderRequests);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.renderRequests)).toBe(frames);
  await page.locator('#beat-speed').click();
  await expect(page.locator('#beat-speed')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

// The picture, not only the numbers, shows the beat: the model's outline and the cut face shrink while the ventricles
// contract, and the cut face is drawn from the deformed shape. Measured in Chromium/SwiftShader on main + this change at
// 1440 px: about 1.9 s into the slow beat the outline had 5.0% fewer model pixels and the cut face 8.1% fewer than at
// rest, and a relaxed state (3.2 s) matched rest exactly. The page keeps its phase box over the canvas, so it is hidden here.
test('the outline and the cut face shrink in the picture while the ventricles contract', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const measure = async () => {
    const png = await stableShot(c, 80);
    return { model: await modelPixels(page, png), cap: await countColor(page, png, [201, 132, 120], 8) };
  };
  const exteriorRest = await measure();
  await page.locator('#mode-interior').click();
  const interiorRest = await measure();
  expect(interiorRest.cap).toBeGreaterThan(5000);
  await page.locator('#beat-play').click();
  // 1.5 s of the slow beat is 300 ms of the real cycle: the ventricles are about three quarters contracted.
  await page.waitForTimeout(1500);
  await page.locator('#beat-play').click();
  const interiorBeat = await measure();
  expect(interiorBeat.cap).toBeLessThan(interiorRest.cap * .97);
  expect(interiorBeat.model).toBeLessThan(interiorRest.model * .98);
  await context.close();
  expect(exteriorRest.model).toBeGreaterThan(30000);
});

// The system setting "reduce motion": one beat per press, then rest, instead of a loop (README, beat section).
test('with reduced motion the beat plays once and returns to rest', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生');
  const c = page.locator('canvas');
  await c.scrollIntoViewIfNeeded();
  const rest = await stableShot(c);
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を止める');
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生', { timeout: 15000 });
  expect((await stableShot(c)).equals(rest)).toBe(true);
  await context.close();
});

// The blood-flow view draws particles (blue on the right-heart routes, red on the left-heart routes) inside walls drawn at
// opacity 0.12. A lit particle is not a pure colour, so these rules were found by measuring (Chromium/SwiftShader, at rest,
// pixels counted at 1440 px width / 390 px width): the red rule (red - green > 120, red > 170, blue < 110) matched 0 / 0 in the
// exterior view and 322 / 97 in the flow view; the blue rule (blue - red > 90, blue > 140) matched 207 / 38 in the exterior view
// (the pulmonary arteries and veins are bluish) and 729 / 218 in the flow view.
const particlePixels = (page, png) => page.evaluate(async b64 => {
  const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let blue = 0, red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 2] - data[i] > 90 && data[i + 2] > 140) blue++;
    if (data[i] - data[i + 1] > 120 && data[i] > 170 && data[i + 2] < 110) red++;
  }
  return { blue, red };
}, png.toString('base64'));
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
  await page.getByRole('button', { name: '右心室', exact: true }).click();
  await expect(page.locator('#name')).toHaveText('右心室');
  await c.scrollIntoViewIfNeeded();
  const rest = await stableShot(c), restPixels = await particlePixels(page, rest);
  expect(restPixels.red).toBeGreaterThan(40);
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
  expect(onPixels.red).toBeGreaterThan(30);
  expect(onPixels.blue).toBeGreaterThan(offPixels.blue + 500);
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

test('Issue 17: inspect aortic joins and duplicated wall faces in the distributed viewer', async ({browser}, testInfo) => {
  test.setTimeout(180000);
  const fs = require('node:fs/promises');
  const {execFileSync} = require('node:child_process');
  expect(execFileSync('git', ['hash-object', 'index.html'], {encoding:'utf8'}).trim()).toBe('01e9bc86a573c0e5c57c24ec01610e1536e73c30');
  const context = await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2});
  await context.setOffline(true);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const cdp = await context.newCDPSession(page);
  const lines = (await fs.readFile('index.html','utf8')).split('\n');
  const lineNumber = lines.findIndex(line => line.includes('i.render(t,e),xe()'));
  expect(lineNumber).toBeGreaterThan(0);
  const columnNumber = lines[lineNumber].indexOf('i.render(t,e),xe()');
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setBreakpointByUrl', {url, lineNumber, columnNumber});
  const probe = new Promise((resolve,reject) => cdp.once('Debugger.paused', async event => {
    try {
      const result = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId:event.callFrames[0].callFrameId,
        expression:'window.__issue17 = {camera:e, parts:o, plane:c, section:h, ray:se, pick:tc, vec:I, point:yt, get mode(){return O}}; true',
        returnByValue:true,
      });
      if (result.exceptionDetails || result.result.value !== true) throw Error(JSON.stringify(result.exceptionDetails));
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      await cdp.send('Debugger.resume').catch(() => {});
    }
  }));
  await Promise.all([page.goto(url), probe]);
  await cdp.send('Debugger.disable');
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await expect(page.locator('#error')).toBeHidden();
  const canvas = page.locator('canvas');
  const runs = [];
  const pictures = [];
  for (const view of [
    {name:'front',turns:0,zoom:0,depth:null},
    {name:'front-zoom',turns:0,zoom:3,depth:null},
    {name:'right-zoom',turns:10,zoom:3,depth:null},
    {name:'back-zoom',turns:0,zoom:3,depth:null,back:true},
    {name:'cut-front-minus-060',turns:0,zoom:2,depth:-.6},
    {name:'cut-front-zero',turns:0,zoom:2,depth:0},
    {name:'cut-front-plus-050',turns:0,zoom:2,depth:.5},
    {name:'cut-right-zero',turns:8,zoom:2,depth:0},
  ]) {
    await page.locator(view.depth === null ? '#mode-exterior' : '#mode-interior').click();
    if (view.depth !== null) await page.locator('#cut-depth').fill(String(view.depth));
    if (view.back) await page.locator('#view-back').click();
    await canvas.scrollIntoViewIfNeeded();
    await canvas.focus();
    for(let index=0;index<view.turns;index++) await canvas.press('ArrowLeft');
    for(let index=0;index<view.zoom;index++) await canvas.press('+');
    await settle(page);
    const sample = await page.evaluate(() => {
      const {camera,parts,plane,section,ray:baseRay,pick,vec:Vector,point:Point,mode} = window.__issue17;
      const ray = new baseRay.constructor();
      const interior = mode === 'interior';
      const targets = [...parts.values()].filter(group => group.userData.kind !== 'conduction');
      const walls = ['lv','rv','ra','la'].map(id => parts.get(id).children[0]);
      const aorta = parts.get('ao').children[0];
      const vertices = mesh => mesh.geometry.attributes.position;
      const triangle = (mesh, offset) => {
        const points = vertices(mesh);
        const indices = mesh.geometry.index;
        return [0,1,2].map(i => new Vector().fromBufferAttribute(points, indices.getX(offset + i)));
      };
      const midpoint = ([a,b,c]) => a.clone().add(b).add(c).divideScalar(3);
      const cross = ([a,b,c]) => b.clone().sub(a).cross(c.clone().sub(a));
      const key = point => point.toArray().map(v => Math.round(v * 100)).join(',');
      const seen = new Map(), duplicates = [];
      const skip = new Map(walls.map(wall => [wall,new Set()]));
      for(const wall of walls) {
        for(let offset=0;offset<wall.geometry.index.count;offset+=3) {
          const points = triangle(wall,offset);
          const sorted = points.map(key).sort().join('/');
          if (!seen.has(sorted)) seen.set(sorted,[]);
          seen.get(sorted).push({wall,points,face:offset/3});
        }
      }
      for (const members of seen.values()) {
        if (members.length<2) continue;
        const [{wall,points}] = members;
        const normal=cross(points);
        duplicates.push({wall,points,memberCount:members.length,
          crossChamber:members.some(member=>member.wall!==wall),
          opposite:members.some(member=>normal.dot(cross(member.points))<0),
          center:midpoint(points)});
        for(const member of members) skip.get(member.wall).add(member.face);
      }
      const screen = (mesh,point) => mesh.localToWorld(point.clone()).project(camera);
      const cameraRay = p => {
        ray.setFromCamera(new Point(p.x,p.y),camera);
        return ray;
      };
      const isScreen = p => Math.abs(p.x)<.98 && Math.abs(p.y)<.98;
      const hitAt = p => pick(cameraRay(p),targets,interior?[plane]:[],interior?section.solids:[]);
      const seams = [];
      for(let offset=0;offset<aorta.geometry.index.count;offset+=3) {
        const points = triangle(aorta,offset), center = midpoint(points);
        if(points.some(p => p.y<1299 || p.y>1306)) continue;
        const p = screen(aorta,center);
        if (!isScreen(p)) continue;
        const world = aorta.localToWorld(center.clone());
        const hit = hitAt(p);
        if(hit?.id==='ao' && Math.abs(hit.distance-camera.position.distanceTo(world))<.012) {
          const joint = center.z > 100 ? 'ascending-arch' : center.z < 90 ? 'arch-descending' : 'other';
          seams.push({p,center,hit,joint});
        }
      }
      const spread = candidates => {
        const chosen = [];
        for (const candidate of candidates) {
          if (chosen.every(old => old.p.distanceTo(candidate.p)>.025)) chosen.push(candidate);
          if(chosen.length===6) break;
        }
        return chosen;
      };
      const projected = duplicates.map(item => ({...item,p:screen(item.wall,item.center),area:cross(item.points).length()/2})).filter(x => isScreen(x.p));
      for(const item of projected) item.hit=hitAt(item.p);
      const saved = [];
      for(const [wall,faces] of skip) for(const mesh of wall.parent.children) {
        if(mesh.geometry!==wall.geometry) continue;
        const original = mesh.raycast;
        mesh.raycast = function(r,hits) {
          const subset = [];
          original.call(this,r,subset);
          hits.push(...subset.filter(hit => !faces.has(hit.faceIndex)));
        };
        saved.push([mesh,original]);
      }
      try {
        for(const item of projected) item.without = hitAt(item.p);
      } finally {
        for(const [mesh,method] of saved) mesh.raycast=method;
      }
      const signature = h => h ? `${h.id}/${h.onCut ? 'cut' : 'surface'}` : 'none';
      const ownSurface = projected.filter(item => item.hit && !item.hit.onCut &&
        Math.abs(item.hit.distance-camera.position.distanceTo(item.wall.localToWorld(item.center.clone())))<.012);
      const cutHits = projected.filter(item => item.hit?.onCut);
      const changed = projected.filter(item => signature(item.hit)!==signature(item.without));
      const rect = document.querySelector('canvas').getBoundingClientRect();
      const describe = item => {
        const x=(item.p.x+1)/2,y=(1-item.p.y)/2;
        const actualX=Math.round(rect.left+rect.width*x);
        const actualY=Math.round(rect.top+rect.height*y);
        const rounded=hitAt({x:(actualX-rect.left)/rect.width*2-1,y:1-(actualY-rect.top)/rect.height*2});
        if (signature(rounded)!==signature(item.hit)) return null;
        return {x,y,hit:signature(item.hit),without:item.without ? signature(item.without):'none',
          center:item.center.toArray().map(v=>+v.toFixed(2))};
      };
      const samples=(items,sample,limit=3)=>spread(items).map(item=>{
        const point=describe(item);
        return point && {...point,sample:typeof sample==='function'?sample(item):sample};
      }).filter(Boolean).slice(0,limit);
      const click = [
        ...samples(seams.filter(item=>item.joint==='ascending-arch'),item=>item.joint,2),
        ...samples(seams.filter(item=>item.joint==='arch-descending'),item=>item.joint,2),
        ...samples(ownSurface.sort((a,b)=>b.area-a.area),'duplicate-at-visible-surface'),
        ...samples((changed.length?changed:cutHits).filter(item=>item.hit?.onCut),'cut-in-front-of-duplicate'),
      ];
      return {
        camera:camera.position.toArray(),
        duplicates:duplicates.length, opposite:duplicates.filter(item=>item.opposite).length,
        crossChamber:duplicates.filter(item=>item.crossChamber).length,
        multiplicities:duplicates.reduce((counts,item)=>{counts[item.memberCount]=(counts[item.memberCount]||0)+1;return counts;},{}),
        projected:projected.length, atVisibleSurface:ownSurface.length, cutHits:cutHits.length, seamSamples:seams.reduce((counts,item)=>{counts[item.joint]=(counts[item.joint]||0)+1;return counts;},{}),
        changed:changed.reduce((counts,item)=>{
          const change = signature(item.hit)+' -> '+signature(item.without);
          counts[change] = (counts[change]||0)+1;
          return counts;
        },{}),
        click,
      };
    });
    expect(sample.duplicates).toBe(457);
    const picture = await stableShot(canvas);
    await testInfo.attach(view.name,{body:picture,contentType:'image/png'});
    // A compact contact sheet is logged too so the images can be inspected from the run without downloading its archive.
    pictures.push({name:view.name,png:picture.toString('base64')});
    const names = {lv:'左心室',rv:'右心室',la:'左心房',ra:'右心房',ao:'大動脈',pa:'肺動脈',vc:'大静脈',pv:'肺静脈',ca:'冠動脈',cv:'冠静脈',mv:'僧帽弁',tv:'三尖弁',aov:'大動脈弁',pov:'肺動脈弁',pm:'乳頭筋'};
    for(const point of sample.click) {
      const [id,kind] = point.hit.split('/');
      const expected = view.depth!==null && id==='ao' ? '僧帽弁' : names[id];
      await page.getByRole('button',{name:expected==='僧帽弁'?'三尖弁':view.depth===null?'大静脈':'僧帽弁',exact:true}).click();
      if(view.depth!==null && id==='ao') await page.getByRole('button',{name:'僧帽弁',exact:true}).click();
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      await page.mouse.click(Math.round(box.x+box.width*point.x),Math.round(box.y+box.height*point.y));
      point.actual = await page.locator('#name').innerText();
      point.actualCut = await page.locator('#pick-note').isVisible();
      point.expected = expected;
      point.matches = point.actual===expected && point.actualCut===(kind==='cut');
    }
    runs.push({...view,...sample});
    console.log('ISSUE17_RESULT '+JSON.stringify(runs.at(-1)));
  }
  const sheet = await page.evaluate(async pictures => {
    const chart=document.createElement('canvas');
    chart.width=1120; chart.height=980;
    const ctx=chart.getContext('2d');
    ctx.fillStyle='#181b24';ctx.fillRect(0,0,chart.width,chart.height);
    ctx.fillStyle='#fff';ctx.font='15px sans-serif';
    for(const [i,picture] of pictures.entries()) {
      const image=new Image();
      image.src='data:image/png;base64,'+picture.png;
      await image.decode();
      const x=i%2*560,y=Math.floor(i/2)*245;
      ctx.fillText(picture.name,x+8,y+19);
      const size=Math.min(560/image.width,224/image.height);
      ctx.drawImage(image,x+(560-image.width*size)/2,y+21,image.width*size,image.height*size);
    }
    return chart.toDataURL('image/jpeg',.75).split(',')[1];
  }, pictures);
  for(let offset=0;offset<sheet.length;offset+=5000) console.log('ISSUE17_SHEET '+sheet.slice(offset,offset+5000));
  await testInfo.attach('issue-17-contact-sheet',{body:Buffer.from(sheet,'base64'),contentType:'image/jpeg'});
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  expect(runs.flatMap(run=>run.click).length).toBeGreaterThan(10);
  const mismatches = runs.flatMap(run=>run.click.filter(point=>!point.matches));
  expect(mismatches).toEqual([]);
  await context.close();
});
