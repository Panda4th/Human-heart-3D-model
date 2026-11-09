const {test,expect}=require('@playwright/test');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const url = pathToFileURL(path.resolve('index.html')).href;
// Smoke test on the WebKit engine (Playwright's Linux build, not iOS Safari): the single HTML file must start,
// switch modes, select parts and move the cut without errors. It does not compare pictures.
test('WebKit engine: single HTML starts, switches modes and selects parts',async({page},testInfo)=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready','true');
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('.part:visible')).toHaveCount(10);
  await page.getByRole('button',{name:'大動脈',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('大動脈');
  await page.locator('#mode-conduction').click();
  await expect(page.locator('.part:visible')).toHaveCount(8);
  await page.getByRole('button',{name:'ヒス束（分岐区間）',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('ヒス束（分岐区間）');
  await page.getByRole('button',{name:'左脚',exact:true}).click();
  await expect(page.locator('#description')).toContainText('幅のある面');
  await page.locator('#mode-interior').click();
  await expect(page.locator('.part:visible')).toHaveCount(9);
  await page.locator('#cut-depth').fill('0');
  await page.getByRole('button',{name:'三尖弁',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('三尖弁');
  // The canvas must show something other than the plain background.
  const picture=await page.locator('canvas').screenshot({path:testInfo.outputPath('webkit-interior.png')});
  await page.locator('#mode-flow').click();
  await expect(page.locator('.part:visible')).toHaveCount(10);
  await page.locator('#beat-play').click();
  await page.waitForTimeout(500);
  await page.locator('#beat-play').click();
  await page.locator('#mode-exterior').click();
  expect((await page.locator('canvas').screenshot()).equals(picture)).toBe(false);
  expect(errors).toEqual([]);
});

test('Issue 17: capture both section slider endpoints', async ({page}, testInfo) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.context().setOffline(true);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#error')).toBeHidden();
  await page.locator('#mode-interior').click();
  const slider = page.locator('#cut-depth');
  const canvas = page.locator('canvas');
  const capture = async (key, value, filename) => {
    await slider.press(key);
    await expect(slider).toHaveValue(value);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    let previous = await canvas.screenshot();
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(75);
      const picture = await canvas.screenshot();
      if (picture.equals(previous)) {
        await testInfo.attach(filename, {body:picture,contentType:'image/png'});
        return picture;
      }
      previous = picture;
    }
    throw new Error('Section screenshot did not stabilize');
  };
  const front = await capture('Home', '-1.8', 'section-front-end');
  const back = await capture('End', '1.8', 'section-back-end');
  expect(front.equals(back)).toBe(false);
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});
