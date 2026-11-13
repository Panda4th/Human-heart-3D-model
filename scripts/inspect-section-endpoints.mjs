import { readFileSync } from 'node:fs';
import { Group, Vector3 } from 'three';
import { createAnatomy, modelScale } from '../src/anatomy.mjs';

// Use the same geometry and scale as the static section in src/main.js.
const model = new Group();
const parts = new Map();
createAnatomy(model, parts, readFileSync(new URL('../src/data/bodyparts3d-heart.bin', import.meta.url)), modelScale);
model.updateMatrixWorld(true);
const vector = new Vector3();
const targets = [-1.8, -1.5, 1.5, 1.8];
const tolerance = 1e-8;
const report = Object.fromEntries(targets.map(value => [value, {}]));
for (const [id, part] of parts) {
  const mesh = part.children[0];
  const { position } = mesh.geometry.attributes;
  const indices = mesh.geometry.index.array;
  const z = Array.from({ length: position.count }, (_, i) =>
    vector.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).z);
  for (const depth of targets) {
    const result = { crossing: 0, touching: 0, kept: 0, removed: 0 };
    for (let i = 0; i < indices.length; i += 3) {
      const a = z[indices[i]] + depth;
      const b = z[indices[i + 1]] + depth;
      const c = z[indices[i + 2]] + depth;
      const low = Math.min(a, b, c);
      const high = Math.max(a, b, c);
      if (low < -tolerance && high > tolerance) result.crossing++;
      else if (Math.min(Math.abs(low), Math.abs(high)) <= tolerance) result.touching++;
      else if (high < 0) result.kept++;
      else result.removed++;
    }
    report[depth][id] = result;
  }
}
console.log(JSON.stringify({ centerZmm: -model.position.z / model.scale.z, scale: model.scale.z, report }, null, 2));
