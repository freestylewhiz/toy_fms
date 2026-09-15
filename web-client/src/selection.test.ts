import { test, expect } from 'bun:test';
import { enclosed, rectangle, selectionItems } from './selection.ts';
import { snapshotFromState } from './snapshot.ts';
test('reverse drag uses normalized bounds and fully encloses polygons', () => {
  const s = snapshotFromState(undefined);
  s.waypoints.push({ id: 'a', x: 10, y: 20, theta: 0 });
  s.zones.push({ id: 'z', family: 'scene', kind: 'forbidden', name: '', theta: 0, polygon: [{x:0,y:0},{x:50,y:0},{x:50,y:50}] });
  const items = selectionItems(s, {scene:true,graph:true,zones:true});
  expect(enclosed(items, rectangle({x:30,y:30},{x:0,y:0})).map(i=>i.id)).toEqual(['a']);
  expect(enclosed(items, rectangle({x:50,y:50},{x:0,y:0})).length).toBe(2);
  expect(selectionItems(s, {scene:false,graph:false,zones:false})).toEqual([]);
});
