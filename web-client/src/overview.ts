import type { Camera } from './camera.ts';
import type { Snapshot } from './snapshot.ts';

/** The display palette changes; occupancy and editor coordinates remain untouched. */
export function createBlueprint(grid: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 2048));
  const w = Math.ceil(width / step), h = Math.ceil(height / step);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(w, h);
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const x=px*step, y=py*step, at = y * width + x, i = (py*w+px) * 4;
    const free = grid[at] === 1;
    const edge = free && (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !grid[at - 1] || !grid[at + 1] || !grid[at - width] || !grid[at + width]);
    const minor = free && (x % 100 === 0 || y % 100 === 0);
    const color = edge ? [104, 129, 142] : minor ? [44, 58, 69] : free ? [30, 41, 51] : [16, 23, 32];
    pixels.data[i] = color[0]; pixels.data[i+1] = color[1]; pixels.data[i+2] = color[2]; pixels.data[i+3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export function drawOverview(canvas: HTMLCanvasElement, source: CanvasImageSource, snapshot: Snapshot, camera: Camera, mapWidth: number, mapHeight: number, viewWidth: number, viewHeight: number): void {
  const ctx = canvas.getContext('2d')!;
  const sx = canvas.width / mapWidth, sy = canvas.height / mapHeight;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(source,0,0,canvas.width,canvas.height);
  ctx.save(); ctx.scale(sx,sy);
  for (const zone of snapshot.zones) {
    if (!zone.polygon.length) continue;
    ctx.beginPath(); zone.polygon.forEach((p,i)=>i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); ctx.closePath();
    ctx.fillStyle = 'rgba(143,184,172,.22)'; ctx.fill();
  }
  for (const robot of snapshot.robots) {
    ctx.fillStyle = robot.connected ? '#d4fc78' : '#72808c'; ctx.beginPath(); ctx.arc(robot.x,robot.y,2.4/sx,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(212,252,120,.08)'; ctx.strokeStyle = '#d4fc78'; ctx.lineWidth = 1;
  const x = -camera.x/camera.scale*sx, y = -camera.y/camera.scale*sy;
  const w = viewWidth/camera.scale*sx, h = viewHeight/camera.scale*sy;
  ctx.fillRect(x,y,w,h); ctx.strokeRect(x+.5,y+.5,w,h);
}
