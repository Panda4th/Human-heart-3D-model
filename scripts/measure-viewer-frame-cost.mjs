// Measure the viewer's live playback in a temporary, instrumented build.
// From the repository root: node scripts/measure-viewer-frame-cost.mjs > /tmp/viewer-frame-cost.json
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { buildStandalone } from './build-standalone.mjs';

const viewport = { width: 1280, height: 800 };
const runs = 3;
const warmupFrames = 24;
const measuredFrames = 96;
const scenarios = [
  { id: 'interior-av', label: '房室結節', rays: 0, flow: false },
  { id: 'interior-sa', label: '洞房結節', rays: 1, flow: false },
  { id: 'interior-atria', label: '心房への広がり', rays: 1, flow: false },
  { id: 'interior-av-flow', label: '房室結節', rays: 0, flow: true },
  { id: 'interior-atria-flow', label: '心房への広がり', rays: 1, flow: true },
  { id: 'flow', flow: true, rays: 0 },
];

function replaceOnce(source, marker, replacement) {
  assert.equal(source.split(marker).length, 2, `expected one source marker: ${marker}`);
  return source.replace(marker, () => replacement);
}

function instrument(source) {
  source = replaceOnce(source, '  function render(time) {', `
  let frameCapture = null, frameSample = null;
  window.frameCost = {
    capture(warmup, count) {
      let resolve;
      const result = new Promise(done => { resolve = done; });
      frameCapture = { warmup, count, resolve, previous: null, samples: [] };
      return result;
    },
    rendererInfo() {
      const gl = renderer.getContext();
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      };
    },
  };
  function render(time) {
    const frameStart = performance.now();
    if (frameCapture) frameSample = {};
  `);
  const timed = (statement, field) => replaceOnce(source, statement, `{
    const start = frameSample ? performance.now() : 0;
    ${statement}
    if (frameSample) frameSample.${field} = performance.now() - start;
  }`);
  source = timed('flow.advance(beatTime, next);', 'flowAdvanceMs');
  source = timed('beat.set(contraction(beatTime));', 'beatSetMs');
  source = timed('drawFlow();', 'drawFlowMs');
  source = timed('renderer.render(scene, camera);', 'rendererRenderMs');
  source = timed('updateLabels();', 'updateLabelsMs');
  source = replaceOnce(source, '    const hit = pickHit(ray, occluders, [cutPlane], crossSection.solids);', `
    const start = frameSample ? performance.now() : 0;
    const hit = pickHit(ray, occluders, [cutPlane], crossSection.solids);
    if (frameSample) {
      frameSample.labelRayMs = performance.now() - start;
      frameSample.rays = (frameSample.rays ?? 0) + 1;
    }
  `);
  return replaceOnce(source, '    if (controls.autoRotate || beating) requestRender();', `
    if (controls.autoRotate || beating) requestRender();
    if (frameCapture) {
      const sample = frameSample;
      sample.renderMs = performance.now() - frameStart;
      sample.rafIntervalMs = frameCapture.previous === null ? null : time - frameCapture.previous;
      sample.phase = shownPhase;
      frameCapture.previous = time;
      if (frameCapture.warmup > 0) {
        frameCapture.warmup--;
      } else {
        frameCapture.samples.push(sample);
        if (frameCapture.samples.length === frameCapture.count) {
          frameCapture.resolve(frameCapture.samples);
          frameCapture = null;
        }
      }
      frameSample = null;
    }
  `);
}

function summarize(samples, field) {
  const times = samples.map(sample => sample[field]).filter(value => value != null).sort((a, b) => a - b);
  if (!times.length) return null;
  const at = p => +times[Math.ceil(p * times.length) - 1].toFixed(3);
  return { n: times.length, median: at(.5), p95: at(.95), max: at(1) };
}

async function measureScenario(browser, url, scenario) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference', offline: true });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.locator('html[data-ready="true"]').waitFor({ timeout: 15000 });
    await page.locator(scenario.label ? '#mode-interior' : '#mode-flow').click();
    if (scenario.label) {
      await page.locator('#cut-depth').fill('0');
      await page.locator('#interior-conduction').click();
      if (scenario.flow) await page.locator('#interior-flow').click();
      const part = page.getByRole('button', { name: scenario.label, exact: true });
      await part.click();
      assert.equal(await part.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#cut-depth').inputValue(), '0');
    }
    const renderer = await page.evaluate(() => window.frameCost.rendererInfo());
    assert.match(renderer.renderer ?? '', /SwiftShader/i, 'expected the software WebGL renderer');
    await page.locator('#beat-speed').click();
    assert.equal(await page.locator('#beat-speed').getAttribute('aria-pressed'), 'true');
    await page.locator('#beat-play').click();
    assert.equal(await page.locator('#beat-play').textContent(), '拍動を止める');
    const samples = await page.evaluate(({ warmupFrames, measuredFrames }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('live playback measurement timed out')), 25000);
        window.frameCost.capture(warmupFrames, measuredFrames).then(result => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    }, { warmupFrames, measuredFrames });
    await page.locator('#beat-play').click();
    assert.deepEqual(errors, []);
    assert.equal(samples.length, measuredFrames);
    for (const sample of samples) {
      assert.equal(sample.rays ?? 0, scenario.rays, scenario.id);
      assert.equal(sample.drawFlowMs != null, scenario.flow, scenario.id);
      assert.ok(sample.beatSetMs >= 0 && sample.rafIntervalMs > 0, scenario.id);
    }
    const phases = [...new Set(samples.map(sample => sample.phase))].sort();
    assert.ok(phases.length > 1, `${scenario.id}: measured frames did not span multiple phases`);
    const fields = ['renderMs', 'rafIntervalMs', 'rendererRenderMs', 'updateLabelsMs', 'labelRayMs',
      'flowAdvanceMs', 'beatSetMs', 'drawFlowMs'];
    return { id: scenario.id, ...renderer, phases, raysPerFrame: scenario.rays,
      ms: Object.fromEntries(fields.map(field => [field, summarize(samples, field)])) };
  } finally {
    await context.close();
  }
}

async function measureViewer() {
  const production = await buildStandalone();
  assert.equal(production, await readFile('index.html', 'utf8'), 'build differs from index.html');
  assert.equal(await buildStandalone({ transformSource: source => source }), production, 'identity transform changes build');
  const html = await buildStandalone({ transformSource: instrument });
  const directory = await mkdtemp(join(process.cwd(), '.viewer-frame-cost-'));
  try {
    const file = join(directory, 'viewer.html');
    await writeFile(file, html);
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    try {
      const report = {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        indexHtmlSha256: createHash('sha256').update(production).digest('hex'),
        environment: { node: process.version, chromium: browser.version(), cpu: cpus()[0]?.model, kernel: release() },
        viewport, warmupFrames, measuredFrames, runs: [],
      };
      for (let run = 0; run < runs; run++) {
        const results = [];
        // Rotate the order so the same condition does not always run first.
        const offset = run * 2;
        for (const scenario of [...scenarios.slice(offset), ...scenarios.slice(0, offset)]) {
          results.push(await measureScenario(browser, pathToFileURL(file).href, scenario));
        }
        report.runs.push(results);
      }
      return report;
    } finally {
      await browser.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await measureViewer(), null, 2));
}
