import * as THREE from 'three';

// Decode the bundle written by scripts/prepare-bodyparts3d.mjs.
// Kept free of WebGL so Node tests can check the data.
// Format 4 separates proximal/branching His intervals and left/right take-off proxies.
export const anatomyFormat = 4;
export function decodeAnatomy(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'BP3D') throw new Error('Not a BodyParts3D heart bundle');
  const jsonLength = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
  if (meta.format !== anatomyFormat) throw new Error(`Heart bundle format ${meta.format}, expected ${anatomyFormat}`);
  const body = bytes.byteOffset + 8 + jsonLength;
  const parts = meta.parts.map(p => {
    const raw = new Int16Array(bytes.buffer.slice(body + p.positionOffset, body + p.positionOffset + p.vertices * 6));
    const positions = Float32Array.from(raw, (v, i) => v * meta.step + meta.center[i % 3]);
    const indices = new Uint16Array(bytes.buffer.slice(body + p.indexOffset, body + p.indexOffset + p.indices * 2));
    return { id: p.id, positions, indices };
  });
  return { meta, parts };
}

// Simplified from BodyParts3D (DBCLS). Chamber boundaries on the heart wall are estimated
// from the nearest chamber cavity, so they are approximate.
export const anatomyDefinitions = [
  ['lv', '左心室', 'Left ventricle', '全身へ血液を送り出す心室。心臓の壁を、最も近い内腔で自動的に区分けしたため、境界は目安です。', 0xb84d52],
  ['rv', '右心室', 'Right ventricle', '肺へ血液を送り出す心室。前面の多くを占めます。境界は内腔からの距離で推定しています。', 0xa75362],
  ['ra', '右心房', 'Right atrium', '全身から戻る血液を受け取る心房。右心耳を含みます。境界は推定です。', 0x9a596b],
  ['la', '左心房', 'Left atrium', '肺から戻る血液を受け取る心房。主に背面に位置します。境界は推定です。', 0xc36a70],
  ['ao', '大動脈', 'Aorta', '左心室から全身へ向かう血管。上行大動脈、大動脈弓、下行大動脈の一部と、弓部から出る3本の枝（腕頭動脈、左総頸動脈、左鎖骨下動脈）の根元を表示。', 0xd25d55],
  ['pa', '肺動脈', 'Pulmonary arteries', '右心室から肺へ向かう肺動脈幹と左右の肺動脈。肺の手前で切っています。青は識別用の配色です。', 0x669caf],
  ['vc', '大静脈', 'Venae cavae', '全身から右心房へ戻る上大静脈と下大静脈。心臓の近くだけを表示。', 0x637fa6],
  ['pv', '肺静脈', 'Pulmonary veins', '肺から左心房へ戻る4本の肺静脈。肺の外の部分だけを表示。', 0xc67878],
  ['ca', '冠動脈', 'Coronary arteries', '心臓の筋肉に血液を送る血管。左右の冠動脈と主な枝を表示。', 0xe07a4f],
  ['cv', '冠静脈', 'Cardiac veins', '心臓の筋肉から血液を回収する静脈。冠静脈洞へ集まります。', 0x7a8fc4],
];

// Shown only in the interior (cross-section) view. From BodyParts3D 4.0, whose leaflet meshes
// include thread-like strands that look like chordae tendineae; they are not separated.
export const interiorDefinitions = [
  ['mv', '僧帽弁', 'Mitral valve', '左心房と左心室の間の弁。前尖と後尖の2枚の弁尖からなり、左心室が縮むときに血液が左心房へ戻るのを防ぎます。乳頭筋へ伸びる糸状の部分は腱索とみられますが、元データでは弁尖と同じ部品のため区別していません。', 0xead2b0],
  ['tv', '三尖弁', 'Tricuspid valve', '右心房と右心室の間の弁。前尖・後尖・中隔尖の3枚の弁尖からなり、右心室が縮むときに血液が右心房へ戻るのを防ぎます。糸状の部分は腱索とみられますが、弁尖と区別していません。', 0xd8c39d],
  ['aov', '大動脈弁', 'Aortic valve', '左心室と大動脈の間の弁。半月形の3枚の弁尖からなり、左心室が緩むときに大動脈から血液が戻るのを防ぎます。', 0xf3e1c4],
  ['pov', '肺動脈弁', 'Pulmonary valve', '右心室と肺動脈の間の弁。半月形の3枚の弁尖からなり、右心室が緩むときに肺動脈から血液が戻るのを防ぎます。', 0xbfd6d0],
  ['pm', '乳頭筋', 'Papillary muscles', '心室の内壁から突き出た筋肉。腱索を介して僧帽弁と三尖弁の弁尖を支え、心室が縮むときに弁尖が心房側へ反り返るのを防ぎます。元データにあるのは右心室の3つと、左心室の外側乳頭筋（前外側の頭を含む）だけです。左心室にはふつう前と後ろの2つがありますが、後ろの乳頭筋は元データにないため表示していません。', 0xd27a6c],
];
const chambers = ['lv', 'rv', 'ra', 'la'];

export function createAnatomy(parent, parts, bytes, scale) {
  const { meta, parts: meshes } = decodeAnatomy(bytes);
  const byId = new Map(meshes.map(m => [m.id, m]));
  const definitions = [...anatomyDefinitions.map(d => [...d, 'exterior']), ...interiorDefinitions.map(d => [...d, 'interior'])];
  for (const [id, name, en, desc, color, kind] of definitions) {
    const group = new THREE.Group();
    // modes lists the view modes in which this part can be selected.
    const modes = kind === 'interior' ? ['interior'] : chambers.includes(id) ? ['exterior', 'interior'] : ['exterior'];
    group.userData = { id, name, en, desc, color, kind, modes };
    const mesh = byId.get(id);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .62, metalness: 0, side: THREE.DoubleSide })));
    parts.set(group.userData.id, group);
    parent.add(group);
  }
  // Centre on the heart wall and convert millimetres to viewer units.
  const wall = new THREE.Box3();
  for (const id of chambers) wall.expandByObject(parts.get(id));
  const center = wall.getCenter(new THREE.Vector3());
  parent.scale.setScalar(scale);
  parent.position.copy(center).multiplyScalar(-scale);
  return meta;
}
