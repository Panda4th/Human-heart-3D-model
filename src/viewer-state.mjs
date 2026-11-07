import { BackSide, Box3, FrontSide, Group, Mesh, MeshBasicMaterial, Sphere, Vector3 } from 'three';

// Keep framing and gesture decisions independent of WebGL for regression tests.
// The sphere is measured from vertices: the box's circumscribed sphere was about 25% larger
// than the model and left it small on screen. Any orbit angle still keeps every vertex inside.
export function modelSphere(object) {
  object.updateMatrixWorld(true);
  const center = new Box3().setFromObject(object).getCenter(new Vector3()), p = new Vector3();
  let radius = 0;
  object.traverse(o => {
    const positions = o.geometry?.attributes.position;
    if (positions) for (let i = 0; i < positions.count; i++) radius = Math.max(radius, o.localToWorld(p.fromBufferAttribute(positions, i)).distanceTo(center));
  });
  return new Sphere(center, radius);
}
export function fitDistance(radius, aspect, verticalFovDegrees = 36) {
  const vertical = verticalFovDegrees * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.01));
  return radius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
}

// Interior view. Each exterior mesh gets a clipped, front-faces-only copy (shown instead of the
// original) and a flat back-face cap. Only the cap draws the faces seen through the cut, so the
// cut face never depends on two meshes drawn at the same depth. Switching modes only toggles
// visibility, so no material changes and no shader recompiles.
export function createCrossSection(parent, parts, plane, capColor) {
  const caps = new Group(), originals = [], copies = [];
  const capMaterial = new MeshBasicMaterial({ color: capColor, side: BackSide, clippingPlanes: [plane] });
  for (const group of parts.values()) {
    if (group.userData.kind === 'interior') group.traverse(o => { if (o.isMesh) o.material.clippingPlanes = [plane]; });
    if (group.userData.kind !== 'exterior') continue;
    for (const object of [...group.children].filter(o => o.isMesh)) {
      const material = object.material.clone();
      Object.assign(material, { side: FrontSide, clippingPlanes: [plane] });
      const copy = new Mesh(object.geometry, material);
      copy.userData.crossSection = true;
      group.add(copy);
      const cap = new Mesh(object.geometry, capMaterial);
      cap.raycast = () => {};
      caps.add(cap);
      originals.push(object);
      copies.push(copy);
    }
  }
  parent.add(caps);
  const setEnabled = on => {
    caps.visible = on;
    for (const o of originals) o.visible = !on;
    for (const o of copies) o.visible = on;
    for (const group of parts.values()) if (group.userData.kind === 'interior') group.visible = on;
  };
  setEnabled(false);
  return { setEnabled };
}

const isShown = object => { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; };
// Raycasting ignores visibility and clipping planes. Return the id of the first part hit that is
// actually drawn: shown, and not on the side the cross-section has removed.
export function pickPart(raycaster, targets, planes = []) {
  for (const hit of raycaster.intersectObjects(targets, true)) {
    if (!isShown(hit.object) || !planes.every(plane => plane.distanceToPoint(hit.point) >= 0)) continue;
    let object = hit.object;
    while (object && !object.userData.id) object = object.parent;
    if (object) return object.userData.id;
  }
}

export class TapGesture {
  pointers = new Set();
  candidate = null;
  down(id, x, y) {
    this.pointers.add(id);
    this.candidate = this.pointers.size === 1 ? { id, x, y } : null;
  }
  move(id, x, y) {
    const c = this.candidate;
    if (c?.id === id && Math.hypot(x - c.x, y - c.y) > 5) this.candidate = null;
  }
  up(id, x, y) {
    this.move(id, x, y);
    const tap = this.pointers.size === 1 && this.candidate?.id === id;
    this.pointers.delete(id);
    this.candidate = null;
    return Boolean(tap);
  }
  cancel(id) {
    this.pointers.delete(id);
    this.candidate = null;
  }
}
