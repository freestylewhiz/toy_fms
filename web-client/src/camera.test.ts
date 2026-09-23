import { test, expect } from 'bun:test';
import { fitCamera, zoomAt, screenToWorld } from './camera.ts';

test('10000px map can zoom out from fit without jumping to the old 12% minimum', () => {
  const cam = fitCamera(900, 700, 10000, 10000);
  const anchor = screenToWorld(cam, 450, 350);
  const out = zoomAt(cam, 450, 350, 1 / 1.12);
  expect(out.scale).toBeLessThan(cam.scale);
  expect(screenToWorld(out, 450, 350).x).toBeCloseTo(anchor.x);
  expect(screenToWorld(out, 450, 350).y).toBeCloseTo(anchor.y);
});
