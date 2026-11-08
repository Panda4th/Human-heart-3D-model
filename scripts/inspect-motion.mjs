// Reproducible visual inspection. Builds a temporary instrumented page; index.html is untouched.
// Run from the repository root: node scripts/inspect-motion.mjs <output-directory>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildStandalone } from './build-standalone.mjs';
import { period, contraction } from '../src/heartbeat.mjs';
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
  let progress = null;
  const advanceForInspection = flow.advance;
  flow.advance = (from, to) => {
    if(progress) progress.push({from,to});
    return advanceForInspection(from,to);
  };
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
    beginProgress: () => { progress=[]; },
    progress: () => progress,
  };
`;
const readyMarker = "  document.documentElement.dataset.ready = 'true';";
function inject(source) {
  assert.equal(source.split(readyMarker).length-1,1,'inspection ready marker must match exactly once');
  return source.replace(readyMarker,hook+readyMarker);
}
assert.throws(() => inject('marker removed'), /must match exactly once/);
const production = await buildStandalone();
assert.equal(production,await readFile('index.html','utf8'),'uninstrumented shared build differs from distributable');
assert.equal(await buildStandalone({transformSource:s=>s}),production,'identity transform changes distributable');
const html = await buildStandalone({transformSource:inject});
const pagePath = resolve(out, 'inspection.html');
await writeFile(pagePath, html);
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}), args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { viewport: {width:1200,height:900}, renderer:'Chromium / SwiftShader',
  indexHtmlSha256:createHash('sha256').update(production).digest('hex'), buildEquivalence:true,
  pixelMetric:'Per-pixel max absolute RGB channel difference, 0..255; alpha ignored. Percentiles use nearest rank. Nonzero statistics exclude equal pixels; no pass/fail threshold.',
  errors:[], snapshots:[], interiorSnapshots:[], comparisons:[], playback:[], negativeControls:[] };
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
  return page.locator('canvas').screenshot({path:resolve(out,filename)});
}
async function pixelMetrics(page,a,b) {
  return page.evaluate(async ([first,second]) => {
    const decode=async s=>{const i=new Image();i.src='data:image/png;base64,'+s;await i.decode();return i;};
    const [a,b]=await Promise.all([decode(first),decode(second)]);
    if(a.width!==b.width||a.height!==b.height)throw new Error('comparison dimensions differ');
    const c=document.createElement('canvas');c.width=a.width;c.height=a.height;
    const g=c.getContext('2d');g.drawImage(a,0,0);const x=g.getImageData(0,0,c.width,c.height).data;
    g.clearRect(0,0,c.width,c.height);g.drawImage(b,0,0);const y=g.getImageData(0,0,c.width,c.height).data;
    const hist=Array(256).fill(0);let sum=0;
    for(let i=0;i<x.length;i+=4){const d=Math.max(Math.abs(x[i]-y[i]),Math.abs(x[i+1]-y[i+1]),Math.abs(x[i+2]-y[i+2]));hist[d]++;sum+=d;}
    const stats=(start,n)=>{const q=p=>{const rank=Math.max(1,Math.ceil(p*n));let count=0;for(let i=start;i<256;i++){count+=hist[i];if(count>=rank)return i;}return 0;};return {pixels:n,median:n?q(.5):0,p99:n?q(.99):0,max:n?q(1):0};};
    const count=c.width*c.height,changed=count-hist[0];
    return {...stats(0,count),width:c.width,height:c.height,mean:sum/count,changedPixels:changed,changedFraction:changed/count,nonzero:stats(1,changed)};
  },[a.toString('base64'),b.toString('base64')]);
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
  for(const time of [30,260,470,600]) {
    await page.evaluate(t => inspection.at(t),time);
    for (const valve of ['tricuspid','mitral','aortic','pulmonary']) {
      await page.evaluate(v => inspection.focus(v,'front'),valve);
      const filename='interior-'+valve+'-'+depth+'-'+time+'.png';
      await shot(page,filename); report.interiorSnapshots.push({filename,valve,depth:Number(depth),time});
    }
  }
  await context.close();
}
// Compare the existing normal field/dash distances with recomputation at matched phases and views.
if (!playbackOnly) for (const mode of ['exterior','interior','conduction']) {
  const {context,page} = await open();
  await page.locator('#mode-'+mode).click();
  if (mode==='conduction') await page.getByRole('button',{name:'心房への広がり',exact:true}).click();
  for (const time of [50,260,370]) {
    await page.evaluate(t => inspection.at(t),time);
    for (const view of ['front','back','left']) {
      await page.locator('#view-'+view).click();
      await page.locator('#in').click();
      await page.locator('#in').click();
      await page.evaluate(() => inspection.compare(false,false));
      const prefix = 'compare-'+mode+'-'+view+'-'+time;
      const rest=await shot(page,prefix+'-rest.png');
      const cost = await page.evaluate(() => inspection.compare(true,false));
      const normal=await shot(page,prefix+'-normals.png');
      const normals=await pixelMetrics(page,rest,normal);
      let dashes=null;
      if(mode==='conduction') {
        await page.evaluate(() => inspection.compare(false,true));
        const dash=await shot(page,prefix+'-dashes.png');
        dashes=await pixelMetrics(page,rest,dash);
      }
      report.comparisons.push({mode,view,time,prefix,contraction:contraction(time),...cost,normals,dashes});
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
    } while (states.at(-1).beatTime < 1600 && Date.now()-start < 90000);
    // Software rendering plus recording is slow on Actions. Allow more wall time, while retaining
    // the same two-cycle criterion (1600 ms on the model clock); this does not test playback speed.
    const completed = states.at(-1).beatTime >= 1600;
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
    report.playback.push({mode,view,speed,initial,stopped,rotated,completed,states});
    const video = page.video();
    await context.close();
    await rename(await video.path(),resolve(out,folder+'.webm'));
    await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
    if(!completed) throw new Error('two cycles not reached; states and video saved in '+folder);
    console.log('playback',mode,speed,states.length);
  }
 }
}
// Observe the actual advance calls, including the terminal 800 ms step before the UI clock resets.
// A no-op button must fail rather than passing immediately in the initial resting state.
async function reducedBeat(mode,speed,disablePlay=false) {
  const {context,page} = await open(390,'reduce');
  try {
    await page.locator('#mode-'+mode).click();
    if(mode==='interior') await page.locator('#interior-flow').click();
    if(speed==='real') await page.locator('#beat-speed').click();
    if(disablePlay) await page.evaluate(()=>{document.getElementById('beat-play').onclick=()=>{};});
    const started=await page.evaluate(()=>{
      inspection.beginProgress();
      document.getElementById('beat-play').click();
      return inspection.state();
    });
    assert.equal(started.beating,true,'reduced-motion play did not start');
    const samples=[],start=Date.now();
    do {
      samples.push({wallMs:Date.now()-start,...await page.evaluate(()=>inspection.state())});
      if(!samples.at(-1).beating)break;
      await page.waitForTimeout(50);
    } while(Date.now()-start<90000);
    const state=await page.evaluate(()=>inspection.state());
    const trace=await page.evaluate(()=>inspection.progress());
    assert.ok(trace.length>0,'no reduced-motion progress');
    assert.equal(trace[0].from,0,'one beat must start at zero');
    for(let i=0;i<trace.length;i++){
      // The first render after pressing play intentionally has delta=0 (previousTime is reset).
      assert.ok(trace[i].to>=trace[i].from,'one-beat clock moved backwards');
      assert.ok(trace[i].to<=period,'one-beat clock advanced beyond the period');
      if(i)assert.equal(trace[i].from,trace[i-1].to,'one-beat progress is discontinuous');
    }
    const maxAdvance=Math.max(...trace.map(t=>t.to));
    assert.ok(trace.some(t=>t.to>t.from),'one-beat clock never advanced');
    assert.equal(maxAdvance,period,'one beat did not reach the period');
    assert.equal(state.beating,false,'single beat did not stop');
    assert.equal(state.beatTime,0,'single beat did not return to rest');
    await page.waitForTimeout(300);
    const after=await page.evaluate(()=>({state:inspection.state(),trace:inspection.progress()}));
    assert.deepEqual(after.state,state,'state changed after single beat');
    assert.equal(after.trace.length,trace.length,'flow advanced after single beat');
    await shot(page,'reduced-'+mode+'-'+speed+'.png');
    return {mode,speed,reducedMotion:true,started,samples,trace,maxAdvance,expectedPeriod:period,state,after:after.state};
  } finally { await context.close(); }
}
await assert.rejects(()=>reducedBeat('flow','real',true),/play did not start/);
report.negativeControls.push({case:'no-op reduced-motion play handler',rejected:true});
for(const mode of ['flow','interior']) for(const speed of ['slow','real']) {
  report.playback.push(await reducedBeat(mode,speed));
  await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
}
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
await browser.close();
assert.deepEqual(report.errors,[],'inspection page errors');
console.log('saved',out);
