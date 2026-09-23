import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeOccupancyPng } from './encode_png.ts';

export const SIZE = 10000;
export const CENTER = 5000;
export const PILLAR_RADIUS = 1200;
export const RING_RADIUS = 1600;

/** Four walled rooms connected only through diagonal doors to the central ring. */
export function buildLargeLab(): Uint8Array {
  const grid = new Uint8Array(SIZE * SIZE);
  const fill = (y: number, a: number, b: number) => grid.fill(1, y * SIZE + Math.ceil(a), y * SIZE + Math.floor(b) + 1);
  for (let y = 200; y <= 9800; y++) {
    if (y <= 3700 || y >= 6300) { fill(y, 200, 3700); fill(y, 6300, 9800); }
    const dy = y - CENTER;
    if (Math.abs(dy) <= RING_RADIUS) {
      const outer = Math.sqrt(RING_RADIUS ** 2 - dy ** 2);
      const inner = Math.abs(dy) <= PILLAR_RADIUS ? Math.sqrt(PILLAR_RADIUS ** 2 - dy ** 2) : -1;
      if (inner < 0) fill(y, CENTER - outer, CENTER + outer);
      else {
        fill(y, CENTER - outer, CENTER - inner - 1);
        fill(y, CENTER + inner + 1, CENTER + outer);
      }
    }
  }
  // 200px-wide diagonal access passages; endpoints overlap rooms and the ring.
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const ax = CENTER + sx * 1500, ay = CENTER + sy * 1500;
    const bx = CENTER + sx * 1000, by = CENTER + sy * 1000;
    for (let y = Math.min(ay, by) - 100; y <= Math.max(ay, by) + 100; y++)
      for (let x = Math.min(ax, bx) - 100; x <= Math.max(ax, bx) + 100; x++) {
        const t = Math.max(0, Math.min(1, ((x-ax)*(bx-ax)+(y-ay)*(by-ay))/500000));
        if ((x-ax-t*(bx-ax))**2 + (y-ay-t*(by-ay))**2 <= 10000) grid[y*SIZE+x] = 1;
      }
  }
  return grid;
}

/** Conservative square erosion, linear work rather than radius² per cell. */
export function clearanceGrid(grid: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(grid.length), out = new Uint8Array(grid.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += grid[row+x];
      if (x >= span) sum -= grid[row+x-span];
      if (x >= span-1 && sum === span) horizontal[row+x-radius] = 1;
    }
  }
  const sums = new Uint16Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums[x] += horizontal[y*width+x];
      if (y >= span) sums[x] -= horizontal[(y-span)*width+x];
      if (y >= span-1 && sums[x] === span) out[(y-radius)*width+x] = 1;
    }
  }
  return out;
}

if (import.meta.main) {
  const root = join(import.meta.dir, '../resources/maps');
  const grid = buildLargeLab();
  writeFileSync(join(root, 'large_lab.occupancy.bin'), grid);
  writeFileSync(join(root, 'large_lab.png'), encodeOccupancyPng(SIZE, SIZE, grid));
  const inflated = clearanceGrid(grid, SIZE, SIZE, 8);
  writeFileSync(join(root, 'large_lab.occupancy_inflated.bin'), inflated);
  // Lightweight display texture; occupancy always retains the full resolution.
  const preview = new Uint8Array(2000*2000);
  for (let y=0;y<2000;y++) for (let x=0;x<2000;x++) preview[y*2000+x]=grid[(y*5)*SIZE+x*5];
  writeFileSync(join(root, 'large_lab.preview.png'), encodeOccupancyPng(2000,2000,preview));
  writeFileSync(join(root, 'large_lab.occupancy.json'), JSON.stringify({
    width: SIZE, height: SIZE, freePixelCm: 5, source: 'large_lab.png', cells: grid.length,
    center: [CENTER,CENTER], pillarRadiusPx: PILLAR_RADIUS, ringOuterRadiusPx: RING_RADIUS,
    passageWidthPx: 200, inflateRadiusPx: 8, inflation: 'conservative square clearance',
    quadrants: { Q1: 'NE', Q2: 'NW', Q3: 'SW', Q4: 'SE' }, encoding: 'row-major uint8: 1 free, 0 blocked'
  }, null, 2)+'\n');
  const positions = [[8000,2000],[2000,2000],[2000,8000],[8000,8000]];
  writeFileSync(join(root, 'large_lab.seed.json'), JSON.stringify({
    waypoints: positions.map(([x,y],i)=>({id: 'q'+(i+1)+'-center',x,y,theta:0})),
    chargingStations: [{id:'large-charger',x:6600,y:6500,theta:0}],
    robots: [{id:'robot-1',x:6500,y:6500,theta:0,status:'idle',sprite:'robot.png'},
      {id:'robot-2',x:6500,y:6600,theta:0,status:'idle',sprite:'robot-2.png'}]
  },null,2)+'\n');
  console.log('large_lab: 10000 × 10000 = 100000000 cells; generated map, preview, occupancy, clearance, seed');
}
