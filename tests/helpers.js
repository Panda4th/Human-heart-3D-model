// Shared by the browser tests (tests/*.spec.js, Chromium). Split out of the former tests/viewer.spec.js (Issue #50 F5).
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const url = pathToFileURL(path.resolve('index.html')).href;
// Decode a PNG screenshot in the page and run `rule` on its RGBA bytes there: rule(data, ...args). A function cannot be sent to the
// page, so its source is sent: it must not use anything from outside itself. The pixel counters below share this.
const inPagePixels = (page, png, rule, ...args) => page.evaluate(async ([b64, source, args]) => {
  const image = new Image(); image.src = 'data:image/png;base64,' + b64; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return (0, eval)(`(${source})`)(data, ...args);
}, [png.toString('base64'), rule.toString(), args]);
// Number of pixels that belong to the model: the background is blue-grey and dark, the heart is clearly redder or brighter.
// 90 and 25 date from 9633c4a with no reason recorded; the reason below was worked out afterwards from the current page (Issue #50 F3).
// The canvas is transparent and the background behind it is the CSS of the stage: at most #293d44 (brightest channel 68, red minus
// blue -27), and #17242b in a PC window (43, -20). A pixel brighter than 90 or with red above blue by more than 25 is not plain background.
const modelPixels = (page, png) => inPagePixels(page, png, data => {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 90 || data[i] - data[i + 2] > 25) count++;
  return count;
});
// Rendering happens in the next animation frame after a state change, so a screenshot taken right away can
// still show the previous frame. Wait for the frame to be drawn before comparing pictures.
const settle = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
// Under load the screenshot can still show the previous frame for a while after the frame was drawn (seen in CI on
// main 91d3d5d, and locally with all CPUs busy: 5 of 10 runs). Take pictures until two in a row are the same. A picture
// that keeps changing, as while the model rotates, never settles and fails the test.
// Pictures are compared byte for byte, with no tolerance (Issue #50 F3): with software rendering (SwiftShader, as set in
// playwright.config.js) the same state draws the same pixels in the same browser. On a real GPU or with another browser build that need
// not hold; the tests are run only with SwiftShader.
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
// Number of pixels whose colour is within `tolerance` (per channel) of the given colour.
const countColor = (page, png, [r, g, b], tolerance) => inPagePixels(page, png, (data, r, g, b, tolerance) => {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - r) <= tolerance && Math.abs(data[i + 1] - g) <= tolerance && Math.abs(data[i + 2] - b) <= tolerance) count++;
  return count;
}, r, g, b, tolerance);
// The synthetic heart sound (Issue #31). Headless Chromium cannot be listened to, so the page gets an AudioContext that keeps
// what is booked: its clock is the real clock, and each oscillator's start time and pitch (90 Hz first sound, 130 Hz second
// sound) are recorded. This checks the booking against the beat, not what a speaker plays.
const fakeAudio = () => {
  window.voices = []; window.cancels = []; window.contexts = 0; let order = 0;
  const born = performance.now();
  window.audioBorn = born;
  // What a listener would hear: a sound booked before a cancel that lies before its start is silenced by that cancel (`order` is the
  // sequence of bookings and cancels, which a clock reading cannot give: they can fall in the same millisecond).
  window.audible = () => window.voices.filter(v => !window.cancels.some(c => c.order > v.order && v.at > c.t));
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues: t => window.cancels.push({ t, order: order++ }) });
  window.AudioContext = class {
    constructor() { this.state = 'suspended'; this.destination = {}; this.baseLatency = 0; this.outputLatency = 0; window.contexts++; this.listeners = []; window.lastContext = this; }
    get currentTime() { return (performance.now() - born) / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    addEventListener(type, fn) { this.listeners.push(fn); }
    interrupt() { this.state = 'interrupted'; this.listeners.forEach(fn => fn()); }
    createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
    createOscillator() {
      const oscillator = { frequency: param(), connect() {}, start(t) { window.voices.push({ hz: oscillator.frequency.first, at: t, order: order++ }); }, stop() {} };
      const set = oscillator.frequency.setValueAtTime;
      oscillator.frequency.setValueAtTime = v => { oscillator.frequency.first = v; set(); };
      return oscillator;
    }
  };
};
// The blood-flow view draws particles (blue on the right-heart routes, red on the left-heart routes) inside walls drawn at
// opacity 0.07 (plus a brighter rim). A lit particle is not a pure colour, so these rules were found by measuring (Chromium/SwiftShader,
// at rest, pixels counted at 1440 px width / 390 px width). Blue rule (blue - red > 90, blue > 140): 251 / 18 in the exterior view
// (the pulmonary arteries and veins are bluish) and 781 / 149 in the flow view. Red rule: with the brighter key light of stage A the
// old red rule (red - green > 120, red > 170, blue < 110) matched the lit aorta, 9855 / 2015 pixels in the exterior view, so it was
// tightened to red - green > 150 (red > 170, blue < 110 unchanged): the brightest wall pixel has red - green 138, so the exterior
// view still matches 0 / 0 with a margin of 12, and the flow view matches 295 / 52. The old rule gave 0 / 0 and 247 / 68 before the
// lighting change (measured on main b666d4b at the same sizes, with the old layout's canvas).
const particlePixels = (page, png) => inPagePixels(page, png, data => {
  let blue = 0, red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 2] - data[i] > 90 && data[i + 2] > 140) blue++;
    if (data[i] - data[i + 1] > 150 && data[i] > 170 && data[i + 2] < 110) red++;
  }
  return { blue, red };
});
// Stage B, the impulse and the schematic ECG on the beat clock (conduction-timing.mjs). The page's clock is the fake one: stopped with
// pauseAt() once the page has loaded and moved only by runFor(), so each stop falls at the beat time planned (real speed: 1 ms is 1 ms).
// The white head of the impulse is drawn only while the impulse is in a path that has one (the AV node has none).
const whitePixels = (page, png) => inPagePixels(page, png, data => {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) n++;
  return n;
});

module.exports = { url, inPagePixels, modelPixels, settle, stableShot, anchorOf, clickAnchor, countColor, fakeAudio, particlePixels, whitePixels };
