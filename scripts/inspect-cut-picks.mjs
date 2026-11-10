import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCrossSection, fitDistance, modelSphere, pickHit, wallIds } from '../src/viewer-state.mjs';
import { createConduction } from '../src/conduction.mjs';
import { createAnatomy, decodeAnatomy } from '../src/anatomy.mjs';
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url));
// Same structure as src/main.js.
const heart = new THREE.Group(), exterior = new THREE.Group(), conduction = new THREE.Group(), parts = new Map();
heart.add(exterior);
const meta = createAnatomy(exterior, parts, bundle, .033);
exterior.add(conduction);
createConduction(conduction, parts, meta.conduction);
const bounds = modelSphere(heart);

function sectionScene(constant) {
  const root = new THREE.Group(), ext = new THREE.Group(), map = new Map();
  root.add(ext);
  createAnatomy(ext, map, bundle, .033);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), constant);
  const section = createCrossSection(ext, map, plane, 0xc98478);
  section.setEnabled(true);
  root.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 150);
  camera.position.set(0, .06, 1).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
  camera.lookAt(bounds.center); camera.updateMatrixWorld();
  return { map, plane, section, camera, targets: [...map.values()] };
}
const rayAt = (camera, x, y) => { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(x, y), camera); return r; };

// Use the same sampling and three-ray reference as tests/viewer-state.test.mjs.
function reproduce() {
  const directions = [[.31, -.77, -.55], [.9, .2, .1], [-.2, .5, .8]].map(d => new THREE.Vector3(...d).normalize()), n = new THREE.Vector3();
  const netOf = (point, direction, solid) => new THREE.Raycaster(point.clone().addScaledVector(direction, 1e-5), direction)
    .intersectObject(solid, false).reduce((sum, h) => sum + (n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(direction) > 0 ? 1 : -1), 0);
  const containing = (point, solidIds) => {
    const verdicts = solidIds.map(([solid, id]) => [id, directions.map(d => netOf(point, d, solid) !== 0)]);
    if (verdicts.some(([, v]) => new Set(v).size > 1)) return null;
    const inside = verdicts.filter(([, v]) => v[0]).map(([id]) => id);
    return inside.length === 1 ? inside[0] : null;
  };
  const rows = [];
  for (const constant of [0, -.5, .5]) for (const eye of [[0, .06, 1], [.5, .2, 1], [-.5, -.1, 1]]) {
    const { map, plane, section, camera, targets } = sectionScene(constant);
    camera.position.set(...eye).normalize().multiplyScalar(fitDistance(bounds.radius, 1)).add(bounds.center);
    camera.lookAt(bounds.center); camera.updateMatrixWorld();
    const solidIds = section.solids.map(solid => [solid, wallIds.find(id => map.get(id).getObjectById(solid.id))]);
    assert.ok(solidIds.every(([, id]) => id), 'every wall mesh belongs to one of the four chambers');
    const faceGroups = new Map(), skip = new Map(section.solids.map(solid => [solid,new Set()]));
    for (const solid of section.solids) {
      const {index, attributes:{position}} = solid.geometry;
      const key = i => [position.getX(i), position.getY(i), position.getZ(i)].map(v=>Math.round(v*100)).join(',');
      for(let i=0; i<index.count; i+=3) {
        const keyOfFace=[0,1,2].map(j=>key(index.getX(i+j))).sort().join('|');
        if(!faceGroups.has(keyOfFace)) faceGroups.set(keyOfFace,[]);
        faceGroups.get(keyOfFace).push([solid,i/3]);
      }
    }
    for(const group of faceGroups.values()) if(group.length>1) for(const [solid,face] of group) skip.get(solid).add(face);
    for (let x = -.6; x <= .6; x += .04) for (let y = -.7; y <= .7; y += .04) {
      const ray = rayAt(camera, x, y);
      if (plane.distanceToPoint(ray.ray.origin) >= 0) continue;
      const point = ray.ray.intersectPlane(plane, new THREE.Vector3());
      const expected = point && containing(point, solidIds);
      if (!expected) continue;
      const got = pickHit(ray, targets, [plane], section.solids);
      const inner = new THREE.Raycaster(point.clone().addScaledVector(ray.ray.direction,1e-5),ray.ray.direction);
      const hits = inner.intersectObjects(section.solids,false).map(h=>({
        id:h.object.parent.userData.id, face:h.faceIndex, distance:h.distance/.033,
        sign:n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(ray.ray.direction)>0?1:-1,
        duplicate:skip.get(h.object).has(h.faceIndex)
      }));
      const classify = list => {
        const net=Object.fromEntries(wallIds.map(id=>[id,0]));
        for(const h of list) net[h.id]+=h.sign;
        const sum=Object.values(net).reduce((a,b)=>a+b,0);
        return {net,sum,first:list[0]?.id,firstNet:list.find(h=>net[h.id]!==0)?.id,firstPositive:list.find(h=>net[h.id]>0)?.id,
          firstExit:list.find(h=>net[h.id]>0&&h.sign>0)?.id};
      };
      const current=classify(hits), masked=classify(hits.filter(h=>!h.duplicate));
      const refsWithDuplicates=solidIds.flatMap(([solid,id])=>directions.map((d,j)=>{
        const ray=new THREE.Raycaster(point.clone().addScaledVector(d,1e-5),d);
        const duplicateHits=ray.intersectObject(solid,false).filter(h=>skip.get(solid).has(h.faceIndex));
        return {id,j,count:duplicateHits.length};
      })).filter(h=>h.count>0);
      rows.push({constant,eye,x,y,point:point.toArray(),expected,got:got?.id,onCut:got?.onCut,current,masked,hits,refsWithDuplicates});
    }
  }
  return rows;
}

const rows = reproduce();
const wallMeshes = wallIds.map(id => [id, parts.get(id).children[0]]);
const cavities = decodeAnatomy(bundle).parts.filter(part => wallIds.some(id => part.id === 'cav' + id)).map(part => {
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(part.positions,3));
  geometry.setIndex(new THREE.BufferAttribute(part.indices,1));
  return [part.id.slice(3), {geometry}];
});
const localMatrix = new THREE.Matrix4().copy(exterior.matrixWorld).invert();
const point = new THREE.Vector3(), closest = new THREE.Vector3();
const triangle = new THREE.Triangle();
function distances(meshes, sample) {
  return Object.fromEntries(meshes.map(([id, mesh]) => {
    const {index,attributes:{position}}=mesh.geometry;
    let min=Infinity;
    for(let face=0;face<index.count;face+=3) {
      triangle.a.fromBufferAttribute(position,index.getX(face));
      triangle.b.fromBufferAttribute(position,index.getX(face+1));
      triangle.c.fromBufferAttribute(position,index.getX(face+2));
      triangle.closestPointToPoint(sample,closest);
      min=Math.min(min,closest.distanceToSquared(sample));
    }
    return [id,Math.sqrt(min)];
  }));
}
const independent = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,1,1],[-1,1,1],[1,-1,1],[1,1,-1],[-1,-1,1],[-1,1,-1],[1,-1,-1],[-1,-1,-1]]
  .map(v=>new THREE.Vector3(...v).normalize());
const n = new THREE.Vector3();
function windings(sample) {
  return independent.map(dir=>{
    const ray=new THREE.Raycaster(sample.clone().addScaledVector(dir,1e-5),dir);
    return Object.fromEntries(wallMeshes.map(([id, mesh])=>[id,ray.intersectObject(mesh,false)
      .reduce((sum,h)=>sum+(n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(dir)>0?1:-1),0)]));
  });
}
const nearest = entries => Object.entries(entries).sort((a,b)=>a[1]-b[1])[0][0];
let wallMs=0, cavityMs=0, windingMs=0;
for(const row of rows) {
  const sample=point.fromArray(row.point), local=sample.clone().applyMatrix4(localMatrix);
  let begin=performance.now();
  const wall=distances(wallMeshes,local);
  wallMs+=performance.now()-begin;
  begin=performance.now();
  const cavity=distances(cavities,local);
  cavityMs+=performance.now()-begin;
  begin=performance.now();
  const wind=windings(sample);
  windingMs+=performance.now()-begin;
  const votes=Object.fromEntries(wallIds.map(id=>[id,wind.filter(w=>w[id]!==0).length]));
  const majority=Object.entries(votes).sort((a,b)=>b[1]-a[1]);
  console.log(JSON.stringify({...row,wall,cavity,nearestWall:nearest(wall),nearestCavity:nearest(cavity),votes,majority:majority[0][1]>majority[1][1]?majority[0][0]:row.got}));
}
console.error({count:rows.length,wallMs,cavityMs,windingMs});
