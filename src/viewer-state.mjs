import { Box3, Sphere, Vector3 } from 'three';

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
