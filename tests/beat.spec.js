// The beat and the heart sounds.
// Split out of the former tests/viewer.spec.js (Issue #50 F5); shared helpers are in tests/helpers.js.
const {test,expect}=require('@playwright/test');
const { url, modelPixels, stableShot, countColor, fakeAudio } = require('./helpers.js');

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
  // Stop while the ventricles contract (0.5-1.85 s of the 4 s slow beat), so that the shape differs from rest. Until 2026-11-14 the stop
  // fell about 3 s in, when the ventricles had relaxed again (rest shape), and the two pictures differed only because the phase box lay
  // on the canvas; with the box off the model on a phone (Issue #50 B2/C1) they were equal. The box is hidden for the comparison, so it
  // is the shape that is compared.
  // The stop is clicked from inside the page, 300 ms after the phase name changes to the ventricular contraction: a click sent from the
  // test arrived too late under load (2 of 4 runs with two workers stopped in the relaxation). It waits to see another phase first, so
  // that a check that starts late in a contraction waits for the next one (review of PR #51).
  await page.evaluate(() => new Promise(done => {
    let other = false;
    const timer = setInterval(() => {
      const contracting = document.getElementById('beat-phase-name').textContent.startsWith('心室の収縮');
      if (!contracting) { other = true; return; }
      if (!other) return;
      clearInterval(timer);
      setTimeout(() => { document.getElementById('beat-play').click(); done(); }, 300);
    }, 20);
  }));
  await expect(page.locator('#beat-play')).toHaveText('拍動を再生');
  await expect(page.locator('#beat-phase')).toBeVisible();
  await expect(page.locator('#beat-phase-name')).toHaveText(/^心室の収縮/);
  const box = await page.addStyleTag({ content: '#beat-phase{visibility:hidden}' });
  const stopped = await stableShot(c);
  await box.evaluate(e => e.remove());
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
  // The beat is stopped on a fake clock (Issue #50 B1: with the real clock, the stop landed later than 1.5 s on a slow machine, where the
  // ventricles were relaxing again, and the cut face was too large in 3 of 3 runs). The thresholds are unchanged.
  await page.clock.install({ time: 0 });
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
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await page.evaluate(() => document.getElementById('beat-play').click());
  // 1.5 s of the slow beat is 300 ms of the real cycle: the ventricles are about three quarters contracted.
  await page.clock.runFor(1500);
  await page.evaluate(() => document.getElementById('beat-play').click()); // the stop draws the beat exactly where the clock is
  await page.clock.resume();
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

test('the heart sound is off at first, books the two sounds on the beat clock and stops with the beat', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  // The moment the page starts the beat, taken in the page just before its own handler runs.
  await page.evaluate(() => document.getElementById('beat-play').addEventListener('click', () => { window.beatStartedAt = performance.now(); }, true));
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sound-note')).toContainText('説明用の合成心音');
  expect(await page.evaluate(() => window.contexts), 'no audio context before the tap').toBe(0);
  await page.locator('#beat-play').click();
  await page.waitForTimeout(600);
  await page.locator('#heart-sound').click();
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.contexts)).toBe(1);
  // Turning the sound on does not send the beat back to its start: every sound sits on the grid of the beat that began at the
  // press of "拍動を再生" (slow speed: first sound 0.5 s, second sound 1.85 s into each 4 s beat), not on a grid that begins at
  // the tap. The sounds are checked as booked, so how late the tap came does not matter. None may be missing between the first
  // and the last one heard.
  await expect.poll(async () => (await page.evaluate(() => window.audible())).length, { timeout: 40000 }).toBeGreaterThanOrEqual(5);
  const grid = await page.evaluate(() => ({ start: (window.beatStartedAt - window.audioBorn) / 1000, voices: window.audible() }));
  let previous = null;
  for (const v of grid.voices) {
    const t = v.at - grid.start, beat = Math.floor(t / 4), within = t - 4 * beat;
    expect(Math.abs(within - (v.hz === 130 ? 1.85 : .5)), `sound at ${t.toFixed(3)} s`).toBeLessThan(.03);
    const slot = 2 * beat + (v.hz === 130 ? 1 : 0);
    if (previous !== null) expect(slot - previous, 'a sound is missing or doubled').toBe(1);
    previous = slot;
  }
  // Switching the speed books the real-speed intervals from the current position, with no double sound.
  const count = (await page.evaluate(() => window.audible())).length;
  await page.locator('#beat-speed').click();
  await page.waitForTimeout(2500);
  const faster = (await page.evaluate(() => window.audible())).slice(count);
  expect(faster.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < faster.length; i++) expect(faster[i].at - faster[i - 1].at).toBeGreaterThan(.26);
  // Stopping the beat books no more sounds.
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を再生');
  const stopped = await page.evaluate(() => window.audible().length);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.audible().length)).toBe(stopped);
  // Starting again, turning the sound off keeps the beat running and books nothing; on again books from the current position.
  await page.locator('#beat-play').click();
  await page.locator('#heart-sound').click();
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'false');
  const off = await page.evaluate(() => window.audible().length);
  const phase = await page.locator('#beat-phase-name').textContent();
  const seen = new Set([phase]);
  for (let i = 0; i < 12; i++) { seen.add(await page.locator('#beat-phase-name').textContent()); await page.waitForTimeout(200); }
  expect(seen.size, 'the beat goes on without the sound').toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.audible().length)).toBe(off);
  expect(await page.evaluate(() => window.contexts), 'the context is reused').toBe(1);
  // A hidden page stops the beat and the sounds together.
  await page.locator('#heart-sound').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = await page.evaluate(() => window.audible().length);
  const hiddenPhase = await page.locator('#beat-phase-name').textContent();
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.audible().length)).toBe(hidden);
  expect(await page.locator('#beat-phase-name').textContent()).toBe(hiddenPhase);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(6000);
  expect(await page.evaluate(() => window.audible().length)).toBeGreaterThan(hidden);
  // An interrupted audio context turns the sound off, says so, and the beat goes on.
  await page.evaluate(() => window.lastContext.interrupt());
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sound-status')).toContainText('中断');
  expect(errors).toEqual([]);
  await context.close();
});

// Review of PR #44: stopping wound the clock back to the last drawn frame, so a sound that had started after that frame was booked
// again on restart. Frames take 100 ms or more here, so stops often come between a sound and the next frame. At the real speed
// (first sound to second sound 270 ms) two sounds never come closer than 0.27 s; a doubled sound would.
test('stopping and starting the beat many times never sounds a heart sound twice', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  // The cut view draws slowly in this environment (about 150 ms a frame), so the last frame is often far behind the clock.
  await page.locator('#mode-interior').click();
  await page.locator('#beat-speed').click();
  await page.locator('#heart-sound').click();
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < 40; i++) {
    await page.locator('#beat-play').click();
    await page.waitForTimeout(60 + (i * 37) % 260);
    await page.locator('#beat-play').click();
    await page.waitForTimeout(15 + (i * 53) % 90);
  }
  // A sound booked twice shows as two sounds of the same kind less than one beat (800 ms at the real speed) apart: the beat only
  // moves forward, so sounds of one kind are at least a beat apart however often it is stopped. (The gap between neighbours
  // alone cannot show it: a stop and a start take 100 ms or more here.) A sound that is missing, which a page stalling for
  // seconds can cause, is not a double: it shows as two of one kind a beat or more apart, and is only counted in the log.
  const heard = (await page.evaluate(() => window.audible().map(v => ({ at: v.at, hz: v.hz })))).sort((a, b) => a.at - b.at);
  expect(heard.length).toBeGreaterThan(10);
  let apart = 0;
  for (const hz of [90, 130]) {
    const kind = heard.filter(v => v.hz === hz);
    for (let i = 1; i < kind.length; i++) expect(kind[i].at - kind[i - 1].at, `sounds of ${hz} Hz at ${kind[i - 1].at} and ${kind[i].at}`).toBeGreaterThan(.75);
  }
  for (let i = 1; i < heard.length; i++) {
    expect(heard[i].at - heard[i - 1].at).toBeGreaterThan(.26);
    if (heard[i].hz === heard[i - 1].hz) apart++;
  }
  console.log(`heart sounds heard: ${heard.length}; places where a sound of the other kind is missing between two: ${apart}`);
  expect(errors).toEqual([]);
  await context.close();
});

// Review of PR #44, in a fixed order: the time is the page's fake clock, stopped with pauseAt() once the page has loaded (install()
// alone lets real time run between two commands) and moved only by runFor(), so every run is the same. At the real speed the sounds are
// at 100 and 370 ms of each 800 ms beat. The beat is stopped 5 ms after each of the first four sounds started, which is after the
// last frame drawn before the stop in most cases (frames are 16 ms apart). A clock wound back to the last frame booked such a
// sound again on restart. The sounds heard must be exactly those the beat has passed, once each.
for (const how of ['stop button', 'hidden page']) test(`a sound that started just before the beat was stopped is not booked again (${how})`, async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.clock.install({ time: 0 });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.clock.pauseAt(60000);
  const click = id => page.evaluate(i => document.getElementById(i).click(), id);
  const now = () => page.evaluate(() => performance.now());
  const hide = hidden => page.evaluate(h => { Object.defineProperty(document, 'hidden', { value: h, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  await click('beat-speed');
  await click('heart-sound');
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'true');
  // `running` is the time the beat has run, from the page's own clock, not from what this test intends: every stop must fall at
  // the planned beat time, so that the 5 ms after each sound is real.
  let running = 0, since = await now();
  await click('beat-play');
  // Beat time of each stop: 5 ms after the sounds at 100, 370, 900 and 1170 ms.
  for (const stopAt of [105, 375, 905, 1175]) {
    await page.clock.runFor(stopAt - running);
    const stoppedAt = await now();
    running += stoppedAt - since;
    expect(running, 'the stop falls at the planned beat time').toBe(stopAt);
    if (how === 'stop button') await click('beat-play'); else await hide(true);
    await page.clock.runFor(10);
    since = await now();
    if (how === 'stop button') await click('beat-play'); else await hide(false);
  }
  await page.clock.runFor(125);
  expect(await now(), 'time moved only by runFor').toBe(60000 + 105 + 270 + 530 + 270 + 4 * 10 + 125);
  // The beat has run 1300 ms: the sounds at 100, 370, 900 and 1170 ms, once each (the next one, at 1700 ms, is booked ahead
  // but not heard).
  const heard = await page.evaluate(() => window.audible().filter(v => v.at <= window.lastContext.currentTime).map(v => v.hz));
  expect(heard).toEqual([90, 130, 90, 130]);
  expect(errors).toEqual([]);
});

// Review of PR #44: after the WebGL context was lost, the sounds went on being booked and could not be stopped from the page.
test('when the 3D view is lost the beat and the heart sounds stop', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-speed').click();
  await page.locator('#beat-play').click();
  await page.locator('#heart-sound').click();
  await expect.poll(() => page.evaluate(() => window.audible().length), { timeout: 10000 }).toBeGreaterThan(2);
  await page.locator('canvas').evaluate(c => c.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await expect(page.locator('#error')).toContainText('再読み込み');
  // The beat has stopped too, not only the sounds (Issue #50 recheck, F2: a page that kept beating=true passed this test).
  await expect(page.locator('#beat-play')).toHaveText('拍動を再生');
  const after = await page.evaluate(() => window.audible().length);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.audible().length), 'no sound is booked after the loss').toBe(after);
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'false');
  // Coming back to the page does not restart the sounds either.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.audible().length)).toBe(after);
  expect(errors).toEqual([]);
  await context.close();
});

// With "reduce motion" the beat plays once per press; its sounds stop with it.
test('with reduced motion one press books one first sound and one second sound, and none after the beat has ended', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#heart-sound').click();
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生', { timeout: 15000 });
  await page.waitForTimeout(1500);
  expect((await page.evaluate(() => window.audible())).map(v => v.hz)).toEqual([90, 130]);
  // Pressing again plays one more beat from its start.
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生', { timeout: 15000 });
  await page.waitForTimeout(1500);
  expect((await page.evaluate(() => window.audible())).map(v => v.hz)).toEqual([90, 130, 90, 130]);
  expect(errors).toEqual([]);
  await context.close();
});

test('the heart sound cannot start where the page has no audio, and the page still works', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { delete window.AudioContext; delete window.webkitAudioContext; });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#heart-sound')).toBeHidden();
  // The note says why there is no sound button (Issue #50 B4: it said only what the button does).
  await expect(page.locator('#sound-note')).toContainText('対応していないため');
  await page.locator('#beat-play').click();
  await expect(page.locator('#beat-play')).toHaveText('拍動を止める');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test('the heart sound controls fit a phone screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ['#heart-sound', '#heart-volume']) {
    const box = await page.locator(id).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, `${id} inside the screen`).toBe(true);
  }
  await context.close();
});

// Issue #50 B4/E8: the audio context was still starting (resume pending) when the 3D view was lost. The controls were disabled and the
// beat stopped, but the sound button turned itself on afterwards. It must stay off, with nothing booked.
test('a heart sound that finishes starting after the 3D view is lost stays off', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.addInitScript(() => {
    const original = window.AudioContext.prototype.resume;
    window.AudioContext.prototype.resume = function () { return new Promise(done => { window.finishResume = () => { original.call(this); done(); }; }); };
  });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.locator('#beat-play').click();
  await page.locator('#heart-sound').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishResume)).toBe('function');
  await page.locator('canvas').evaluate(c => c.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await expect(page.locator('#heart-sound')).toBeDisabled();
  await page.evaluate(() => window.finishResume());
  await page.waitForTimeout(500);
  await expect(page.locator('#heart-sound')).toHaveAttribute('aria-pressed', 'false');
  // The audio context is not left running with no control to stop it (review of PR #51).
  expect(await page.evaluate(() => window.lastContext.state)).toBe('suspended');
  await expect(page.locator('#sound-status')).toBeHidden();
  expect(await page.evaluate(() => window.voices.length)).toBe(0);
  expect(errors).toEqual([]);
});

// Issue #50 recheck (B3): after the beat had played on normally, turning on "reduce motion" and pressing "拍動を1回再生" ended the play at
// once: the beat clock counts on across beats, and the one-beat play (and the booking of its sounds) stopped at the end of the first beat
// (800 ms), already behind it. It now plays to the end of the beat it is in, with the sounds still ahead in that beat. The play starts at
// 1000 ms (200 ms into the beat), where the second sound (370 ms) is still ahead: the sound limit put back to 800 ms books nothing there
// (review of PR #52: a start at 1250 ms, after both sounds, did not show it).
test('with reduced motion turned on after the beat has played, one press still plays a beat with its sounds', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.clock.install({ time: 0 });
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.clock.pauseAt(60000);
  const click = id => page.evaluate(i => document.getElementById(i).click(), id);
  await click('beat-speed');
  await click('beat-play');
  await page.clock.runFor(1000); // past the first beat at the real speed: the beat time is 1000 ms, 200 ms into its beat
  await click('beat-play');
  await click('heart-sound');
  await page.clock.runFor(50);
  // The press reads the setting itself (matchMedia().matches). The label follows the media change event, which Chromium's emulation did
  // not always deliver (5 of 12 runs here; a second listener of our own also missed it 2 times in 8), so the setting is waited for, not
  // the label.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const heard = from => page.evaluate(n => window.audible().slice(n).map(v => v.hz).sort((a, b) => a - b), from);
  const start = await page.evaluate(() => window.audible().length);
  await click('beat-play');
  await page.clock.runFor(200);
  await expect(page.locator('#beat-play'), 'still playing 0.2 s after the press').toHaveText('拍動を止める');
  await page.clock.runFor(1000);
  await expect(page.locator('#beat-play'), 'stopped at the end of the beat').toHaveText('拍動を1回再生');
  // The rest of that beat (200 to 800 ms) holds the second sound only.
  expect(await heard(start), 'sounds of the first press').toEqual([130]);
  // The next press plays a whole beat, with one first and one second sound.
  const next = await page.evaluate(() => window.audible().length);
  await click('beat-play');
  await page.clock.runFor(1200);
  await expect(page.locator('#beat-play')).toHaveText('拍動を1回再生');
  expect(await heard(next), 'sounds of the second press').toEqual([90, 130]);
  expect(errors).toEqual([]);
  await context.close();
});
