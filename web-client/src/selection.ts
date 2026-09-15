import type { Snapshot } from './snapshot.ts';
export type Bounds = { x: number; y: number; right: number; bottom: number };
export type SelectionItem = { kind: string; id: string; bounds: Bounds };
export const selectionKey = (item: { kind: string; id: string }) => `${item.kind}:${item.id}`;
export function rectangle(a: { x: number; y: number }, b: { x: number; y: number }): Bounds {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}
export function selectionItems(s: Snapshot, layers: { scene: boolean; graph: boolean; zones: boolean }): SelectionItem[] {
  const items: SelectionItem[] = [];
  const add = (kind: string, id: string, points: { x: number; y: number }[]) => {
    if (!points.length) return;
    items.push({ kind, id, bounds: { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)), right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) } });
  };
  if (layers.scene) {
    for (const [kind, list] of [['waypoint', s.waypoints], ['charger', s.chargers], ['obstacle', s.obstacles]] as const) for (const p of list) add(kind, p.id, [p]);
  }
  if (layers.zones) for (const z of s.zones) add('zone', z.id, z.polygon);
  if (layers.graph) {
    for (const [kind, list] of [['node', s.nodes], ['station', s.stations]] as const) for (const p of list) add(kind, p.id, [p]);
    for (const e of s.edges) add('edge', e.id, e.trajectory.length ? e.trajectory : s.nodes.filter(n => n.id === e.startNodeId || n.id === e.endNodeId));
    for (const p of s.portals) add('portal', p.id, [{ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }]);
    for (const r of s.rails) add('rail', r.id, r.points);
  }
  return items;
}
/** Points use their anchor; polygons and lines must be fully enclosed. */
export function enclosed(items: SelectionItem[], rect: Bounds): SelectionItem[] {
  return items.filter(({ bounds: b }) => b.x >= rect.x && b.y >= rect.y && b.right <= rect.right && b.bottom <= rect.bottom);
}
