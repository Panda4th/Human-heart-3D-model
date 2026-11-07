// Keep framing and gesture decisions independent of WebGL for regression tests.
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
