import {
  AlwaysStencilFunc, BackSide, Box3, DecrementWrapStencilOp, DoubleSide, FrontSide, Group, IncrementWrapStencilOp, Matrix4, Mesh,
  MeshBasicMaterial, NotEqualStencilFunc, PlaneGeometry, Raycaster, ReplaceStencilOp, Sphere, Vector3,
} from 'three';
import { chambers } from './anatomy.mjs';

// Keep framing and gesture decisions independent of WebGL for regression tests.
// The sphere is measured from vertices: the box's circumscribed sphere was about 25% larger
// than the model and left it small on screen. Any orbit angle still keeps every vertex inside.
export function modelSphere(object) {
  object.updateMatrixWorld(true);
  const p = new Vector3(), box = new Box3(), points = [];
  // Helpers (the cut face is thousands of millimetres wide) do not count as model.
  const visit = o => {
    if (o.userData.helper) return;
    const positions = o.geometry?.attributes.position;
    if (positions) for (let i = 0; i < positions.count; i++) points.push(o.localToWorld(new Vector3().fromBufferAttribute(positions, i)));
    o.children.forEach(visit);
  };
  visit(object);
  for (const point of points) box.expandByPoint(point);
  const center = box.getCenter(new Vector3());
  let radius = 0;
  for (const point of points) radius = Math.max(radius, point.distanceTo(center));
  return new Sphere(center, radius);
}
// Vertical field of view of the camera, in degrees.
export const fieldOfView = 36;
export function fitDistance(radius, aspect, verticalFovDegrees = fieldOfView) {
  const vertical = verticalFovDegrees * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.01));
  return radius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
}

// Interior view. Every exterior mesh is shown as a clipped copy (the original is hidden), and the
// cut face of the heart wall is a real quad lying on the cutting plane, drawn with the stencil
// technique: the wall's faces behind the plane are counted per pixel (back faces +1, front faces -1),
// and the quad is drawn where the count is not zero, i.e. where the plane passes through the wall
// material. The count is 0 inside a cavity, so cavities are not painted like tissue.
// Vessels in the data are thin shells without wall thickness, so they get no cut face: the clipped
// shell is drawn on both sides and the lumen stays visible.
// Switching modes only toggles visibility, so no material changes and no shader recompiles.
export const wallIds = chambers;
// Colour of the cut face of the heart wall (the cap colour given to createCrossSection).
export const cutColor = 0xc98478;
export function createCrossSection(parent, parts, plane, capColor, regionColor = 0xffc79e) {
  const caps = new Group(), originals = [], copies = [], solids = [], regions = new Map();
  const stencil = (side, op) => new MeshBasicMaterial({
    side, colorWrite: false, depthWrite: false, depthTest: false, clippingPlanes: [plane],
    stencilWrite: true, stencilFunc: AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
  });
  const behind = stencil(BackSide, IncrementWrapStencilOp), ahead = stencil(FrontSide, DecrementWrapStencilOp);
  for (const group of parts.values()) {
    if (group.userData.kind === 'interior') group.traverse(o => { if (o.isMesh) o.material.clippingPlanes = [plane]; });
    if (group.userData.kind !== 'exterior') continue;
    const wall = wallIds.includes(group.userData.id);
    for (const object of [...group.children].filter(o => o.isMesh)) {
      const material = object.material.clone();
      Object.assign(material, { side: wall ? FrontSide : DoubleSide, clippingPlanes: [plane] });
      const copy = new Mesh(object.geometry, material);
      copy.userData.crossSection = true;
      group.add(copy);
      if (wall) {
        for (const m of [behind, ahead]) {
          const count = new Mesh(object.geometry, m);
          count.renderOrder = 10;
          count.raycast = () => {};
          caps.add(count);
        }
        // The selected chamber's own cut region: the same count on this chamber's shell alone, drawn after the
        // common face, with a brighter quad. Hidden until setRegion shows it.
        const own = [behind, ahead].map(m => {
          const count = new Mesh(object.geometry, m);
          Object.assign(count, { renderOrder: 12, visible: false });
          count.raycast = () => {};
          caps.add(count);
          return count;
        });
        regions.set(group.userData.id, [...(regions.get(group.userData.id) || []), ...own]);
        solids.push(object);
      }
      originals.push(object);
      copies.push(copy);
    }
  }
  // The quad is not clipped. Its ops reset the stencil wherever it is drawn or rejected, so the buffer is clean for the next frame.
  const quad = (color, renderOrder) => {
    const q = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({
      color, side: DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: NotEqualStencilFunc,
      stencilFail: ReplaceStencilOp, stencilZFail: ReplaceStencilOp, stencilZPass: ReplaceStencilOp,
    }));
    Object.assign(q, { renderOrder, frustumCulled: false });
    q.raycast = () => {};
    q.scale.setScalar(5000);
    caps.add(q);
    return q;
  };
  const face = quad(capColor, 11), regionFace = quad(regionColor, 13);
  regionFace.visible = false;
  caps.userData.helper = true;
  parent.add(caps);
  const z = new Vector3(0, 0, 1);
  // The plane is given in world space; the heart group may be scaled and moved, so place the quad in its frame.
  const update = () => {
    parent.updateWorldMatrix(true, false);
    const local = plane.clone().applyMatrix4(new Matrix4().copy(parent.matrixWorld).invert());
    for (const q of [face, regionFace]) {
      local.coplanarPoint(q.position);
      q.quaternion.setFromUnitVectors(z, local.normal);
      q.updateMatrixWorld(true);
    }
  };
  // Show the cut region of one chamber (lv, rv, ra or la) in a brighter colour; any other id clears it.
  const setRegion = id => {
    for (const [key, meshes] of regions) for (const m of meshes) m.visible = key === id;
    regionFace.visible = regions.has(id);
  };
  const setEnabled = on => {
    caps.visible = on;
    for (const o of originals) o.visible = !on;
    for (const o of copies) o.visible = on;
    for (const group of parts.values()) if (group.userData.kind === 'interior') group.visible = on;
    if (on) update();
    else setRegion(null);
  };
  setEnabled(false);
  return { setEnabled, update, setRegion, solids };
}

// A part is selectable when its own modes include the view, or when it belongs to the conduction
// overlay that can be shown on the cross-section.
export const selectableIn = (data, mode, overlay) => data.modes.includes(mode) || (overlay && mode === 'interior' && data.kind === 'conduction');

const isShown = object => { for (let o = object; o; o = o.parent) if (!o.visible) return false; return true; };
const idOf = object => { while (object && !object.userData.id) object = object.parent; return object?.userData.id; };
// The cut face of the wall is drawn where the plane passes through wall material. Count the wall's
// faces beyond the plane along the ray as the GPU does (back faces +1, front faces -1); a non-zero
// count means the face is drawn there, and the first surface beyond it names the chamber.
// Seen from the kept side the face is hidden behind the near wall, so only rays from the removed side count.
function cutFace(ray, plane, solids) {
  if (plane.distanceToPoint(ray.origin) >= 0) return;
  const point = ray.intersectPlane(plane, new Vector3());
  if (!point) return;
  const inner = new Raycaster(point.clone().addScaledVector(ray.direction, 1e-5), ray.direction), normal = new Vector3();
  const hits = inner.intersectObjects(solids, false);
  const count = hits.reduce((sum, h) => sum + (normal.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(ray.direction) > 0 ? 1 : -1), 0);
  if (count !== 0) return { id: idOf(hits[0].object), distance: ray.origin.distanceTo(point), point };
}
// Raycasting also tests hidden objects, and the cross-section keeps the original walls (hidden) next to the drawn copies,
// so the same triangles would be tested twice and the hidden half thrown away. Test only what is shown.
function shownObjects(targets) {
  const out = [];
  const visit = object => { if (object.visible) { out.push(object); object.children.forEach(visit); } };
  for (const target of targets) if (isShown(target)) visit(target);
  return out;
}
// Raycasting ignores visibility and clipping planes. Return the id of the first part hit that is
// actually drawn: shown, and not on the side the cross-section has removed. `solids` are the wall
// meshes whose cut face is drawn on the plane; that face is nearer than anything it covers.
// The result also gives the distance along the ray to the drawn surface and whether it is the cut face (onCut,
// with the point on the plane). The chamber named for the cut face is the first wall surface beyond it, an estimate.
export function pickHit(raycaster, targets, planes = [], solids = []) {
  const cut = planes.length && solids.length ? cutFace(raycaster.ray, planes[0], solids) : undefined;
  for (const hit of raycaster.intersectObjects(shownObjects(targets), false)) {
    if (cut && cut.distance <= hit.distance) break;
    if (!planes.every(plane => plane.distanceToPoint(hit.point) >= 0)) continue;
    const id = idOf(hit.object);
    if (id) return { id, distance: hit.distance, onCut: false };
  }
  return cut && { ...cut, onCut: true };
}

// True when the cut leaves nothing of an object with this world-space box (the plane keeps distance >= 0).
// For a box this is exact only for an axis-aligned plane, which is the case for the front-to-back cut.
export function removedByCut(box, plane) {
  const n = plane.normal;
  return plane.distanceToPoint(new Vector3(n.x > 0 ? box.max.x : box.min.x, n.y > 0 ? box.max.y : box.min.y, n.z > 0 ? box.max.z : box.min.z)) < 0;
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
