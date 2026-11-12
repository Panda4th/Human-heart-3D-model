// Issue #17 / #21: CPU time while the heart beats. Follow-up to scripts/measure-pick-cost.mjs, which measured the heart at rest.
//   hit tests : the label-occlusion ray and the click ray of the interior view, on the walls deformed by the beat
//               (rest, atria most contracted, ventricles most contracted)
//   frame     : the CPU work src/main.js render() does per frame while beating, one component at a time:
//               flow.advance, beat.set, drawFlow (flow mode / interior flow overlay) and the label ray (interior view)
// Runs in Node (V8), without WebGL. It does not measure the GPU, a phone, the browser's event handling or renderer.render.
// drawFlow below is a copy of the function in src/main.js (not imported, because main.js is the browser entry): re-check it
// against src/main.js when that changes. Output: JSON on stdout.
import * as THREE from 'three';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { createCrossSection, fitDistance, modelSphere, pickHit } from '../src/viewer-state.mjs';
import { createConduction } from '../src/conduction.mjs';
import { createAnatomy } from '../src/anatomy.mjs';
import { contraction, createBeat, period, slowFactor } from '../src/heartbeat.mjs';
import { createFlow } from '../src/flow.mjs';

const bundle = readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url));
const probe = new THREE.Group(), probeParts = new Map();
createAnatomy(probe, probeParts, bundle, .033);
const bounds = modelSphere(probe);

const stats = list => {
  const s = [...list].sort((a, b) => a - b), at = q => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, medianMs: +at(.5).toFixed(3), p95Ms: +at(.95).toFixed(3), maxMs: +s.at(-1).toFixed(3) };
};
const time = fn => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };

// Same construction order as src/main.js: cross-section, conduction overlay, then the beat (so it deforms their geometry too).
function sceneAt(slider, eye) {
  const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
  heart.add(exterior);
  const meta = createAnatomy(exterior, parts, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), -slider);
  const section = createCrossSection(exterior, parts, plane, 0xc98478);
  section.setEnabled(true);
  exterior.add(conduction);
  const anchors = createConduction(conduction, parts, meta.conduction);
  const beat = createBeat(exterior, parts);
  heart.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(...eye).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  const occluders = [...parts.values()].filter(g => g.userData.kind !== 'conduction');
  return { heart, parts, plane, section, camera, anchors, conduction, occluders, exterior, meta, beat };
}

const ray = new THREE.Raycaster();
const labelWorld = (s, anchor) => s.conduction.localToWorld(new THREE.Vector3(...s.beat.displace(anchor)));
function labelRay(s, world) {
  const direction = world.clone().sub(s.camera.position);
  ray.set(s.camera.position, direction.normalize());
  return pickHit(ray, s.occluders, [s.plane], s.section.solids);
}

// ---- 1. hit tests on the deformed walls --------------------------------------------------------------------------------
// t = 50 ms: atria most contracted (ventricles 0). t = 370 ms: ventricles most contracted (end of ventricular systole).
const states = [['rest', 0], ['atria peak (t=50ms)', 50], ['ventricles peak (t=370ms)', 370]];
const eyes = [[0, .06, 1], [.5, .2, 1], [-.5, -.1, 1]], sliders = [0, .5, -.5];
const acc = Object.fromEntries(states.map(([name]) => [name, { label: [], clickOverlayOff: [], clickOverlayOn: [], clickOnCut: [] }]));
const perScene = [];
for (const slider of sliders) for (const eye of eyes) {
  const s = sceneAt(slider, eye);
  ray.params.Line.threshold = .08 / s.exterior.scale.x;
  for (const [name, t] of states) {
    const c = contraction(t);
    s.beat.set(c);
    s.heart.updateMatrixWorld(true); // the renderer does this before updateLabels() in the app
    const a = acc[name], sceneLabel = [], sceneClick = [];
    for (const [, anchor] of s.anchors) {
      const world = labelWorld(s, anchor);
      if (s.plane.distanceToPoint(world) < 0) continue;
      for (let i = 0; i < 5; i++) labelRay(s, world);
      for (let i = 0; i < 40; i++) { const [ms] = time(() => labelRay(s, world)); sceneLabel.push(ms); a.label.push(ms); }
    }
    for (const [key, overlay] of [['clickOverlayOff', false], ['clickOverlayOn', true]]) {
      s.conduction.visible = overlay;
      const targets = [...s.parts.values()].filter(g => g.userData.kind !== 'conduction' || s.conduction.visible);
      for (let i = 0; i < 20; i++) { ray.setFromCamera(new THREE.Vector2(0, 0), s.camera); pickHit(ray, targets, [s.plane], s.section.solids); }
      for (let x = -.6; x <= .6; x += .04) for (let y = -.7; y <= .7; y += .04) {
        ray.setFromCamera(new THREE.Vector2(x, y), s.camera);
        const [ms, hit] = time(() => pickHit(ray, targets, [s.plane], s.section.solids));
        a[key].push(ms); sceneClick.push(ms);
        if (hit?.onCut && key === 'clickOverlayOff') a.clickOnCut.push(ms);
      }
    }
    perScene.push({ slider, planeConstant: -slider, eye, state: name, contraction: c, label: stats(sceneLabel), click: stats(sceneClick) });
  }
}
const hitTests = Object.fromEntries(states.map(([name]) => {
  const a = acc[name];
  return [name, { label: stats(a.label), clickOverlayOff: stats(a.clickOverlayOff), clickOverlayOn: stats(a.clickOverlayOn), clickOnCutOverlayOff: stats(a.clickOnCut) }];
}));

// ---- 2. CPU work per frame while beating -------------------------------------------------------------------------------
const s = sceneAt(0, [0, .06, 1]);
ray.params.Line.threshold = .08 / s.exterior.scale.x;
const flow = createFlow(s.meta.flow);
// Created after the beat, as in src/main.js, so that createBeat does not deform them (helper objects).
const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(1.5, 12, 8), new THREE.MeshStandardMaterial(), flow.count);
dots.userData.helper = true;
s.exterior.add(dots);
const leaflets = Object.entries(flow.valves).map(([name, valve]) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(valve.vertexCount * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(valve.indices, 1));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  mesh.userData.helper = true;
  s.exterior.add(mesh);
  return { name, mesh, rest: new Float64Array(valve.vertexCount * 3), moved: [0, 0, 0] };
});
const dotPoint = [0, 0, 0], dotMatrix = new THREE.Matrix4();
function drawFlow() { // copy of drawFlow() in src/main.js
  for (let k = 0; k < flow.count; k++) {
    const size = flow.sample(k, dotPoint), p = s.beat.displace(dotPoint);
    dotMatrix.makeScale(size, size, size).setPosition(p[0], p[1], p[2]);
    dots.setMatrixAt(k, dotMatrix);
  }
  dots.instanceMatrix.needsUpdate = true;
  for (const { name, mesh, rest, moved } of leaflets) {
    flow.leaflets(name, rest);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      moved[0] = rest[3 * i]; moved[1] = rest[3 * i + 1]; moved[2] = rest[3 * i + 2];
      const p = s.beat.displace(moved);
      position.setXYZ(i, p[0], p[1], p[2]);
    }
    position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
}
const anchorList = [...s.anchors.values()];
const frameMs = 1000 / 60;
function simulate(realSpeed, beats) {
  const out = { advance: [], beatSet: [], drawFlow: [], label: [], interiorLabel: [], flowMode: [], interiorFlowOverlay: [] };
  const step = frameMs / (realSpeed ? 1 : slowFactor), frames = Math.round(beats * period / step);
  let beatTime = 0, k = 0;
  for (let f = -Math.round(period / step); f < frames; f++) { // the first beat is warm-up for the JIT and is not counted
    const next = beatTime + step, record = f >= 0;
    const [tAdv] = time(() => flow.advance(beatTime, next));
    beatTime = next;
    const [tSet] = time(() => s.beat.set(contraction(beatTime)));
    s.heart.updateMatrixWorld(true); // renderer.render does this in the app; not counted
    const [tDraw] = time(drawFlow);
    // updateLabels() casts the occlusion ray for the one selected label; the labels are taken in turn over the frames.
    let tLabel = 0;
    for (let tried = 0; tried < anchorList.length; tried++) {
      const world = labelWorld(s, anchorList[k++ % anchorList.length]);
      if (s.plane.distanceToPoint(world) < 0) continue;
      [tLabel] = time(() => labelRay(s, world));
      break;
    }
    if (record) {
      out.advance.push(tAdv); out.beatSet.push(tSet); out.drawFlow.push(tDraw); out.label.push(tLabel);
      out.interiorLabel.push(tAdv + tSet + tLabel);
      out.flowMode.push(tAdv + tSet + tDraw);
      out.interiorFlowOverlay.push(tAdv + tSet + tDraw + tLabel);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([key, list]) => [key, stats(list)]));
}
const frame = { slow: simulate(false, 2), real: simulate(true, 4) };

// vertices deformed by beat.set (unique geometries under the exterior group that are not helpers)
const seen = new Set();
let deformedVertices = 0;
(function visit(o) {
  if (o.userData.helper) return;
  if ((o.isMesh || o.isLine) && o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); deformedVertices += o.geometry.attributes.position.count; }
  o.children.forEach(visit);
})(s.exterior);

console.log(JSON.stringify({
  runtime: { node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length },
  frameBudgetMs: +frameMs.toFixed(2),
  beat: { period, slowFactor, deformedGeometries: seen.size, deformedVertices, flowParticles: flow.count },
  sliderToPlaneConstant: 'constant = -slider (src/main.js applyDepth)',
  hitTests, perScene, frame
}, null, 1));
