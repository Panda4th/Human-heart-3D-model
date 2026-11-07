import * as THREE from 'three';

// Decode the bundle written by scripts/prepare-bodyparts3d.mjs.
// Kept free of WebGL so Node tests can check the data.
export function decodeAnatomy(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'BP3D') throw new Error('Not a BodyParts3D heart bundle');
  const jsonLength = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
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
  ['ao', '大動脈', 'Aorta', '左心室から全身へ向かう血管。上行大動脈、大動脈弓、下行大動脈の一部と、弓部の枝の根元を表示。', 0xd25d55],
  ['pa', '肺動脈', 'Pulmonary arteries', '右心室から肺へ向かう肺動脈幹と左右の肺動脈。肺の手前で切っています。青は識別用の配色です。', 0x669caf],
  ['vc', '大静脈', 'Venae cavae', '全身から右心房へ戻る上大静脈と下大静脈。心臓の近くだけを表示。', 0x637fa6],
  ['pv', '肺静脈', 'Pulmonary veins', '肺から左心房へ戻る4本の肺静脈。肺の外の部分だけを表示。', 0xc67878],
  ['ca', '冠動脈', 'Coronary arteries', '心臓の筋肉に血液を送る血管。左右の冠動脈と主な枝を表示。', 0xe07a4f],
  ['cv', '冠静脈', 'Cardiac veins', '心臓の筋肉から血液を回収する静脈。冠静脈洞へ集まります。', 0x7a8fc4],
];

export function createAnatomy(parent, parts, bytes, scale) {
  const { parts: meshes } = decodeAnatomy(bytes);
  const byId = new Map(meshes.map(m => [m.id, m]));
  for (const [id, name, en, desc, color] of anatomyDefinitions) {
    const group = new THREE.Group();
    group.userData = { id: `bp-${id}`, name, en, desc, color, kind: 'anatomy' };
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
  for (const id of ['lv', 'rv', 'ra', 'la']) wall.expandByObject(parts.get(`bp-${id}`));
  const center = wall.getCenter(new THREE.Vector3());
  parent.scale.setScalar(scale);
  parent.position.copy(center).multiplyScalar(-scale);
}
