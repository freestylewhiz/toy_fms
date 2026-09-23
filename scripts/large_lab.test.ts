import { test, expect } from 'bun:test';
import { buildLargeLab, clearanceGrid, SIZE } from './generate_large_lab.ts';

test('100M-cell map: pillar, walled quadrants and all four ring access passages', () => {
  const grid = buildLargeLab();
  const free = (x: number, y: number) => grid[y*SIZE+x];
  expect(grid.length).toBe(100_000_000);
  for (const [x,y] of [[5000,5000],[5000,3900],[0,5000],[199,2000],[4000,2000],[5000,2000]]) expect(free(x,y)).toBe(0);
  for (const [x,y] of [[8000,2000],[2000,2000],[2000,8000],[8000,8000],[5000,3600],[6400,5000]]) expect(free(x,y)).toBe(1);
  // Each diagonal door connects room interior to ring; sample every pixel.
  for (const sx of [-1,1]) for (const sy of [-1,1])
    for (let d=1000;d<=1600;d++) expect(free(5000+sx*d,5000+sy*d)).toBe(1);
  // Complete circular centerline is free, so all four entrances interconnect.
  for (let i=0;i<3600;i++) {
    const a=i*Math.PI/1800;
    expect(free(Math.round(5000+1400*Math.cos(a)),Math.round(5000+1400*Math.sin(a)))).toBe(1);
  }
});

test('clearance erosion matches brute-force square clearance, including map boundaries', () => {
  const w=21,h=17,r=2,grid=new Uint8Array(w*h).fill(1);
  grid[8*w+10]=0; grid[7*w+11]=0;
  const actual=clearanceGrid(grid,w,h,r);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
    let expected=1;
    for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++)
      if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h||!grid[(y+dy)*w+x+dx]) expected=0;
    expect(actual[y*w+x]).toBe(expected);
  }
});
