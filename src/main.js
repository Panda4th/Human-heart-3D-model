import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const canvas=document.querySelector('canvas');
try {
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setClearColor(0x000000,0);
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(36,1,.1,100);
camera.position.set(0,1,10.8);
const controls=new OrbitControls(camera,canvas);controls.target.set(0,.4,0);controls.enableDamping=true;controls.minDistance=5;controls.maxDistance=16;controls.enablePan=false;
scene.add(new THREE.HemisphereLight(0xddeaff,0x27131b,2));
for(const [color,intensity,pos] of [[0xffd8bd,100,[4,5,6]],[0x8caeff,65,[-4,2,-3]]]){const l=new THREE.PointLight(color,intensity);l.position.set(...pos);scene.add(l);}
const heart=new THREE.Group();scene.add(heart);heart.rotation.z=-.13;
const parts=new Map();
const definitions=[
['lv','左心室','Left ventricle','全身へ血液を送り出す心室。外形を示す概形で、内腔は未実装。',0xb84d52],
['rv','右心室','Right ventricle','肺へ血液を送り出す心室。前面に広がる外形を簡略化して表示。',0xa75362],
['ra','右心房','Right atrium','全身から戻る血液を受け取る心房。',0x9a596b],
['la','左心房','Left atrium','肺から戻る血液を受け取る心房。主に背面に位置する。',0xc36a70],
['ao','大動脈','Aorta','左心室から全身へ向かう主要な血管。弓部と枝の形を簡略化。',0xd25d55],
['pa','肺動脈','Pulmonary artery','右心室から肺へ向かう血管。青は部位を見分けるための配色。',0x669caf],
['vc','大静脈','Venae cavae','全身から右心房へ戻る血管。上大静脈と下大静脈を表示。',0x637fa6],
['pv','肺静脈','Pulmonary veins','肺から左心房へ戻る血管。背面側に簡略化して配置。',0xc67878]];
for(const [id,name,en,desc,color] of definitions){const g=new THREE.Group();g.userData={id,name,en,desc};parts.set(id,g);heart.add(g);const b=document.createElement('button');b.className='part';b.innerHTML=`<i style="background:#${color.toString(16)}"></i>${name}<span>↗</span>`;b.onclick=()=>select(id);document.querySelector('#parts').append(b);g.userData.button=b;g.userData.color=color;}
function mat(g){return new THREE.MeshStandardMaterial({color:g.userData.color,roughness:.48,metalness:.05});}
function ellipsoid(id,pos,scale,tilt=0){const g=parts.get(id),geo=new THREE.SphereGeometry(1,64,48);const mesh=new THREE.Mesh(geo,mat(g));mesh.position.set(...pos);mesh.scale.set(...scale);mesh.rotation.z=tilt;g.add(mesh);return mesh;}
ellipsoid('lv',[.4,-.55,-.08],[.87,1.45,.77],.3);
ellipsoid('rv',[-.38,-.37,.49],[.86,1.07,.56],-.22);
ellipsoid('ra',[-.96,.8,-.05],[.59,.75,.58],-.12);
ellipsoid('la',[.35,.95,-.65],[.68,.58,.5]);
function tube(id,points,r){const g=parts.get(id),curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));const geo=new THREE.TubeGeometry(curve,64,r,20,false),mesh=new THREE.Mesh(geo,mat(g));g.add(mesh);
// Dark inset disks make the open ends legible without external textures.
for(const t of [0,1]){const disk=new THREE.Mesh(new THREE.CircleGeometry(r*.83,24),new THREE.MeshStandardMaterial({color:0x352730,side:THREE.DoubleSide}));disk.position.copy(curve.getPoint(t));disk.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),curve.getTangent(t));g.add(disk);}}
tube('ao',[[.1,.55,-.15],[.05,1.5,-.12],[.3,2.2,-.22],[.95,2.34,-.4],[1.3,1.7,-.65],[1.2,.3,-.9]],.27);
for(const x of [.36,.71,1.02])tube('ao',[[x,2.18,-.3],[x-.08,2.65,-.35],[x-.12,2.9,-.39]],.095);
tube('pa',[[-.38,.25,.6],[-.35,1.1,.65],[.06,1.7,.5],[.85,1.72,.1],[1.5,1.6,-.1]],.25);
tube('pa',[[.03,1.65,.46],[-.6,1.8,.1],[-1.4,1.5,-.3]],.2);
tube('vc',[[-1.04,.7,-.16],[-1.15,1.55,-.18],[-1.13,2.3,-.2]],.26);
tube('vc',[[-1.04,.7,-.2],[-1.12,-.2,-.35],[-1.08,-1.1,-.42]],.27);
for(const s of [-1,1])for(const y of [.65,1.13])tube('pv',[[s*.28,y,-.8],[s*.9,y,-1],[s*1.4,y+.12,-.9]],.15);
function select(id){for(const [key,g]of parts){g.userData.button.setAttribute('aria-pressed',String(key===id));g.traverse(o=>{if(o.isMesh)o.material.emissive?.setHex(key===id?0x40201b:0);});}const d=parts.get(id).userData;document.querySelector('#name').textContent=d.name;document.querySelector('#en').textContent=d.en;document.querySelector('#description').textContent=d.desc;}
const ray=new THREE.Raycaster();let start;canvas.addEventListener('pointerdown',e=>start=[e.clientX,e.clientY]);canvas.addEventListener('pointerup',e=>{if(!start||Math.hypot(e.clientX-start[0],e.clientY-start[1])>5)return;const r=canvas.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);const hit=ray.intersectObjects(heart.children,true)[0];if(hit){let o=hit.object;while(o&&!o.userData.id)o=o.parent;if(o)select(o.userData.id);}});
function reset(){controls.autoRotate=false;document.querySelector('#rotate').setAttribute('aria-pressed','false');camera.position.set(0,1,10.8);controls.target.set(0,.4,0);controls.update();}
document.querySelector('#reset').onclick=reset;
document.querySelector('#rotate').onclick=e=>{controls.autoRotate=!controls.autoRotate;controls.autoRotateSpeed=.8;e.currentTarget.setAttribute('aria-pressed',String(controls.autoRotate));};
for(const [id,delta]of [['in',.82],['out',1.22]])document.getElementById(id).onclick=()=>{const offset=camera.position.clone().sub(controls.target);offset.multiplyScalar(delta).clampLength(5,16);camera.position.copy(controls.target).add(offset);controls.update();};
new ResizeObserver(()=>{const r=canvas.getBoundingClientRect();renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}).observe(canvas);
document.addEventListener('visibilitychange',()=>{if(document.hidden){controls.autoRotate=false;document.querySelector('#rotate').setAttribute('aria-pressed','false');}});
renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
select('lv');document.documentElement.dataset.ready='true';
} catch(e){document.querySelector('#error').hidden=false;document.querySelector('#error').textContent='3D表示を開始できませんでした。WebGL対応のブラウザーで開いてください。';console.error(e);}
