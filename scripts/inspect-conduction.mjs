// Export the actual static viewer meshes for offline diagnostic rendering.
// Run from repository root: node scripts/inspect-conduction.mjs <output.json>
import * as THREE from 'three';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeAnatomy} from '../src/anatomy.mjs';
import {createConduction} from '../src/conduction.mjs';

const bytes = new Uint8Array(await readFile('src/data/bodyparts3d-heart.bin'));
const {meta, parts} = decodeAnatomy(bytes);
const root = new THREE.Group(), groups = new Map();
createConduction(root, groups, meta.conduction);
root.updateMatrixWorld(true);
const selected = ['av','his','bhis','rbb','lbb','purkinje'];
const meshes = parts.filter(p=>['aov','tv','mv','pm'].includes(p.id)).map(p=>({id:p.id,positions:Array.from(p.positions),indices:Array.from(p.indices)}));
for (const id of selected) groups.get(id).traverse(o=>{
  if(!o.isMesh) return;
  const g=o.geometry.clone().applyMatrix4(o.matrixWorld);
  meshes.push({id,positions:Array.from(g.attributes.position.array),indices:Array.from(g.index.array)});
});
const paths=meta.conduction.paths;
const intervals = Object.fromEntries([['proximal', paths.his[0]],['branching',paths.branchingHis[0]]].map(([id,points])=>{
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));
  return [id,{points,delta:points.at(-1).map((v,i)=>v-points[0][i]),straightMm:new THREE.Vector3(...points[0]).distanceTo(new THREE.Vector3(...points.at(-1))),viewerCurveMm:curve.getLength()}];
}));
// Distances from proxy points to the simplified displayed leaflet triangles, not anatomical hinge planes.
function distance(point, mesh) {
  const q=new THREE.Vector3(...point), p=mesh.positions, idx=mesh.indices, t=new THREE.Triangle(), hit=new THREE.Vector3();
  let best=Infinity;
  for(let i=0;i<idx.length;i+=3){
    t.a.fromArray(p,idx[i]*3);t.b.fromArray(p,idx[i+1]*3);t.c.fromArray(p,idx[i+2]*3);
    t.closestPointToPoint(q,hit);best=Math.min(best,q.distanceTo(hit));
  }
  return best;
}
const anchors={A:meta.conduction.nodes.av,B:meta.conduction.junctions.leftOrigin,C:meta.conduction.junctions.rightOrigin};
const report={schema:1,unit:'mm',axes:{x:'body left',y:'superior',z:'anterior'},
  dataSha256:createHash('sha256').update(bytes).digest('hex'),
  indexSha256:createHash('sha256').update(await readFile('index.html')).digest('hex'),
  anchors,intervals,proxyToDisplayedLeafletMm:Object.fromEntries(Object.entries(anchors).map(([id,p])=>[id,Object.fromEntries(['aov','tv','mv'].map(v=>[v,distance(p,parts.find(m=>m.id===v))]))])),
  meshes};
await writeFile(process.argv[2]||'/tmp/conduction.json',JSON.stringify(report));
