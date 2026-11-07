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
  await expect(page.locator('.part:visible')).toHaveCount(6);
  await page.locator('#mode-interior').click();
  await expect(page.locator('.part:visible')).toHaveCount(9);
  await page.locator('#cut-depth').fill('0');
  await page.getByRole('button',{name:'三尖弁',exact:true}).click();
  await expect(page.locator('#name')).toHaveText('三尖弁');
  // The canvas must show something other than the plain background.
  const picture=await page.locator('canvas').screenshot({path:testInfo.outputPath('webkit-interior.png')});
  await page.locator('#mode-exterior').click();
  expect((await page.locator('canvas').screenshot()).equals(picture)).toBe(false);
  expect(errors).toEqual([]);
});
