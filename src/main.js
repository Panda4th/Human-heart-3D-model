import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createConduction } from './conduction.mjs';
import { createAnatomy } from './anatomy.mjs';
import { contraction, createBeat, phaseAt, phases, slowFactor } from './heartbeat.mjs';
import anatomyData from './data/bodyparts3d-heart.bin';
import { createCrossSection, fitDistance, modelSphere, pickHit, removedByCut, selectableIn, TapGesture } from './viewer-state.mjs';

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
  const place = () => {
    for (const [el, home] of moved) phone.matches ? $('pinned').append(el) : home.after(el);
  };
  phone.addEventListener('change', place);
  place();
}
try {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  const controls = new OrbitControls(camera, canvas);
  // On-demand rendering avoids spending battery while the model is still.
  controls.enableDamping = false;
  controls.enablePan = false;
  controls.autoRotateSpeed = .8;
  scene.add(new THREE.HemisphereLight(0xddeaff, 0x27131b, 2));
  for (const [color, intensity, pos] of [[0xffd8bd, 100, [4, 5, 6]], [0x8caeff, 65, [-4, 2, -3]]]) {
    const light = new THREE.PointLight(color, intensity);
    light.position.set(...pos);
    scene.add(light);
  }
  // BodyParts3D meshes in millimetres; createAnatomy scales them to viewer units.
  const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
  scene.add(heart);
  heart.add(exterior);
  const meta = createAnatomy(exterior, parts, anatomyData, .033);
  // Interior view: a front-to-back cut fixed to the heart. Points with z > constant are removed.
  // Read the slider so a value restored by the browser matches the drawn cut.
  const cutPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -Number($('cut-depth').value));
  const crossSection = createCrossSection(exterior, parts, cutPlane, 0xc98478);
  exterior.add(conduction);
  const labelAnchors = createConduction(conduction, parts, meta.conduction);
  // Created after the cross-section and the conduction overlay so that it deforms their geometry too.
  const beat = createBeat(exterior, parts);
  // The overlay on the cross-section is cut by the same plane. Its materials keep one clipping plane in
  // every mode so that showing it never recompiles shaders; outside the interior view the plane is
  // moved far enough to keep everything. The bounds are taken before the plane can clip anything.
  const keepAll = 1e3;
  const conductionCut = new THREE.Plane(new THREE.Vector3(0, 0, -1), keepAll);
  conduction.traverse(o => { if (o.material) o.material.clippingPlanes = [conductionCut]; });
  const bounds = modelSphere(heart);
  // World-space box of every part, for telling whether the current cut leaves anything of it.
  const partBox = new Map([...parts].map(([id, group]) => [id, new THREE.Box3().setFromObject(group)]));
  const modeText = {
    exterior: ['01 / EXTERIOR', 'かたちから、心臓を知る。', 'lv'],
    conduction: ['02 / CONDUCTION', '刺激の通り道をたどる。', 'sa'],
    interior: ['03 / INTERIOR', '断面から、内側を見る。', 'mv'],
  };
  controls.target.copy(bounds.center);
  let mode = 'exterior', selected = 'lv', frame = 0, previousTime = 0, failed = false, overlay = false, pick = null;
  // beatTime is the time within the heartbeat in real milliseconds; it advances only while beating.
  let beating = false, realSpeed = false, beatTime = 0, shownPhase = -1;
  const selectable = group => selectableIn(group.userData, mode, overlay);
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
  function updateLabels() {
    for (const [id, anchor] of labelAnchors) {
      const world = conduction.localToWorld(new THREE.Vector3(...beat.displace(anchor)));
      const p = world.clone().project(camera);
      const el = labels.get(id);
      // Show one selected label to avoid overlaps in small viewports, and none for a point the cut removed.
      const cutAway = mode === 'interior' && cutPlane.distanceToPoint(world) < 0;
      el.hidden = !conduction.visible || cutAway || selected !== id || Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1;
      el.classList.toggle('behind', !el.hidden && behindSurface(world));
      el.style.left = `${(p.x + 1) * 50}%`;
      el.style.top = `${(1 - p.y) * 50}%`;
    }
    // The ring where the cut face was clicked.
    const mark = $('pick-mark');
    if (pick) {
      const p = pick.point.clone().project(camera);
      mark.hidden = Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || Math.abs(p.z) > 1;
      mark.style.left = `${(p.x + 1) * 50}%`;
      mark.style.top = `${(1 - p.y) * 50}%`;
    } else mark.hidden = true;
  }
  function requestRender() {
    if (!frame && !document.hidden && !failed) frame = requestAnimationFrame(render);
  }
  function showPhase() {
    const index = phaseAt(beatTime);
    $('beat-phase').hidden = false;
    $('beat-note').hidden = false;
    if (index === shownPhase) return;
    shownPhase = index;
    const phase = phases[index];
    $('beat-phase-name').textContent = `${phase.name}（${phase.time}）`;
    $('beat-phase-short').textContent = phase.short;
    $('beat-phase-valves').textContent = phase.valves;
  }
  function render(time) {
    const elapsed = previousTime ? (time - previousTime) / 1000 : 0;
    if (controls.autoRotate) controls.update(Math.min(elapsed, .05));
    // The beat keeps to the clock on a slow device too; a long pause (previousTime reset to 0) does not jump ahead.
    if (beating) {
      beatTime += Math.min(elapsed, .25) * 1000 / (realSpeed ? 1 : slowFactor);
      beat.set(contraction(beatTime));
      showPhase();
    }
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
  function setView(view = 'front') {
    stopRotation();
    const direction = view === 'back' ? [0, .06, -1] : view === 'left' ? [1, .06, 0] : [0, .06, 1];
    camera.position.copy(controls.target).add(new THREE.Vector3(...direction).normalize().multiplyScalar(fittedDistance));
    userZoom = 1;
    controls.update();
    $('orientation').textContent = ({front: '前面', back: '背面', left: '身体の左側'})[view] + ' ／ 左右の名称は身体を基準';
    requestRender();
  }
  function resize() {
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
  // from: the pick result when the part was chosen by clicking the model. A click on the cut face is remembered
  // as a point, drawn as a ring, because the cut face has one colour for every chamber.
  function select(id, from = null) {
    if (!parts.has(id) || !selectable(parts.get(id))) return;
    selected = id;
    pick = from?.onCut ? { point: from.point.clone() } : null;
    crossSection.setRegion(mode === 'interior' ? id : null);
    for (const [key, group] of parts) {
      group.userData.button.setAttribute('aria-pressed', String(key === id));
      group.traverse(object => {
        if (object.isMesh) {
          const mat = object.material;
          if (group.userData.kind === 'conduction') {
            mat.emissive.setHex(group.userData.color);
            mat.emissiveIntensity = key === id ? .8 : .18;
          } else mat.emissive.setHex(key === id ? 0x40201b : 0);
        } else if (object.isLine) {
          // The dashed line has no emissive: a selected one turns bright and nearly solid, the others dim and sparse.
          const mat = object.material, on = key === id;
          mat.color.set(on ? 0xfff4d6 : dim(group.userData.color));
          mat.dashSize = on ? 4 : 2.7;
          mat.gapSize = on ? 1 : 2.4;
        }
      });
    }
    const data = parts.get(id).userData;
    $('name').textContent = data.name;
    $('en').textContent = data.en;
    $('description').textContent = data.desc;
    // The description box scrolls on its own on a phone; a new part must start at its top.
    document.querySelector('.detail').scrollTop = 0;
    $('step-count').textContent = mode === 'conduction' ? `${stageOrder.indexOf(id) + 1} / ${stageOrder.length}` : '';
    $('previous').disabled = stageOrder.indexOf(id) <= 0;
    $('next').disabled = stageOrder.indexOf(id) >= stageOrder.length - 1;
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
    button.onclick = () => select(id);
    group.userData.button = button;
    $('parts').append(button);
  }
  // Conduction is shown in its own view, and on the cross-section when the overlay is on.
  function showConduction() {
    const interior = mode === 'interior';
    conduction.visible = mode === 'conduction' || (interior && overlay);
    conductionCut.constant = interior ? cutPlane.constant : keepAll;
    for (const group of parts.values()) group.userData.button.hidden = !selectable(group);
    $('conduction-note').hidden = !conduction.visible;
    $('interior-conduction').setAttribute('aria-pressed', String(overlay));
    updateCutNotice();
  }
  function setMode(next) {
    mode = next;
    stopRotation();
    const interior = mode === 'interior';
    crossSection.setEnabled(interior);
    showConduction();
    const conductionView = mode === 'conduction';
    for (const group of parts.values()) {
      if (group.userData.kind !== 'exterior') continue;
      group.traverse(object => {
        if (!object.isMesh || object.userData.crossSection || object.material.transparent === conductionView) return;
        object.material.transparent = conductionView;
        object.material.opacity = conductionView ? .12 : 1;
        object.material.depthWrite = !conductionView;
        object.material.needsUpdate = true;
      });
    }
    for (const m of Object.keys(modeText)) $(`mode-${m}`).setAttribute('aria-pressed', String(mode === m));
    $('steps').hidden = mode !== 'conduction';
    $('interior-note').hidden = !interior;
    $('cut').hidden = !interior;
    $('interior-overlay').hidden = !interior;
    $('mode-number').textContent = modeText[mode][0];
    $('mode-title').textContent = modeText[mode][1];
    select(modeText[mode][2]);
    setView('front');
  }
  $('mode-exterior').onclick = () => setMode('exterior');
  $('mode-conduction').onclick = () => setMode('conduction');
  $('mode-interior').onclick = () => setMode('interior');
  // The slider runs from front (left) to back (right); the plane keeps everything behind it.
  function applyDepth() {
    cutPlane.constant = -Number($('cut-depth').value);
    pick = null; // the ring marked a point on the previous plane
    crossSection.update();
    showConduction();
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
    overlay = !overlay;
    showConduction();
    // Turning the overlay off must not leave a hidden conduction part selected.
    if (!selectable(parts.get(selected))) select(modeText.interior[2]);
    else requestRender();
  };
    $('previous').onclick = () => select(stageOrder[Math.max(0, stageOrder.indexOf(selected) - 1)]);
  $('next').onclick = () => select(stageOrder[Math.min(stageOrder.length - 1, stageOrder.indexOf(selected) + 1)]);
  for (const view of ['front', 'back', 'left']) $(`view-${view}`).onclick = () => setView(view);
  $('reset').onclick = () => setView('front');
  $('rotate').onclick = () => {
    controls.autoRotate = !controls.autoRotate;
    // The camera now moves away from any named view, so the label must not keep naming one.
    if (controls.autoRotate) $('orientation').textContent = '自由視点 ／ 左右の名称は身体を基準';
    $('rotate').setAttribute('aria-pressed', String(controls.autoRotate));
    previousTime = 0;
    requestRender();
  };
  // Stopping keeps the current shape and phase, so a moment of the beat can be looked at.
  $('beat-play').onclick = () => {
    beating = !beating;
    $('beat-play').setAttribute('aria-pressed', String(beating));
    $('beat-play').textContent = beating ? '拍動を止める' : '拍動を再生';
    previousTime = 0;
    showPhase();
    requestRender();
  };
  $('beat-speed').onclick = () => {
    realSpeed = !realSpeed;
    $('beat-speed').setAttribute('aria-pressed', String(realSpeed));
  };
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
    const hit = pickHit(ray, targets, mode === 'interior' ? [cutPlane] : [], mode === 'interior' ? crossSection.solids : []);
    if (hit) select(hit.id, hit);
  });
  controls.addEventListener('start', () => {
    stopRotation();
    $('orientation').textContent = '自由視点 ／ 左右の名称は身体を基準';
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
    $('orientation').textContent = '自由視点 ／ 左右の名称は身体を基準';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopRotation();
      cancelAnimationFrame(frame);
      frame = 0;
    } else requestRender();
  });
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    failed = true;
    stopRotation();
    cancelAnimationFrame(frame);
    frame = 0;
    showError('3D表示が中断しました。ページを再読み込みしてください。説明と参考リンクは引き続き読めます。');
  });
  new ResizeObserver(resize).observe(canvas);
  resize();
  setMode('exterior');
  document.documentElement.dataset.ready = 'true';
} catch (error) {
  showError('3D表示を開始できませんでした。WebGL対応のブラウザーで開いてください。参考リンクからMSDのモデルも確認できます。');
  console.error(error);
}
