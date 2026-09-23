import { zoneTouchesPoint } from "../../../shared/semanticNavigation.ts";
import { MAP_ID } from '../../../shared/constants.ts';
import type { ZoneResource } from "../../../shared/semantic.ts";
import type { TrafficPlanAction, TrafficStatus } from "../../../shared/traffic/types.ts";
import type { TrafficWorldSnapshot } from "./TrafficPolicy.ts";
import { RuntimeStore, type RuntimeOccupancy } from "../runtimeStore.ts";

const ENTRY_LOOKAHEAD = 12;
const GATED_KINDS = new Set(["corridor", "complex", "release"]);

function inside(zone: ZoneResource, r: { x: number; y: number }): boolean {
  return zoneTouchesPoint(zone, r);
}
function pathTouches(zone: ZoneResource, points: { x: number; y: number }[]): boolean {
  for (let i = 0; i < points.length; i++) {
    if (inside(zone, points[i])) return true;
    const next = points[i + 1];
    if (!next) continue;
    const n = Math.max(2, Math.ceil(Math.hypot(next.x - points[i].x, next.y - points[i].y) / 12));
    for (let j = 1; j < n; j++) if (inside(zone, { x: points[i].x + (next.x - points[i].x) * j / n, y: points[i].y + (next.y - points[i].y) * j / n })) return true;
  }
  return false;
}

/** Capacity gate for semantic corridor/complex/release zones.
 * Reservations are FIFO and retained across disconnects until the robot is
 * observed clear, preventing an offline occupant from making a zone unsafe.
 */
export class SemanticCapacityGate {
  private records = new Map<string, RuntimeOccupancy>();
  private lastPersisted = "";

  constructor(private readonly runtimeStore?: RuntimeStore) {
    for (const item of runtimeStore?.listOccupancies() ?? []) {
      if (item.resourceRef.kind === "zone") this.records.set(this.key(item.resourceRef.id, item.robotId), item);
    }
    this.lastPersisted = JSON.stringify(this.snapshot());
  }

  private key(zoneId: string, robotId: string): string { return JSON.stringify([zoneId, robotId]); }
  private ready(r: TrafficWorldSnapshot["robots"][number] | undefined): boolean {
    return !!r && r.connected && r.fmsControlState !== "disabled" && r.controlReady !== false && r.poseObserved !== false;
  }
  private near(r: TrafficWorldSnapshot["robots"][number]): { x: number; y: number }[] {
    return (r.localPath?.length ? r.localPath : r.path).slice(0, ENTRY_LOOKAHEAD);
  }

  /** DB manual-release transaction has already committed before this projection update. */
  release(robotId: string, zoneId: string): void {
    this.records.delete(this.key(zoneId, robotId));
    this.persist();
  }

  tick(world: TrafficWorldSnapshot): TrafficPlanAction[] {
    const now = world.nowMs || Date.now();
    const zones = (world.zones ?? []).filter(z => GATED_KINDS.has(z.kind) && (z.capacity == null || Number.isFinite(z.capacity) && z.capacity > 0));
    const byId = new Map(world.robots.map(r => [r.robotId, r]));
    const actions: TrafficPlanAction[] = [];
    for (const zone of zones) {
      const previous = this.snapshot().filter(o => o.resourceRef.id === zone.id);
      const previousById = new Map(previous.map(o => [o.robotId, o]));
      const wants = (r: TrafficWorldSnapshot["robots"][number]) => inside(zone, r) || pathTouches(zone, this.near(r));
      const holders = previous.filter(o => o.state !== "queued").map(o => o.robotId).filter(id => {
        const r = byId.get(id);
        // Unconfirmed, offline and disabled holders never silently release a claim.
        return !this.ready(r) || wants(r!);
      });
      const queue = previous.filter(o => o.state === "queued").sort((a,b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.createdAt-b.createdAt)
        .map(o => o.robotId).filter(id => {
          const r = byId.get(id);
          return r?.fmsControlState !== "disabled" && (!this.ready(r) || wants(r!));
        });
      // Known physical occupants take priority. Seed-only poses and manually
      // excluded robots cannot recreate administrative occupancy records.
      for (const r of world.robots) {
        if (r.poseObserved === false || r.fmsControlState === "disabled" || !inside(zone, r) || holders.includes(r.robotId)) continue;
        holders.push(r.robotId);
      }
      for (let i = queue.length-1; i >= 0; i--) if (holders.includes(queue[i])) queue.splice(i,1);
      for (const r of world.robots) {
        if (this.ready(r) && wants(r) && !holders.includes(r.robotId) && !queue.includes(r.robotId)) queue.push(r.robotId);
      }
      const capacity = Math.max(1, Math.floor(zone.capacity ?? 1));
      const occupants = holders.filter(id => {
        const r = byId.get(id);
        return r?.poseObserved !== false && !!r && inside(zone,r);
      });
      if (occupants.length >= capacity) {
        for (let i = holders.length-1; i >= 0; i--) {
          const id = holders[i], r = byId.get(id);
          if (occupants.includes(id) || !this.ready(r)) continue;
          holders.splice(i,1);
          if (wants(r!) && !queue.includes(id)) queue.push(id);
        }
      }
      // Offline queues survive restart but cannot consume permission. FIFO is
      // preserved among currently eligible contenders; offline entries stay queued.
      for (let i = 0; i < queue.length && holders.length < capacity;) {
        if (!this.ready(byId.get(queue[i]))) { i++; continue; }
        holders.push(queue.splice(i,1)[0]);
      }
      const active = new Set([...holders,...queue]);
      for (const old of previous) if (!active.has(old.robotId)) this.records.delete(this.key(zone.id, old.robotId));
      const put = (robotId: string, state: RuntimeOccupancy["state"], queuePosition?: number) => {
        const old = previousById.get(robotId), r = byId.get(robotId);
        const epoch = r?.controlEpoch ?? old?.controlEpoch ?? 0;
        const changed = old?.state !== state || old?.controlEpoch !== epoch || old?.queuePosition !== queuePosition;
        this.records.set(this.key(zone.id,robotId), {
          resourceRef: { mapId: old?.resourceRef.mapId ?? MAP_ID, kind: "zone", id: zone.id }, robotId, state,
          requestId: old?.requestId ?? `semantic-${crypto.randomUUID()}`, controlEpoch: epoch,
          createdAt: old?.createdAt ?? now, updatedAt: changed ? now : old!.updatedAt,
          ...(queuePosition == null ? {} : {queuePosition}),
        });
      };
      for (const id of holders) {
        const r = byId.get(id), old = previousById.get(id);
        const state = r && r.poseObserved !== false && inside(zone,r) ? "occupied" :
          !this.ready(r) && old && old.state !== "queued" ? old.state : "reserved";
        put(id,state);
      }
      queue.forEach((id,index) => put(id,"queued",index+1));
      for (const r of world.robots) if (this.ready(r)) {
        actions.push({kind:"zone_update",robotId:r.robotId,zoneId:`semantic:${zone.id}`,state:holders.includes(r.robotId)?"PROCEED":"STOP"});
      }
    }
    const activeZones = new Set(zones.map(z=>z.id));
    for (const [key, record] of this.records) if (!activeZones.has(record.resourceRef.id)) this.records.delete(key);
    this.persist();
    return actions;
  }

  snapshot(): RuntimeOccupancy[] { return [...this.records.values()]; }

  /** True when a robot's requested movement is still queued behind capacity. */
  blocks(robotId: string, world: TrafficWorldSnapshot): boolean {
    const robot = world.robots.find(r => r.robotId === robotId);
    if (!robot) return true;
    for (const zone of (world.zones ?? []).filter(z => GATED_KINDS.has(z.kind))) {
      const wants = inside(zone, robot) || pathTouches(zone, this.near(robot));
      if (!wants) continue;
      const own = this.records.get(this.key(zone.id, robotId));
      if (own?.state === "queued") return true;
      const holders = [...this.records.values()].filter(o => o.resourceRef.id === zone.id && o.robotId !== robotId && o.state !== "queued");
      const capacity = Math.max(1, Math.floor(zone.capacity ?? 1));
      if (!own && holders.length >= capacity) return true;
    }
    return false;
  }

  private persist(): void {
    if (!this.runtimeStore) return;
    const snapshot = this.snapshot(), marker = JSON.stringify(snapshot);
    if (marker === this.lastPersisted) return;
    this.runtimeStore.db.transaction(() => {
      const active = new Set(snapshot.map(x => this.key(x.resourceRef.id,x.robotId)));
      const stored = this.runtimeStore!.listOccupancies();
      for (const item of snapshot) {
        const old = stored.find(o=>o.resourceRef.kind==="zone" && o.resourceRef.id===item.resourceRef.id && o.robotId===item.robotId);
        if (!old || old.state!==item.state || old.controlEpoch!==item.controlEpoch || old.queuePosition!==item.queuePosition || old.requestId!==item.requestId || old.updatedAt!==item.updatedAt) this.runtimeStore!.upsertOccupancy(item);
      }
      for (const old of stored) {
        if (old.resourceRef.kind!=="zone" || active.has(this.key(old.resourceRef.id,old.robotId))) continue;
        const now=Date.now();
        this.runtimeStore!.upsertOccupancy({...old,updatedAt:now,releasedAt:now,releaseReason:"cleared"});
      }
    })();
    this.lastPersisted = marker;
  }
}
