import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createConduction, createConductionPulse } from './conduction.mjs';
import { ecgAt, ecgBumps, glowAt, stretchText, stretchTextAt, waveAge } from './conduction-timing.mjs';
import { createAnatomy, modelScale } from './anatomy.mjs';
import { createFlow, routesThrough } from './flow.mjs';
import { contraction, createBeat, period, phaseAt, phases, stepBeat } from './heartbeat.mjs';
import { createHeartSound, createPlayback, createSoundScheduler } from './heartsound.mjs';
import anatomyData from './data/bodyparts3d-heart.bin';
import { createCrossSection, cutColor, fieldOfView, fitDistance, modelSphere, pickHit, removedByCut, selectableIn, TapGesture } from './viewer-state.mjs';

const canvas = document.querySelector('canvas');
const $ = id => document.getElementById(id);
function showError(message) {
  $('error').hidden = false;
  $('error').textContent = message;
  document.documentElement.dataset.ready = 'false';
  document.querySelectorAll('[data-viewer-control]').forEach(b => b.disabled = true);
}
// Phone layout: the model, the description and the two cut notices go to #pinned above the scrolling <main>, and back to their
// places on wider screens. Moving the canvas keeps its WebGL context. See the phone rules in template.html.
{
  const phone = matchMedia('(max-width:760px)');
  const moved = [canvas.closest('.viewport'), document.querySelector('.detail'), $('cut-notice'), $('pick-note')].map(el => {
    const home = document.createComment('');
    el.before(home);
    return [el, home];
  });
  // On a phone, CSS `order` shows the ECG strip and the step buttons right under the mode buttons and the view buttons under the
  // interior overlay buttons; the keyboard follows the DOM, so they are moved there too, or Tab went back up the page (Issue #50 C3).
  const reordered = [
    [$('ecg-panel'), () => document.querySelector('.stage-heading')],
    [$('steps'), () => $('ecg-panel')],
    [document.querySelector('nav.views'), () => $('interior-overlay')],
  ].map(([el, after]) => {
    const home = document.createComment('');
    el.before(home);
    return [el, home, after];
  });
  const place = () => {
    for (const [el, home] of moved) phone.matches ? $('pinned').append(el) : home.after(el);
    for (const [el, home, after] of reordered) phone.matches ? after().after(el) : home.after(el);
  };
  // The phase box (shown once the beat has been played) lies on the model's top left corner where the model leaves room for it. In a
  // PC window below 1000px and on an upright phone the model fills its box, and the box covered the top of the vessels in every corner
  // (Issue #50 B2/C1), so there it leaves the model: on an upright phone it goes under the model (the model keeps its size, the
  // scrolling part below gets shorter), in a PC window from 761 to 999px to the top of the side column. A phone held sideways keeps it on
  // the model, whose box is wide and low there. See the rules in template.html.
  const phaseBox = $('beat-phase'), phaseHome = document.createComment('');
  phaseBox.before(phaseHome);
  const upright = matchMedia('(max-width:760px) and (min-height:481px)'), narrow = matchMedia('(min-width:761px) and (max-width:999px)');
  // Elements are moved only when their place changes: re-attaching the model and the description loses the focus and the
  // description's scroll position (review of PR #51), so `place` runs only when the phone layout starts or ends, and the phase box
  // moves only when its own place changes. `place` moves the model, so after it the box is placed again.
  let phaseAt = null;
  const placePhase = (force = false) => {
    const at = upright.matches ? 'under' : narrow.matches ? 'aside' : 'home';
    if (at === phaseAt && !force) return;
    phaseAt = at;
    if (at === 'under') canvas.closest('.viewport').after(phaseBox);
    else if (at === 'aside') document.querySelector('aside').prepend(phaseBox);
    else phaseHome.after(phaseBox);
  };
  phone.addEventListener('change', () => { place(); placePhase(true); });
  for (const query of [upright, narrow]) query.addEventListener('change', () => placePhase());
  place();
  placePhase(true);
}
try {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fieldOfView, 1, .1, 150);
  const controls = new OrbitControls(camera, canvas);
  // On-demand rendering avoids spending battery while the model is still.
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.autoRotateSpeed = .8;
  scene.add(new THREE.HemisphereLight(0xddeaff, 0x27131b, 1));
  for (const [color, intensity, pos] of [[0xffd8bd, 200, [4, 5, 6]], [0x8caeff, 65, [-4, 2, -3]]]) {
    const light = new THREE.PointLight(color, intensity);
    light.position.set(...pos);
    scene.add(light);
  }
  // BodyParts3D meshes in millimetres; createAnatomy scales them to viewer units.
  const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
  scene.add(heart);
  heart.add(exterior);
  // Any error while reading the bundle is a data error (a cut-off file gives a RangeError, broken JSON a SyntaxError), not a missing
  // WebGL: it gets its own message (review of PR #51).
  let meta;
  try {
    meta = createAnatomy(exterior, parts, anatomyData, modelScale);
  } catch (error) {
    throw Object.assign(new Error(`heart bundle: ${error.message}`, { cause: error }), { name: 'HeartBundleError' });
  }
  // See-through walls (conduction and flow views) are nearly clear in the middle and brighter toward the silhouette, so that the chambers
  // and vessels keep their outlines. The extra term applies only to transparent materials (not OPAQUE), so the other views are unchanged.
  // The cross-section copies are cloned later and do not inherit the patch; they are never see-through.
  for (const group of parts.values()) {
    if (group.userData.kind !== 'exterior') continue;
    group.traverse(object => {
      if (!object.isMesh) return;
      object.material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `#ifndef OPAQUE
float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
outgoingLight += diffuseColor.rgb * rim * 1.1;
diffuseColor.a = min(1.0, diffuseColor.a + rim * 0.55);
#endif
#include <opaque_fragment>`);
      };
      object.material.customProgramCacheKey = () => 'see-through-rim';
    });
  }
  // Interior view: a front-to-back cut fixed to the heart. Points with z > constant are removed.
  // Read the slider so a value restored by the browser matches the drawn cut.
  const cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -Number($('cut-depth').value));
  const crossSection = createCrossSection(exterior, parts, cutPlane, cutColor);
  exterior.add(conduction);
  const labelAnchors = createConduction(conduction, parts, meta.conduction);
  // The head of the impulse (conduction-timing.mjs). Not a part: it is a helper in the heart's frame, moved by the beat's displacement.
  const pulse = createConductionPulse(meta.conduction);
  exterior.add(pulse.group);
  // Created after the cross-section and the conduction overlay so that it deforms their geometry too.
  const beat = createBeat(exterior, parts);
  // The overlay on the cross-section is cut by the same plane. Its materials keep one clipping plane in
  // every mode so that showing it never recompiles shaders; outside the interior view the plane is
  // moved far enough to keep everything. The bounds are taken before the plane can clip anything.
  const keepAll = 1e3;
  const conductionCut = new THREE.Plane(new THREE.Vector3(0, 0, -1), keepAll);
  conduction.traverse(o => { if (o.material) o.material.clippingPlanes = [conductionCut]; });
  pulse.material.clippingPlanes = [conductionCut];
  const bounds = modelSphere(heart);
  // World-space box of every part, for telling whether the current cut leaves anything of it. The beat moves the walls by a few
  // millimetres, so the box is the union over the rest shape and the most contracted atria and ventricles (every point moves
  // linearly with the two contraction amounts, so these three shapes bound every state the beat reaches): a part counts as
  // removed only when no moment of the beat leaves any of it, and "move to where it shows" goes far enough for all of them.
  const partBox = new Map([...parts].map(([id, group]) => [id, new THREE.Box3().setFromObject(group, true)]));
  for (const state of [{ atria: 1, ventricles: 0 }, { atria: 0, ventricles: 1 }]) {
    beat.set(state);
    for (const [id, group] of parts) partBox.get(id).union(new THREE.Box3().setFromObject(group, true));
  }
  beat.set({ atria: 0, ventricles: 0 });
  // Blood-flow particles (flow.mjs) travel along meta.flow.routes. Their instance matrices are written in the millimetre frame
  // every frame, after the beat has moved the walls, through the same displacement (beat.displace), so they stay inside.
  // The mesh is a helper: createBeat must not deform its sphere geometry, and it is not a part (no clicking, no cut).
  const flow = createFlow(meta.flow);
  // On the cross-section the particles are cut by the same plane as the conduction overlay; the plane keeps everything elsewhere.
  const flowCut = new THREE.Plane(new THREE.Vector3(0, 0, -1), keepAll);
  const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1.5, 12, 8), new THREE.MeshStandardMaterial({ roughness: .45, metalness: 0, clippingPlanes: [flowCut] }), flow.count);
  const dotColors = { right: new THREE.Color(0x4a9bff), left: new THREE.Color(0xff5a4f) };
  const dimColors = { right: dotColors.right.clone().multiplyScalar(.3), left: dotColors.left.clone().multiplyScalar(.3) };
  // The routes that pass through the selected part (flow.mjs, routesThrough). While some are named, the particles of the others are
  // drawn small and dark; empty means every route is drawn the same.
  let routeFocus = [];
  function paintDots() {
    for (let k = 0; k < flow.count; k++) {
      const side = flow.side(k);
      dots.setColorAt(k, routeFocus.length === 0 || routeFocus.includes(flow.route(k)) ? dotColors[side] : dimColors[side]);
    }
    dots.instanceColor.needsUpdate = true;
  }
  paintDots();
  dots.userData.helper = true;
  dots.frustumCulled = false;
  dots.visible = false;
  exterior.add(dots);
  // Schematic valve leaflets (valves.mjs) of the flow view. They open and close with the particles' valve windows and are
  // moved by the same displacement as the particles. The valves of the source data are not drawn in this view.
  const leafletPart = { tricuspid: 'tv', mitral: 'mv', aortic: 'aov', pulmonary: 'pov' }; // the colours are those of the source valves
  const leaflets = Object.entries(flow.valves).map(([name, valve]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(valve.vertexCount * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(valve.indices, 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: parts.get(leafletPart[name]).userData.color, roughness: .6, metalness: 0, side: THREE.DoubleSide }));
    mesh.userData.helper = true;
    mesh.frustumCulled = false;
    mesh.visible = false;
    exterior.add(mesh);
    return { name, mesh, rest: new Float64Array(valve.vertexCount * 3), moved: [0, 0, 0] };
  });
  const dotPoint = [0, 0, 0], dotMatrix = new THREE.Matrix4();
  let flowStale = true;
  function drawFlow() {
    for (let k = 0; k < flow.count; k++) {
      const size = flow.sample(k, dotPoint) * (routeFocus.length === 0 ? 1 : routeFocus.includes(flow.route(k)) ? 1.2 : .55), p = beat.displace(dotPoint);
      dotMatrix.makeScale(size, size, size).setPosition(p[0], p[1], p[2]);
      dots.setMatrixAt(k, dotMatrix);
    }
    dots.instanceMatrix.needsUpdate = true;
    for (const { name, mesh, rest, moved } of leaflets) {
      flow.leaflets(name, rest);
      const position = mesh.geometry.attributes.position;
      for (let i = 0; i < position.count; i++) {
        moved[0] = rest[3 * i]; moved[1] = rest[3 * i + 1]; moved[2] = rest[3 * i + 2];
        const p = beat.displace(moved);
        position.setXYZ(i, p[0], p[1], p[2]);
      }
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    flowStale = false;
  }
  const modeText = {
    exterior: ['01 / EXTERIOR', 'かたちから、心臓を知る。', 'lv'],
    conduction: ['02 / CONDUCTION', '刺激の通り道をたどる。', 'sa'],
    interior: ['03 / INTERIOR', '断面から、内側を見る。', 'mv'],
    flow: ['04 / FLOW', '血のめぐりを、追う。', 'lv'],
  };
  controls.target.copy(bounds.center);
  let mode = 'exterior', selected = 'lv', frame = 0, previousTime = 0, failed = false, conductionOverlay = false, flowOverlay = false, pick = null;
  // beatTime is the time within the heartbeat in real milliseconds, as last drawn; it advances only while beating. `playback` is
  // the clock it is read from, and the heart sounds are booked from the same clock (heartsound.mjs).
  let beating = false, realSpeed = false, beatTime = 0, shownPhase = -1;
  const playback = createPlayback(() => performance.now() / 1000), scheduler = createSoundScheduler();
  const sound = createHeartSound(globalThis.AudioContext || globalThis.webkitAudioContext);
  let soundOn = false, pump = 0;
  // With the system setting "reduce motion" the beat plays once per press and stops at rest, instead of looping.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setPlayButton = () => { $('beat-play').textContent = beating ? '拍動を止める' : reduceMotion.matches ? '拍動を1回再生' : '拍動を再生'; };
  setPlayButton();
  reduceMotion.addEventListener('change', setPlayButton);
  const selectable = group => selectableIn(group.userData, mode, conductionOverlay);
  let fittedDistance = 12, userZoom = 1;
  const gesture = new TapGesture();
  const ray = new THREE.Raycaster();
  // Line.raycast divides the threshold by the line's own scale only, not its parents' scale.
  // The overlay is drawn in millimetres under a scaled group, so convert to millimetres here.
  ray.params.Line.threshold = .08 / exterior.scale.x;
  const stageOrder = ['sa', 'atria', 'av', 'his', 'bhis', 'rbb', 'lbb', 'purkinje'];
  const labels = new Map();
  for (const [id] of labelAnchors) {
    const label = document.createElement('span');
    label.className = 'model-label';
    label.textContent = parts.get(id).userData.name;
    $('labels').append(label);
    labels.set(id, label);
  }
  // In the interior view the walls are opaque. A label whose anchor lies behind a drawn surface (a wall, a valve or the
  // cut face) is marked "behind the wall" instead of looking like it sits on the surface. The conduction view draws
  // the walls almost transparent, so nothing hides the anchor there.
  const occluders = [...parts.values()].filter(group => group.userData.kind !== 'conduction');
  function behindSurface(world) {
    if (mode !== 'interior') return false;
    const direction = world.clone().sub(camera.position), distance = direction.length();
    ray.set(camera.position, direction.normalize());
    const hit = pickHit(ray, occluders, [cutPlane], crossSection.solids);
    return Boolean(hit) && hit.distance < distance - .04; // .04 viewer units is about 1.2 mm: the anchor sits on a cavity surface
  }
  // Put an element at the screen position of a world point (percent of the canvas). Returns whether the point is outside the view.
  function placeOnScreen(el, world) {
    const p = world.clone().project(camera);
    el.style.left = `${(p.x + 1) * 50}%`;
    el.style.top = `${(1 - p.y) * 50}%`;
    return Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1;
  }
  function updateLabels() {
    for (const [id, anchor] of labelAnchors) {
      const world = conduction.localToWorld(new THREE.Vector3(...beat.displace(anchor)));
      const el = labels.get(id), offScreen = placeOnScreen(el, world);
      // Show one selected label to avoid overlaps in small viewports, and none for a point the cut removed.
      const cutAway = mode === 'interior' && cutPlane.distanceToPoint(world) < 0;
      el.hidden = !conduction.visible || cutAway || selected !== id || offScreen;
      el.classList.toggle('behind', !el.hidden && behindSurface(world));
    }
    // The ring where the cut face was clicked.
    const mark = $('pick-mark');
    if (pick) mark.hidden = placeOnScreen(mark, pick.point);
    else mark.hidden = true;
  }
  function requestRender() {
    if (!frame && !document.hidden && !failed) frame = requestAnimationFrame(render);
  }
  // The phase box under the model (upright phone) keeps the height of its tallest text, or the model box changed size each time
  // the impulse line wrapped differently (review of PR #51: 186-201px at 320x520). In the side column (761-999px) the list scrolls
  // under the box, so the box's height is kept clear when the focus scrolls the list (review of PR #51: Shift+Tab hid the focused
  // button under it).
  const phaseBox = $('beat-phase'), phaseLines = [$('beat-phase-name'), $('beat-phase-short'), $('beat-electric')];
  function fitPhaseBox() {
    phaseBox.style.minHeight = '';
    if (!phaseBox.hidden && getComputedStyle(phaseBox).position === 'static') {
      const saved = phaseLines.map(e => [e.textContent, e.hidden]);
      let tallest = 0;
      for (const phase of phases) for (const text of conduction.visible ? Object.values(stretchText) : ['']) {
        phaseLines[0].textContent = `${phase.name}（${phase.time}）`;
        phaseLines[1].textContent = phase.short;
        phaseLines[2].textContent = text;
        phaseLines[2].hidden = !text;
        tallest = Math.max(tallest, phaseBox.getBoundingClientRect().height);
      }
      saved.forEach(([text, hidden], i) => { phaseLines[i].textContent = text; phaseLines[i].hidden = hidden; });
      phaseBox.style.minHeight = `${Math.ceil(tallest)}px`;
    }
    const aside = document.querySelector('aside');
    aside.style.scrollPaddingTop = phaseBox.parentElement === aside && !phaseBox.hidden ? `${Math.ceil(phaseBox.getBoundingClientRect().height) + 8}px` : '';
  }
  new ResizeObserver(fitPhaseBox).observe(phaseBox);
  function showPhase() {
    const index = phaseAt(beatTime);
    if (phaseBox.hidden) { phaseBox.hidden = false; fitPhaseBox(); }
    $('beat-note').hidden = false;
    if (index === shownPhase) return;
    shownPhase = index;
    const phase = phases[index];
    $('beat-phase-name').textContent = `${phase.name}（${phase.time}）`;
    $('beat-phase-short').textContent = phase.short;
    // In the flow view the leaflets are drawn, and they are closed together for only part of the two periods in which all four valves
    // are closed (README, 血流の模式弁尖); the text says so instead of describing the whole period.
    $('beat-phase-valves').textContent = phase.valves + (mode === 'flow' && index > 0 ? ` この画面の弁尖が4つとも閉じるのは、この時期のうち約${index === 1 ? '0.01' : '0.02'}秒だけです。` : '');
  }
  // Heart sounds. The sounds are booked a short time ahead from the playback clock; whenever the clock changes (play, stop,
  // speed, hidden page, sound on or off) the booked sounds are cancelled and booked again from the current position, so a
  // sound is never played twice or after a stop, and past sounds are never played back.
  const soundLimit = () => reduceMotion.matches ? period : Infinity;
  function bookSounds() {
    if (soundOn && playback.running && !failed) sound.schedule(scheduler.take(playback, sound.now(), { latency: sound.latency(), limit: soundLimit() }));
  }
  function resyncSounds() {
    sound.cancel();
    clearInterval(pump);
    pump = 0;
    if (!soundOn || !playback.running) { scheduler.stop(); return; }
    scheduler.start(playback, sound.now(), sound.latency());
    bookSounds();
    // A timer keeps the booking going while frames are late; the audio context plays what is booked on its own clock.
    pump = setInterval(bookSounds, 50);
  }
  function setSoundButton() {
    $('heart-sound').setAttribute('aria-pressed', String(soundOn));
  }
  function say(text) {
    $('sound-status').hidden = !text;
    $('sound-status').textContent = text;
  }
  // Sound off: the beat goes on from the same position on the page's own clock.
  // After an interruption the audio clock has stopped, so the position is where it stopped; the page's clock takes over from there.
  function soundOff(message = '') {
    const at = playback.position();
    soundOn = false;
    playback.useSource(() => performance.now() / 1000, at);
    resyncSounds();
    setSoundButton();
    say(message);
  }
  let watching = false;
  $('heart-sound').onclick = async () => {
    if (soundOn) { soundOff(); return; }
    say('');
    // Sound can start only from a tap: the context is created and resumed here, before anything is awaited.
    try { await sound.open(); } catch { /* handled by the state check below */ }
    // The 3D view may have stopped (context lost) while the audio context was starting: the controls are disabled then, and
    // the sound must stay off.
    if (failed) { sound.suspend(); return; }
    if (sound.state !== 'running') { say('音声を開始できませんでした。もう一度押してください。端末が消音になっていないかも確認してください。'); return; }
    if (!soundOn) {
      if (!watching) {
        watching = true;
        sound.onStateChange(() => { if (soundOn && sound.state !== 'running') soundOff('音声が中断されたため、心音を切りました。もう一度押すと再開します。'); });
      }
      // The audio clock takes over at the current position, so the beat does not jump when the sound is turned on.
      playback.useSource(() => sound.now());
      soundOn = true;
      resyncSounds();
      setSoundButton();
    }
  };
  $('heart-volume').oninput = () => sound.setVolume(Number($('heart-volume').value));
  // Bring the drawn state (the walls, the particles, the phase text) to the state the clock is at. The beat is drawn at the clock's
  // position, so a slow frame never delays it (or the sounds booked from the same clock). It is also done just before the clock
  // stops (stop button, hidden page), so that the clock keeps its position: sounds up to that position have been booked, and a
  // clock wound back to the last frame would book them again when it restarts. A pause stops the clock; it does not jump ahead
  // afterwards. The particles catch up by at most one beat, which is enough for the ring to settle; a longer stall does not
  // turn into a long run of steps.
  function advanceBeat() {
    // The particles advance to the same limited time as the beat: a frame that crosses the end of a one-beat play must not
    // move them into the next beat.
    const { next, done } = stepBeat(beatTime, Math.max(0, playback.position() - beatTime), reduceMotion.matches);
    flow.advance(Math.max(beatTime, next - period), next);
    flowStale = true;
    beatTime = next;
    if (done) {
      beating = false;
      beatTime = 0;
      playback.pause();
      playback.seek(0);
      resyncSounds();
      setPlayButton();
    }
    beat.set(contraction(beatTime));
    showPhase();
  }
  // Stop the beat clock where the picture is: draw the beat at the clock's position, stop the clock, and book the sounds again.
  // The order matters (see advanceBeat).
  function pauseBeat() {
    advanceBeat();
    playback.pause();
    resyncSounds();
  }
  // The impulse and the schematic ECG follow the beat clock. They are drawn while the beat is playing or stopped part-way (not at
  // rest at 0), in the conduction view (and on the cross-section when the overlay is on); at rest the parts keep their plain look.
  let electricShown = false, electricText = '', ecgKey = '';
  const ecgTrace = $('ecg-trace'), ecgMarks = [...document.querySelectorAll('#ecg-panel text')];
  const ecgSpan = 1000, ecgNow = 276, ecgBase = 46, ecgAmp = 34;
  function drawEcg() {
    // Same beat time and same size: nothing to redraw (the strip is a function of the beat time only).
    const key = String(beatTime);
    if (key === ecgKey) return;
    ecgKey = key;
    const scale = ecgNow / ecgSpan;
    let d = '';
    for (let x = 0; x <= ecgNow; x += 1.5) d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${(ecgBase - ecgAt(beatTime - (ecgNow - x) / scale) * ecgAmp).toFixed(1)}`;
    ecgTrace.setAttribute('d', d);
    // Letters over the waves: P and T, and QRS at the R peak. They are drawn where the wave of a beat in view is.
    const labels = { P: 'P', R: 'QRS', T: 'T' };
    for (const text of ecgMarks) {
      const bump = ecgBumps.find(b => b.name === text.dataset.wave);
      // The newest occurrence of this wave in view, found from the beat time (which keeps growing while the beat plays).
      const age = waveAge(beatTime, bump.mean, 6 / scale, (ecgNow - 6) / scale), x = age === null ? -1 : ecgNow - age * scale;
      text.toggleAttribute('hidden', x < 0);
      if (x >= 0) { text.setAttribute('x', x.toFixed(1)); text.setAttribute('y', (ecgBase - Math.max(bump.height, 0) * ecgAmp - 5).toFixed(1)); text.textContent = labels[bump.name]; }
    }
  }
  function updateElectric() {
    const view = conduction.visible, on = view && (beating || beatTime > 0);
    if (mode === 'conduction') drawEcg();
    if (!on && !electricShown) return;
    electricShown = on;
    pulse.group.visible = on;
    pulse.update(on ? beatTime : null, beat.displace);
    electricGlow = on ? glowAt(beatTime, pulse.lengths) : null;
    paintConduction();
    const text = on ? stretchTextAt(beatTime) : '';
    if (text !== electricText) {
      electricText = text;
      $('beat-electric').textContent = text;
      $('beat-electric').hidden = !text;
    }
  }
  function render(time) {
    const elapsed = previousTime ? (time - previousTime) / 1000 : 0;
    if (controls.autoRotate) controls.update(Math.min(elapsed, .05));
    if (beating) advanceBeat();
    if (dots.visible && flowStale) drawFlow();
    updateElectric();
    renderer.render(scene, camera);
    updateLabels();
    frame = 0;
    previousTime = time;
    if (controls.autoRotate || beating) requestRender();
  }
  controls.addEventListener('change', () => {
    userZoom = camera.position.distanceTo(controls.target) / fittedDistance;
    requestRender();
  });
  function stopRotation() {
    controls.autoRotate = false;
    $('rotate').setAttribute('aria-pressed', 'false');
    previousTime = 0;
  }
  const setOrientation = name => { $('orientation').textContent = `${name} ／ 左右の名称は身体を基準`; };
  function setView(view = 'front') {
    stopRotation();
    const direction = view === 'back' ? [0, .06, -1] : view === 'left' ? [1, .06, 0] : [0, .06, 1];
    camera.position.copy(controls.target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(fittedDistance));
    userZoom = 1;
    controls.update();
    setOrientation(({ front: '前面', back: '背面', left: '身体の左側' })[view]);
    requestRender();
  }
  function resize() {
    fitPhaseBox(); // the text wraps by the width
    const { width, height } = canvas.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    const offset = camera.position.clone().sub(controls.target);
    if (offset.length() < .1) offset.set(0, .06, 1);
    const zoom = userZoom;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    fittedDistance = fitDistance(bounds.radius, camera.aspect);
    controls.minDistance = fittedDistance * .48;
    controls.maxDistance = fittedDistance * 1.8;
    camera.position.copy(controls.target).add(offset.normalize().multiplyScalar(fittedDistance * THREE.MathUtils.clamp(zoom, .48, 1.8)));
    controls.update();
    requestRender();
  }
  // Parts the current cut leaves nothing of stay selectable (their description is still readable), but are marked.
  const cutRemoved = id => mode === 'interior' && removedByCut(partBox.get(id), cutPlane);
  function updateCutNotice() {
    $('cut-notice').hidden = !cutRemoved(selected);
    $('pick-note').hidden = !pick;
    for (const [id, group] of parts) {
      const gone = cutRemoved(id);
      group.userData.button.classList.toggle('cut-out', gone);
      if (gone) group.userData.button.setAttribute('aria-description', '現在の断面では見えません');
      else group.userData.button.removeAttribute('aria-description');
    }
  }
  const dim = hex => new THREE.Color(hex).multiplyScalar(.55);
  // Look of the conduction parts: the selected one is bright; while the impulse runs (updateElectric) a part also glows where the
  // impulse is in it and fades after it has left.
  let electricGlow = null;
  function paintConduction() {
    for (const [key, group] of parts) {
      if (group.userData.kind !== 'conduction') continue;
      const on = key === selected, glow = electricGlow?.[key] ?? 0;
      group.traverse(object => {
        if (object.isMesh) {
          const mat = object.material;
          mat.emissive.setHex(group.userData.color);
          mat.emissiveIntensity = Math.max(on ? .8 : .18, glow * .95);
        } else if (object.isLine) {
          // The dashed line has no emissive: a selected or glowing one turns bright and nearly solid, the others dim and sparse.
          const mat = object.material, lit = on || glow > .05;
          mat.color.set(lit ? 0xfff4d6 : dim(group.userData.color));
          mat.dashSize = lit ? 4 : 2.7;
          mat.gapSize = lit ? 1 : 2.4;
        }
      });
    }
  }
  // Blood-flow view: the particles of the routes through the selected part are emphasised, and the note names them.
  const routeNames = { svc: '上大静脈', ivc: '下大静脈', lspv: '左上肺静脈', lipv: '左下肺静脈', rspv: '右上肺静脈', ripv: '右下肺静脈' };
  // userChose: the part was chosen by the user in this view (a part that the view picks on entering does not dim the other routes).
  let userChose = false;
  function showRouteFocus() {
    const focus = mode === 'flow' && userChose ? routesThrough(selected, flow.routes) : [];
    const changed = focus.join() !== routeFocus.join();
    routeFocus = focus;
    if (changed) { paintDots(); flowStale = true; }
    const note = $('flow-route-note');
    note.hidden = mode !== 'flow';
    if (mode !== 'flow') return;
    if (!userChose) { note.textContent = '部位を選ぶと、その部位を通る経路の粒子だけを強調します（他の経路は小さく暗くなります）。'; return; }
    const side = focus.length ? flow.routes[focus[0]].side === 'right' ? '右心系' : '左心系' : '';
    note.textContent = focus.length
      ? `選んだ「${parts.get(selected).userData.name}」を通る経路（${focus.map(i => routeNames[flow.routes[i].id]).join('・')}の${focus.length}本、${side}）を強調しています。他の経路の粒子は小さく暗くしています。経路は右心系の2本と左心系の4本に分かれるだけなので、同じ側の部位を選ぶと同じ経路が強調されます。`
      : `「${parts.get(selected).userData.name}」を通る経路はありません（冠動脈・冠静脈は経路に含めていません）。全部の経路をそのまま表示しています。`;
  }
  // from: the pick result when the part was chosen by clicking the model. A click on the cut face is remembered
  // as a point, drawn as a ring, because the cut face has one colour for every chamber.
  function select(id, from = null) {
    if (!parts.has(id) || !selectable(parts.get(id))) return;
    selected = id;
    pick = from?.onCut ? { point: from.point.clone() } : null;
    crossSection.setRegion(mode === 'interior' ? id : null);
    for (const [key, group] of parts) {
      group.userData.button.setAttribute('aria-pressed', String(key === id));
      if (group.userData.kind === 'conduction') continue;
      group.traverse(object => { if (object.isMesh) object.material.emissive.setHex(key === id ? 0x40201b : 0); });
    }
    paintConduction();
    showRouteFocus();
    const data = parts.get(id).userData;
    $('name').textContent = data.name;
    $('en').textContent = data.en;
    $('description').textContent = data.desc;
    // The description box scrolls on its own on a phone; a new part must start at its top.
    document.querySelector('.detail').scrollTop = 0;
    const step = stageOrder.indexOf(id);
    $('step-count').textContent = mode === 'conduction' ? `${step + 1} / ${stageOrder.length}` : '';
    $('previous').disabled = step <= 0;
    $('next').disabled = step >= stageOrder.length - 1;
    updateCutNotice();
    requestRender();
  }
  for (const [id, group] of parts) {
    const button = document.createElement('button');
    button.className = 'part';
    button.dataset.viewerControl = '';
    const dot = document.createElement('i');
    dot.style.backgroundColor = `#${group.userData.color.toString(16).padStart(6, '0')}`;
    // The tag is hidden from the accessible name; the button gets aria-description instead when the cut removes the part.
    const tag = document.createElement('em');
    tag.className = 'cut-tag';
    tag.textContent = '断面で消えた';
    tag.setAttribute('aria-hidden', 'true');
    button.append(dot, document.createTextNode(group.userData.name), tag);
    button.onclick = () => { userChose = true; select(id); };
    group.userData.button = button;
    $('parts').append(button);
  }
  // Conduction is shown in its own view, and on the cross-section when the overlay is on.
  function showConduction() {
    const interior = mode === 'interior';
    conduction.visible = mode === 'conduction' || (interior && conductionOverlay);
    conductionCut.constant = interior ? cutPlane.constant : keepAll;
    for (const group of parts.values()) group.userData.button.hidden = !selectable(group);
    $('conduction-note').hidden = !conduction.visible;
    $('ecg-panel').hidden = mode !== 'conduction';
    fitPhaseBox(); // the impulse line is shown with the conduction overlay
    $('propagation-note').hidden = mode !== 'conduction';
    ecgKey = '';
    $('interior-conduction').setAttribute('aria-pressed', String(conductionOverlay));
    updateCutNotice();
  }
  // Particles are shown in the flow view, and on the cross-section when their overlay is on (the leaflets of the source data stay).
  function showFlowOverlay() {
    const interior = mode === 'interior';
    dots.visible = mode === 'flow' || (interior && flowOverlay);
    flowCut.constant = interior ? cutPlane.constant : keepAll;
    flowStale = true;
    $('interior-flow').setAttribute('aria-pressed', String(flowOverlay));
    $('flow-overlay-note').hidden = !(interior && flowOverlay);
  }
  function setMode(next) {
    mode = next;
    stopRotation();
    const interior = mode === 'interior';
    crossSection.setEnabled(interior);
    showConduction();
    // The walls are almost transparent where something inside them is shown: the conduction system and the blood.
    const seeThrough = mode === 'conduction' || mode === 'flow';
    showFlowOverlay();
    shownPhase = -1;
    if (!$('beat-phase').hidden) showPhase();
    for (const { mesh } of leaflets) mesh.visible = mode === 'flow';
    for (const group of parts.values()) {
      if (group.userData.kind !== 'exterior') continue;
      group.traverse(object => {
        if (!object.isMesh || object.userData.crossSection || object.material.transparent === seeThrough) return;
        object.material.transparent = seeThrough;
        object.material.opacity = seeThrough ? .07 : 1;
        object.material.depthWrite = !seeThrough;
        object.material.needsUpdate = true;
      });
    }
    for (const m of Object.keys(modeText)) $(`mode-${m}`).setAttribute('aria-pressed', String(mode === m));
    $('steps').hidden = mode !== 'conduction';
    $('flow-note').hidden = mode !== 'flow';
    $('interior-note').hidden = !interior;
    $('cut').hidden = !interior;
    $('interior-overlay').hidden = !interior;
    $('mode-number').textContent = modeText[mode][0];
    $('mode-title').textContent = modeText[mode][1];
    userChose = false;
    select(modeText[mode][2]);
    setView('front');
  }
  $('mode-exterior').onclick = () => setMode('exterior');
  $('mode-conduction').onclick = () => setMode('conduction');
  $('mode-interior').onclick = () => setMode('interior');
  $('mode-flow').onclick = () => setMode('flow');
  // The slider runs from front (left) to back (right); the plane keeps everything behind it.
  function applyDepth() {
    cutPlane.constant = -Number($('cut-depth').value);
    pick = null; // the ring marked a point on the previous plane
    crossSection.update();
    showConduction();
    showFlowOverlay();
    requestRender();
  }
  $('cut-depth').oninput = applyDepth;
  // The cut keeps z <= -depth, so a part is left while depth <= -(its smallest z). Go a little inside that.
  $('cut-restore').onclick = () => {
    const slider = $('cut-depth'), step = Number(slider.step);
    const target = Math.floor((-partBox.get(selected).min.z - .1) / step + 1e-9) * step;
    slider.value = Math.max(Number(slider.min), target).toFixed(2);
    applyDepth();
  };
  $('interior-conduction').onclick = () => {
    conductionOverlay = !conductionOverlay;
    showConduction();
    // Turning the overlay off must not leave a hidden conduction part selected.
    if (!selectable(parts.get(selected))) select(modeText.interior[2]);
    else requestRender();
  };
  $('interior-flow').onclick = () => {
    flowOverlay = !flowOverlay;
    showFlowOverlay();
    requestRender();
  };
  $('previous').onclick = () => select(stageOrder[Math.max(0, stageOrder.indexOf(selected) - 1)]);
  $('next').onclick = () => select(stageOrder[Math.min(stageOrder.length - 1, stageOrder.indexOf(selected) + 1)]);
  for (const view of ['front', 'back', 'left']) $(`view-${view}`).onclick = () => setView(view);
  $('reset').onclick = () => setView('front');
  $('rotate').onclick = () => {
    controls.autoRotate = !controls.autoRotate;
    // The camera now moves away from any named view, so the label must not keep naming one.
    if (controls.autoRotate) setOrientation('自由視点');
    $('rotate').setAttribute('aria-pressed', String(controls.autoRotate));
    previousTime = 0;
    requestRender();
  };
  // Stopping keeps the current shape and phase, so a moment of the beat can be looked at.
  $('beat-play').onclick = () => {
    beating = !beating;
    if (beating) { playback.play(); resyncSounds(); }
    else pauseBeat();
    setPlayButton();
    showPhase();
    requestRender();
  };
  $('beat-speed').onclick = () => {
    realSpeed = !realSpeed;
    playback.setSlow(!realSpeed);
    resyncSounds();
    $('beat-speed').setAttribute('aria-pressed', String(realSpeed));
  };
  if (!sound.supported) {
    $('heart-sound').hidden = true;
    $('heart-volume-label').hidden = true;
    $('sound-note').textContent = 'このブラウザーは音声の再生（Web Audio API）に対応していないため、心音のボタンを表示していません。拍動の表示はそのまま使えます。';
  }
  function zoom(factor) {
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor).clampLength(controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(offset);
    controls.update();
  }
  $('in').onclick = () => zoom(.82);
  $('out').onclick = () => zoom(1.22);
  canvas.addEventListener('pointerdown', event => {
    stopRotation();
    gesture.down(event.pointerId, event.clientX, event.clientY);
  });
  canvas.addEventListener('pointermove', event => gesture.move(event.pointerId, event.clientX, event.clientY));
  canvas.addEventListener('pointercancel', event => gesture.cancel(event.pointerId));
  canvas.addEventListener('lostpointercapture', event => gesture.cancel(event.pointerId));
  canvas.addEventListener('pointerup', event => {
    if (!gesture.up(event.pointerId, event.clientX, event.clientY) || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    // Outside the conduction view, unselectable vessels stay in the targets so they still block clicks.
    const targets = mode === 'conduction' ? conduction.children : [...parts.values()].filter(g => g.userData.kind !== 'conduction' || conduction.visible);
    const cutView = mode === 'interior';
    const hit = pickHit(ray, targets, cutView ? [cutPlane] : [], cutView ? crossSection.solids : []);
    if (hit) { userChose = true; select(hit.id, hit); }
  });
  controls.addEventListener('start', () => {
    stopRotation();
    setOrientation('自由視点');
  });
  canvas.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '=', 'Home'].includes(event.key)) return;
    event.preventDefault();
    stopRotation();
    if (event.key === 'Home') return setView('front');
    if (['+', '=', '-'].includes(event.key)) return zoom(event.key === '-' ? 1.22 : .82);
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (event.key === 'ArrowLeft') spherical.theta -= .15;
    if (event.key === 'ArrowRight') spherical.theta += .15;
    if (event.key === 'ArrowUp') spherical.phi -= .15;
    if (event.key === 'ArrowDown') spherical.phi += .15;
    spherical.makeSafe();
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update();
    setOrientation('自由視点');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRotation();
      cancelAnimationFrame(frame);
      frame = 0;
      // The beat and the sounds stop together and go on from the same position when the page is shown again.
      if (beating) pauseBeat();
    } else {
      if (beating) { playback.play(); resyncSounds(); }
      requestRender();
    }
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    failed = true;
    stopRotation();
    cancelAnimationFrame(frame);
    frame = 0;
    // Nothing is drawn any more and the controls are disabled, so the beat and the sounds stop here too: they could not be
    // stopped from the page afterwards.
    beating = false;
    playback.pause();
    if (soundOn) soundOff(); else resyncSounds();
    // The audio context would keep running (no sound, but power) with no control left to stop it.
    sound.suspend();
    setPlayButton();
    showError('3D表示が中断しました。ページを再読み込みしてください。説明と参考リンクは引き続き読めます。');
  });
  new ResizeObserver(resize).observe(canvas);
  resize();
  // The controls are disabled in the HTML, so that they do not look usable without JavaScript; they are enabled once the viewer
  // runs. setMode (through select) then disables the step buttons that do not apply.
  document.querySelectorAll('[data-viewer-control]').forEach(control => control.disabled = false);
  setMode('exterior');
  document.documentElement.dataset.ready = 'true';
} catch (error) {
  showError(error?.name === 'HeartBundleError'
    ? '心臓モデルのデータを読み込めませんでした（データの形式がこの版の表示プログラムと合いません）。説明と参考リンクは引き続き読めます。'
    : '3D表示を開始できませんでした。WebGL 2に対応したブラウザーで開いてください。参考リンクからMSDのモデルも確認できます。');
  console.error(error);
}
