import * as THREE from 'three';

// Explanatory overlay in BodyParts3D millimetres. BodyParts3D has no conduction-system meshes,
// so scripts/prepare-bodyparts3d.mjs places these points from nearby cavities and valves.
// Widths are exaggerated; this is not a dissection, tissue segmentation, or a BioDigital mesh derivative.
export const conductionDefinitions = [
  ['sa', '洞房結節', 'Sinoatrial node', '右心房の上部、上大静脈の入口付近にある特殊な心筋細胞の集まり。正常な拍動の電気刺激の起点です。', 0xffd479],
  ['atria', '心房への広がり', 'Atrial activation', '刺激が左右の心房の心筋へ広がります。破線は伝わる方向の概念図で、独立した一本の神経や血管ではありません。', 0xe6bc86],
  ['av', '房室結節', 'Atrioventricular node', '右心房の中隔側、冠静脈洞の入口と三尖弁の間に位置し、刺激の伝わりをいったん遅くします。心房から心室へ血液が入る時間を確保します。', 0xffbc64],
  ['his', 'ヒス束', 'Bundle of His', '房室結節に続く刺激の通り道。心室中隔の上部へ進み、右脚と左脚に分かれます。', 0xffdf91],
  ['rbb', '右脚', 'Right bundle branch', '心室中隔の右心室側を通り、右心室の前乳頭筋の付け根へ向かう通り道。ここでは1本の線に簡略化しています。身体の右側を基準に呼びます（画面の右ではありません）。', 0x7fb2ff],
  ['lbb', '左脚', 'Left bundle branch', '心室中隔の左心室側を通り、心尖へ向かう通り道。実際の左脚は幅の広い板状で前・中隔・後ろの3つの束に分かれますが、ここでは1本の線に簡略化しています（Stephensonら2017の記述）。身体の左側を基準に呼びます。', 0x4fdcc4],
  ['purkinje', 'プルキンエ線維', 'Purkinje fibers', '心内膜の下に広がる特殊な心筋細胞のネットワーク。刺激を心室の心筋へ伝えます。左心室2本・右心室2本の線に大きく簡略化しており、本数・太さ・位置は実際と異なります。脚（青緑・青）とは別の色（薄紫）で表します。', 0xd6b3ff],
];

export function createConduction(parent, parts, data) {
  for (const [id, name, en, desc, color] of conductionDefinitions) {
    const group = new THREE.Group();
    group.userData = { id, name, en, desc, color, kind: 'conduction', modes: ['conduction'] };
    parts.set(id, group);
    parent.add(group);
  }
  const material = id => new THREE.MeshStandardMaterial({
    color: parts.get(id).userData.color, emissive: parts.get(id).userData.color,
    emissiveIntensity: .25, roughness: .65,
  });
  function node(id, point, radius) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), material(id));
    mesh.position.set(...point);
    parts.get(id).add(mesh);
  }
  function path(id, points, radius, dashed = false) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    if (dashed) {
      const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(64));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: parts.get(id).userData.color, dashSize: 2.7, gapSize: 2 }));
      line.computeLineDistances();
      parts.get(id).add(line);
    } else {
      parts.get(id).add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 10, false), material(id)));
    }
  }
  const { nodes, paths } = data;
  node('sa', nodes.sa, 3.2);
  node('av', nodes.av, 2.9);
  for (const p of paths.atria) path('atria', p, 0, true);
  for (const p of paths.his) path('his', p, 1.5);
  // paths.branches is [left, right] in the generated data; each gets its own part so it can be selected and shown alone.
  path('lbb', paths.branches[0], 1.15);
  path('rbb', paths.branches[1], 1.15);
  for (const p of paths.purkinje) path('purkinje', p, .75);
  // Label positions in the same millimetre frame.
  const middle = p => p[Math.floor(p.length / 2)];
  return new Map([
    ['sa', nodes.sa], ['atria', middle(paths.atria[0])], ['av', nodes.av], ['his', middle(paths.his[0])],
    ['rbb', middle(paths.branches[1])], ['lbb', middle(paths.branches[0])], ['purkinje', middle(paths.purkinje[0])],
  ]);
}
