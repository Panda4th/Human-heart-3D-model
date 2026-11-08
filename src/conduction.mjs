import * as THREE from 'three';

// Explanatory overlay in BodyParts3D millimetres. BodyParts3D has no conduction-system meshes,
// so scripts/prepare-bodyparts3d.mjs places these points from nearby cavities and valves.
// Widths are exaggerated; this is not a dissection, tissue segmentation, or a BioDigital mesh derivative.
export const conductionDefinitions = [
  ['sa', '洞房結節', 'Sinoatrial node', '右心房の上部、上大静脈の入口付近にある特殊な心筋細胞の集まり。正常な拍動の電気刺激の起点です。ここでは下方へ延びる細長い形に簡略化しています。長さと幅はStephensonら（2017）の1標本を参考にした目安で、分界稜に沿う実際の形状や向きは未再現です。', 0xffd479],
  ['atria', '心房への広がり', 'Atrial activation', '刺激が左右の心房の心筋へ広がります。破線は伝わる方向の概念図で、独立した一本の神経や血管ではありません。', 0xe6bc86],
  ['av', '房室結節', 'Atrioventricular node', '右心房の中隔側、コッホの三角（冠静脈洞の入口、三尖弁中隔尖の付け根、トダロ腱に囲まれた範囲）の頂点付近にあり、刺激の伝わりをいったん遅くします。心房から心室へ血液が入る時間を確保します。ここでは中隔尖の付け根のうち大動脈弁に最も近い点に置いています。', 0xffbc64],
  ['his', 'ヒス束（近位区間）', 'His bundle: proximal interval', '房室結節側から左脚側の目印までを結ぶ模式区間です。貫通部を含む近位側の関係を示しますが、実際の貫通部と分岐部の境界は同定していないため、この区切りとは一致しません。次の分岐区間へ連続します。', 0xffdf91],
  ['bhis', 'ヒス束（分岐区間）', 'His bundle: branching interval', '左脚側の目印から右脚側の目印へ続く模式区間です。実際には左脚が分岐部から幅広く出て、その先が右脚へ続きます（Kawashima・Sato、2021）。ここでは左脚を手前側の1点から出る線に省略しています。区間の端は組織の境界を確認した位置ではありません。', 0xe8a55b],
  ['rbb', '右脚', 'Right bundle branch', 'ヒス束の分岐区間の先から、心室中隔の右心室側を通り、右心室の前乳頭筋の付け根へ向かう通り道。ここでは1本の線に簡略化しています。身体の右側を基準に呼びます（画面の右ではありません）。', 0x7fb2ff],
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
  // Stephenson 2017: main body 14.8 x 4.3 mm in one specimen. The terminal crest
  // is not segmented here: use the body inferior axis as an explicit schematic direction.
  // Keep the anchor in the superior head, and extend the body mainly caudally.
  const sinus = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material('sa'));
  sinus.scale.set(2.15, 7.4, 2.15);
  sinus.position.set(nodes.sa[0], nodes.sa[1] - 5.25, nodes.sa[2]);
  parts.get('sa').add(sinus);
  node('av', nodes.av, 2.9);
  for (const p of paths.atria) path('atria', p, 0, true);
  for (const p of paths.his) path('his', p, 1.5);
  for (const p of paths.branchingHis) path('bhis', p, 1.5);
  // paths.branches is [left, right] in the generated data; each gets its own part so it can be selected and shown alone.
  path('lbb', paths.branches[0], 1.15);
  path('rbb', paths.branches[1], 1.15);
  for (const p of paths.purkinje) path('purkinje', p, .75);
  // Label positions in the same millimetre frame.
  const middle = p => p[Math.floor(p.length / 2)];
  const curveMiddle = p => new THREE.CatmullRomCurve3(p.map(q => new THREE.Vector3(...q))).getPointAt(.5).toArray();
  return new Map([
    ['sa', nodes.sa], ['atria', middle(paths.atria[0])], ['av', nodes.av], ['his', curveMiddle(paths.his[0])], ['bhis', curveMiddle(paths.branchingHis[0])],
    ['rbb', middle(paths.branches[1])], ['lbb', middle(paths.branches[0])], ['purkinje', middle(paths.purkinje[0])],
  ]);
}
