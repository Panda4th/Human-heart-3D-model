// Start, views and controls, and what the page does when it cannot run.
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const { url, modelPixels, settle, stableShot, clickAnchor } = require('./helpers.js');

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

// Issue #50 B4: without JavaScript the controls are disabled instead of looking usable.
test('without JavaScript the controls are disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(url);
  // The <noscript> notice itself is not checked: with javaScriptEnabled false, Chromium still parses <noscript> as if scripts ran, so
  // the notice is not in the page Playwright sees (tried 2026-11-14).
  for (const id of ['mode-exterior', 'mode-conduction', 'view-front', 'beat-play', 'heart-sound', 'cut-depth']) await expect(page.locator(`#${id}`)).toBeDisabled();
  await context.close();
});

// Review of PR #51: any broken bundle (here its JSON length is wrong, so the JSON does not parse) is a data error, not a missing WebGL;
// and a script that cannot run at all (a syntax error, as in a browser too old for its syntax) still leaves an explanation.
for (const [name, edit, text] of [
  ['a broken data bundle', html => html.replace('fromBase64("QlAzRGA8AAB7', 'fromBase64("QlAzRGA8AAF7'), 'データを読み込めませんでした'],
  ['a script that cannot run', html => { const at = html.lastIndexOf('<script>') + '<script>'.length; return html.slice(0, at) + ')' + html.slice(at); }, 'プログラムを起動できませんでした'],
]) test(`${name} leaves its own explanation`, async ({ page }, testInfo) => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8'), changed = edit(html);
  expect(changed).not.toBe(html);
  const file = testInfo.outputPath('broken.html');
  fs.writeFileSync(file, changed);
  await page.goto(pathToFileURL(file).href);
  await expect(page.locator('#error')).toContainText(text);
  await expect(page.locator('#mode-conduction')).toBeDisabled();
  await expect(page.locator('#msd-reference')).toBeVisible();
});

// Issue #50 B2: a click on the model starts the orbit controls without turning the camera, and the orientation line said "自由視点"
// though the view was still the named one. The same held for a wheel zoom. Only a turn of the camera leaves the named view.
test('a click or a wheel zoom on the model keeps the named view; a drag leaves it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#view-back').click();
  await expect(page.locator('#orientation')).toContainText('背面');
  const box = await page.locator('canvas').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await settle(page);
  await expect(page.locator('#orientation')).toContainText('背面');
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -200);
  await settle(page);
  await expect(page.locator('#orientation')).toContainText('背面');
  await page.mouse.down();
  await page.mouse.move(x + 80, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#orientation')).toContainText('自由視点');
  expect(errors).toEqual([]);
  await context.close();
});
