import * as THREE from 'three';

// Independently authored explanatory geometry. Widths and positions are exaggerated;
// this is not a dissection, tissue segmentation, or a BioDigital mesh derivative.
export function createConduction(parent, parts) {
  const definitions = [
    ['sa', '洞房結節', 'Sinoatrial node', '右心房の上部、上大静脈の入口付近にある特殊な心筋細胞の集まり。正常な拍動の電気刺激の起点です。', 0xffd479],
    ['atria', '心房への広がり', 'Atrial activation', '刺激が左右の心房の心筋へ広がります。破線は伝わる方向の概念図で、独立した一本の神経や血管ではありません。', 0xe6bc86],
    ['av', '房室結節', 'Atrioventricular node', '右心房の中隔側に位置し、刺激の伝わりをいったん遅くします。心房から心室へ血液が入る時間を確保します。', 0xffbc64],
    ['his', 'ヒス束', 'Bundle of His', '房室結節に続く刺激の通り道。心室中隔の上部へ進み、右脚と左脚に分かれます。', 0xffdf91],
    ['branches', '右脚・左脚', 'Bundle branches', '心室中隔の右側・左側を通って、それぞれの心室へ刺激を伝えます。画面の左右ではなく、身体の左右を基準に呼びます。', 0x87e5d4],
    ['purkinje', 'プルキンエ線維', 'Purkinje fibers', '心内膜の下に広がる特殊な心筋細胞のネットワーク。刺激を心室の心筋へ伝えます。枝の本数・太さ・位置は大きく簡略化しています。', 0x87e5d4],
  ];
  for (const [id, name, en, desc, color] of definitions) {
    const group = new THREE.Group();
    group.userData = { id, name, en, desc, color, kind: 'conduction' };
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
  function path(id, points, radius = .038, dashed = false) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    if (dashed) {
      const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(64));
      const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({color: parts.get(id).userData.color, dashSize: .09, gapSize: .065}));
      line.computeLineDistances();
      parts.get(id).add(line);
    } else {
      parts.get(id).add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, radius, 10, false), material(id)));
    }
  }
  node('sa', [-1.12, 1.25, .12], .105);
  node('av', [-.28, .44, .02], .095);
  path('atria', [[-1.12, 1.25, .12], [-.9, .8, .32], [-.55, .58, .18], [-.28, .44, .02]], .03, true);
  path('atria', [[-1.12, 1.25, .12], [-.5, 1.35, -.25], [.25, 1.2, -.55], [.62, .95, -.55]], .03, true);
  path('his', [[-.28, .44, .02], [-.1, .25, .12], [0, .02, .22]], .05);
  path('branches', [[0, .02, .22], [-.2, -.45, .36], [-.3, -1, .39], [-.18, -1.28, .4]]);
  path('branches', [[0, .02, .22], [.25, -.5, .03], [.43, -1.05, .07], [.6, -1.55, .08]]);
  for (const depth of [-.15, .32]) {
    path('purkinje', [[.6, -1.55, .08], [.94, -1.12, depth], [1.02, -.6, depth], [.9, -.22, depth]], .025);
    path('purkinje', [[.6, -1.55, .08], [.32, -1.28, depth], [.17, -.8, depth]], .025);
    path('purkinje', [[-.18, -1.28, .4], [-.6, -1.03, depth + .26], [-.87, -.57, depth + .26], [-.94, -.15, depth + .26]], .025);
  }
}
