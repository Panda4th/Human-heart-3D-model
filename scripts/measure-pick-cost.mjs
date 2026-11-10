// Issue #17 / #21: CPU time of the hit tests that run in the interior view.
//   label  : the ray cast by behindSurface() in src/main.js for the one visible label, once per frame
//   click  : the pickHit() cast in the pointerup handler (current cut-face rule), with the conduction overlay off and on
//            as the viewer builds the candidate list: src/main.js excludes the conduction parts unless the overlay is on
//   nearest: the "nearest wall face" rule that was compared in issue-17-cut-pick-validation but not adopted
// Runs in Node (V8) on the heart at rest, without the beat deformation, without WebGL. It does not measure
// GPU load, a phone, or the browser's event handling. Output: JSON on stdout.
import * as THREE from 'three';
import os from 'node:os';
import { createCrossSection, fitDistance, modelSphere, pickHit, wallIds } from '../src/viewer-state.mjs';
import { createConduction } from '../src/conduction.mjs';
import { createAnatomy } from '../src/anatomy.mjs';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url));
const probe = new THREE.Group(), probeParts = new Map();
createAnatomy(probe, probeParts, bundle, .033);
const bounds = modelSphere(probe);

// `slider` is the value of the cut-depth slider. src/main.js sets the plane constant to -slider.
function sceneAt(slider, eye) {
  const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
  heart.add(exterior);
  const meta = createAnatomy(exterior, parts, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -slider);
  const section = createCrossSection(exterior, parts, plane, 0xc98478);
  section.setEnabled(true);
  exterior.add(conduction);
  const anchors = createConduction(conduction, parts, meta.conduction);
  heart.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(...eye).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  const occluders = [...parts.values()].filter(g => g.userData.kind !== 'conduction');
  return { parts, plane, section, camera, anchors, conduction, occluders, exterior };
}

const stats = list => {
  const s = [...list].sort((a, b) => a - b), at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, medianMs: +at(.5).toFixed(3), p95Ms: +at(.95).toFixed(3), maxMs: +s.at(-1).toFixed(3) };
};
const time = fn => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };

const eyes = [[0, .06, 1], [.5, .2, 1], [-.5, -.1, 1]], sliders = [0, .5, -.5];
const label = [], labelNoSolids = [], perScene = [];
const variants = { overlayOff: { click: [], clickOnCut: [], clickNotOnCut: [], nearest: [] }, overlayOn: { click: [], clickOnCut: [], clickNotOnCut: [], nearest: [] } };
const ray = new THREE.Raycaster();
const local = new THREE.Vector3(), closest = new THREE.Vector3(), triangle = new THREE.Triangle();

function nearestWall(meshes, sample) {
  let best = [null, Infinity];
  for (const [id, mesh] of meshes) {
    const { index, attributes: { position } } = mesh.geometry;
    let min = Infinity;
    for (let f = 0; f < index.count; f += 3) {
      triangle.a.fromBufferAttribute(position, index.getX(f));
      triangle.b.fromBufferAttribute(position, index.getX(f + 1));
      triangle.c.fromBufferAttribute(position, index.getX(f + 2));
      triangle.closestPointToPoint(sample, closest);
      min = Math.min(min, closest.distanceToSquared(sample));
    }
    if (min < best[1]) best = [id, min];
  }
  return best[0];
}

for (const slider of sliders) for (const eye of eyes) {
  const s = sceneAt(slider, eye);
  // As in src/main.js: the line hit width of the conduction overlay, in millimetres under the scaled group.
  ray.params.Line.threshold = .08 / s.exterior.scale.x;
  const wallMeshes = wallIds.map(id => [id, s.parts.get(id).children[0]]);
  const toLocal = new THREE.Matrix4().copy(s.exterior.matrixWorld).invert();
  const sceneLabel = [], sceneClick = { overlayOff: [], overlayOn: [] };
  // Label: the same ray as behindSurface(), for every label whose anchor the cut keeps. The label is shown only with the overlay on;
  // the occluders never include the conduction parts.
  for (const [, anchor] of s.anchors) {
    const world = s.conduction.localToWorld(new THREE.Vector3(...anchor));
    if (s.plane.distanceToPoint(world) < 0) continue;
    const direction = world.clone().sub(s.camera.position);
    ray.set(s.camera.position, direction.normalize());
    for (let i = 0; i < 5; i++) pickHit(ray, s.occluders, [s.plane], s.section.solids); // warm-up
    for (let i = 0; i < 40; i++) { const [ms] = time(() => pickHit(ray, s.occluders, [s.plane], s.section.solids)); sceneLabel.push(ms); label.push(ms); }
    // Same ray without the cut-face test: a second condition, not the cost of the cut-face test alone (see the record).
    for (let i = 0; i < 40; i++) { const [ms] = time(() => pickHit(ray, s.occluders, [s.plane], [])); labelNoSolids.push(ms); }
  }
  // Click: the grid of rays used by tests/viewer-state.test.mjs, cast at the cut view with the viewer's candidate list.
  for (const [name, overlay] of [['overlayOff', false], ['overlayOn', true]]) {
    s.conduction.visible = overlay;
    const targets = [...s.parts.values()].filter(g => g.userData.kind !== 'conduction' || s.conduction.visible);
    const v = variants[name];
    for (let i = 0; i < 20; i++) { ray.setFromCamera(new THREE.Vector2(0, 0), s.camera); pickHit(ray, targets, [s.plane], s.section.solids); }
    for (let x = -.6; x <= .6; x += .04) for (let y = -.7; y <= .7; y += .04) {
      ray.setFromCamera(new THREE.Vector2(x, y), s.camera);
      const [ms, hit] = time(() => pickHit(ray, targets, [s.plane], s.section.solids));
      sceneClick[name].push(ms); v.click.push(ms);
      if (hit?.onCut) {
        v.clickOnCut.push(ms);
        local.copy(hit.point).applyMatrix4(toLocal);
        const [nms] = time(() => nearestWall(wallMeshes, local));
        v.nearest.push(nms);
      } else v.clickNotOnCut.push(ms);
    }
  }
  perScene.push({ slider, planeConstant: -slider, eye, label: stats(sceneLabel), clickOverlayOff: stats(sceneClick.overlayOff), clickOverlayOn: stats(sceneClick.overlayOn) });
}

const summary = v => ({ click: stats(v.click), clickOnCut: stats(v.clickOnCut), clickNotOnCut: stats(v.clickNotOnCut), nearestFaceAfterCutHit: stats(v.nearest) });
console.log(JSON.stringify({
  runtime: { node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length },
  wallFaces: wallIds.reduce((n, id) => n + probeParts.get(id).children[0].geometry.index.count / 3, 0),
  sliderToPlaneConstant: 'constant = -slider (src/main.js applyDepth)',
  label: stats(label), labelWithoutCutFaceTest: stats(labelNoSolids),
  overlayOff: summary(variants.overlayOff), overlayOn: summary(variants.overlayOn), perScene
}, null, 1));
