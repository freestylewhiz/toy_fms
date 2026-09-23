export type Camera = { x: number; y: number; scale: number };

export function fitCamera(viewW: number, viewH: number, mapW: number, mapH: number, pad = 32): Camera {
  const scale = Math.min((viewW - pad * 2) / mapW, (viewH - pad * 2) / mapH, 2);
  return {
    scale,
    x: (viewW - mapW * scale) / 2,
    y: (viewH - mapH * scale) / 2,
  };
}

export function clampScale(s: number): number {
  return Math.min(8, Math.max(0.005, s));
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const before = screenToWorld(cam, sx, sy);
  const scale = clampScale(cam.scale * factor);
  return {
    scale,
    x: sx - before.x * scale,
    y: sy - before.y * scale,
  };
}

export function applyCamera(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
  ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.x, dpr * cam.y);
}
