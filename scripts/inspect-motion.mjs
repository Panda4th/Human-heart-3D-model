// Reproducible visual inspection. Builds a temporary instrumented page; index.html is untouched.
// Run from the repository root: node scripts/inspect-motion.mjs <output-directory>
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] || '../motion-inspection');
const playbackOnly = process.argv[3] === 'playback-only';
await mkdir(out, { recursive: true });
const hook = `
  // Inspection hooks exist only in the temporary page built by inspect-motion.mjs.
  const originals = new Map(), distances = new Map();
  exterior.traverse(o => {
    if (o.isMesh && !o.userData.helper && o.geometry.attributes.normal && !originals.has(o.geometry))
      originals.set(o.geometry, o.geometry.attributes.normal.array.slice());
    if (o.isLine) distances.set(o, o.geometry.attributes.lineDistance.array.slice());
  });
  window.inspection = {
    at(t) {
      if (t < beatTime) throw new Error('inspection time must increase');
      flow.advance(beatTime, t); beatTime = t;
      beat.set(contraction(t)); drawFlow(); showPhase();
      renderer.render(scene, camera); updateLabels();
      return Object.fromEntries(Object.keys(flow.valves).map(k => [k, flow.openness(k)]));
    },
    focus(name, view) {
      const center = name==='all' ? Object.values(flow.valves).reduce((a,v) => a.map((x,i)=>x+v.center[i]/4),[0,0,0]) : flow.valves[name].center;
      const p = exterior.localToWorld(new THREE.Vector3(...center));
      const direction = {front:[0,.12,1],back:[0,.12,-1],left:[1,.12,0]}[view];
      controls.minDistance = .1; controls.maxDistance = 30;
      controls.target.copy(p);
      camera.position.copy(p).add(new THREE.Vector3(...direction).normalize().multiplyScalar(name==='all'?4.5:2.8));
      controls.update(); renderer.render(scene,camera);
    },
    compare(normals, dashes) {
      const start = performance.now();
      for (const [g, rest] of originals) {
        if (normals) g.computeVertexNormals();
        else { g.attributes.normal.array.set(rest); g.attributes.normal.needsUpdate = true; }
      }
      const normalMs = performance.now() - start;
      for (const [line, rest] of distances) {
        if (dashes) line.computeLineDistances();
        else { line.geometry.attributes.lineDistance.array.set(rest); line.geometry.attributes.lineDistance.needsUpdate = true; }
      }
      renderer.render(scene,camera);
      return { normalMs, geometries: originals.size };
    },
    state: () => ({beating, beatTime, realSpeed, mode, flowOverlay}),
  };
`;
const source = (await readFile('src/main.js', 'utf8')).replace("  document.documentElement.dataset.ready = 'true';", hook + "  document.documentElement.dataset.ready = 'true';");
const bundle = await build({ stdin: { contents: source, resolveDir: resolve('src'), loader: 'js' }, bundle: true, write: false, format: 'iife', loader: { '.bin': 'binary' } });
const template = await readFile('src/template.html', 'utf8');
const notices = await readFile('THIRD_PARTY_NOTICES.txt','utf8');
const escapeHtml = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const html = template.replace('/* APP */', () => bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')).replace('<!-- LICENSE -->',()=>escapeHtml(notices));
const pagePath = resolve(out, 'inspection.html');
await writeFile(pagePath, html);
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}), args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { viewport: {width:1200,height:900}, renderer:'Chromium / SwiftShader', errors:[], snapshots:[], comparisons:[], playback:[] };
async function open(width=1200, reducedMotion='no-preference',video=false) {
  const context = await browser.newContext({viewport:{width,height:900},reducedMotion,...(video?{recordVideo:{dir:resolve(out,'videos'),size:{width,height:900}}}:{})});
  await context.setOffline(true);
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(pathToFileURL(pagePath).href);
  await page.waitForSelector('html[data-ready="true"]');
  return {context,page};
}
async function shot(page, filename) {
  await page.locator('canvas').screenshot({path:resolve(out,filename)});
}
// Close-ups from each named direction at the six transition/flow times used in the earlier inspection.
if (!playbackOnly) for (const view of ['front','back','left']) {
  const {context,page} = await open();
  await page.locator('#mode-flow').click();
  for (const time of [30,130,260,400,430,470]) {
    const openness = await page.evaluate(t => inspection.at(t), time);
    for (const valve of ['tricuspid','mitral','aortic','pulmonary']) {
      await page.evaluate(([v,w]) => inspection.focus(v,w), [valve,view]);
      const filename = 'flow-'+valve+'-'+view+'-'+time+'.png';
      await shot(page,filename);
      report.snapshots.push({filename,valve,view,time,openness:openness[valve]});
    }
  }
  await context.close();
  console.log('close-ups',view);
}
// Interior source leaflets remain unchanged, including the accepted route crossings.
if (!playbackOnly) for (const depth of ['0.1','0.5']) {
  const {context,page} = await open();
  await page.locator('#mode-interior').click();
  await page.locator('#interior-flow').click();
  await page.locator('#cut-depth').fill(depth);
  await page.evaluate(() => inspection.at(260));
  for (const valve of ['tricuspid','mitral','aortic','pulmonary']) {
    await page.evaluate(v => inspection.focus(v,'front'),valve);
    await shot(page,'interior-'+valve+'-'+depth+'.png');
  }
  await context.close();
}
// Compare the existing normal field/dash distances with recomputation at matched phases and views.
if (!playbackOnly) for (const mode of ['exterior','interior','conduction']) {
  const {context,page} = await open();
  await page.locator('#mode-'+mode).click();
  if (mode==='conduction') await page.getByRole('button',{name:'心房への広がり',exact:true}).click();
  for (const time of [50,260]) {
    await page.evaluate(t => inspection.at(t),time);
    for (const view of ['front','back','left']) {
      await page.locator('#view-'+view).click();
      await page.locator('#in').click();
      await page.locator('#in').click();
      await page.evaluate(() => inspection.compare(false,false));
      const prefix = 'compare-'+mode+'-'+view+'-'+time;
      await shot(page,prefix+'-rest.png');
      const cost = await page.evaluate(() => inspection.compare(true,true));
      await shot(page,prefix+'-recomputed.png');
      report.comparisons.push({mode,view,time,prefix,...cost});
    }
  }
  await context.close();
}
// Actual UI playback: record at least two cycles per speed without taking canvas screenshots.
// Canvas screenshots stalled rendering and changed the recording's framing in the first run.
for (const mode of ['flow','interior','conduction']) {
 for (const view of mode==='flow'?['front','back','left']:['front']) {
  for (const speed of ['slow','real']) {
    const {context,page} = await open(mode==='flow'?1200:390,'no-preference',true);
    await page.locator('#mode-'+mode).click();
    if (mode==='interior') await page.locator('#interior-flow').click();
    if (mode==='conduction') await page.getByRole('button',{name:'心房への広がり',exact:true}).click();
    if (speed==='real') await page.locator('#beat-speed').click();
    if(mode==='flow') await page.evaluate(w => inspection.focus('all',w),view);
    const states = [], start = Date.now(), folder = 'play-'+mode+'-'+view+'-'+speed;
    const initial = await page.evaluate(() => inspection.state());
    if(initial.beating || initial.beatTime!==0) throw new Error('unexpected autoplay');
    await page.locator('#beat-play').click();
    do {
      states.push({wallMs:Date.now()-start,...await page.evaluate(() => inspection.state())});
      await page.waitForTimeout(100);
    } while (states.at(-1).beatTime < 1600 && Date.now()-start < 25000);
    if(states.at(-1).beatTime<1600) throw new Error('two cycles not reached');
    await page.locator('#beat-play').click();
    const stopped = await page.evaluate(() => inspection.state());
    await page.waitForTimeout(300);
    if((await page.evaluate(() => inspection.state())).beatTime!==stopped.beatTime) throw new Error('time advanced while stopped');
    let rotated=false;
    if(mode==='conduction') {
      await page.getByRole('button',{name:'洞房結節',exact:true}).click();
      await page.waitForTimeout(600);
    }
    if(mode==='flow' && view==='front' && speed==='slow') {
      await page.locator('#rotate').click(); await page.waitForTimeout(3000); await page.locator('#rotate').click(); rotated=true;
    }
    report.playback.push({mode,view,speed,initial,stopped,rotated,states});
    const video = page.video();
    await context.close();
    await rename(await video.path(),resolve(out,folder+'.webm'));
    console.log('playback',mode,speed,states.length);
  }
 }
}
// Reduce motion must finish in both flow representations, with no continued motion after the single beat.
for (const mode of ['flow','interior']) {
  const {context,page} = await open(390,'reduce');
  await page.locator('#mode-'+mode).click();
  if (mode==='interior') await page.locator('#interior-flow').click();
  await page.locator('#beat-speed').click();
  await page.locator('#beat-play').click();
  await page.waitForFunction(() => !inspection.state().beating);
  const state = await page.evaluate(() => inspection.state());
  if(state.beatTime!==0) throw new Error('single beat failed to return to rest');
  await shot(page,'reduced-'+mode+'.png');
  report.playback.push({mode,reducedMotion:true,state});
  await context.close();
}
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
await browser.close();
console.log('saved',out);
