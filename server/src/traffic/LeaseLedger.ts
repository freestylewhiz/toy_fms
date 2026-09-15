/**
 * Invariant lease ledger — policy-agnostic.
 * Must NOT import occupancy / obstacles / planner (P2 / F2).
 */

import {
  capsulesDisjoint,
  corridorsDisjoint,
  type Capsule,
  type Corridor,
} from "../../../shared/corridor.ts";
import { TRAFFIC_CELL_PX } from "../../../shared/constants.ts";
import type { ZoneId } from "../../../shared/traffic/types.ts";

export type LeaseEntry = {
  robotId: string;
  leaseId: string;
  segments: Capsule[];
  leaseUntilMs: number;
  zoneId: ZoneId;
};

function cellKey(x: number, y: number): string {
  const cx = Math.floor(x / TRAFFIC_CELL_PX);
  const cy = Math.floor(y / TRAFFIC_CELL_PX);
  return `${cx},${cy}`;
}

function capsuleKeys(c: Capsule): string[] {
  const minX = Math.min(c.x1, c.x2) - c.r;
  const maxX = Math.max(c.x1, c.x2) + c.r;
  const minY = Math.min(c.y1, c.y2) - c.r;
  const maxY = Math.max(c.y1, c.y2) + c.r;
  const keys: string[] = [];
  const x0 = Math.floor(minX / TRAFFIC_CELL_PX);
  const x1 = Math.floor(maxX / TRAFFIC_CELL_PX);
  const y0 = Math.floor(minY / TRAFFIC_CELL_PX);
  const y1 = Math.floor(maxY / TRAFFIC_CELL_PX);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) keys.push(`${cx},${cy}`);
  }
  return keys;
}

export class LeaseLedger {
  private byRobot = new Map<string, LeaseEntry>();
  private index = new Map<string, Set<string>>();
  violationCount = 0;

  get(robotId: string): LeaseEntry | null {
    return this.byRobot.get(robotId) ?? null;
  }

  all(): LeaseEntry[] {
    return [...this.byRobot.values()];
  }

  getHeld(robotId: string): Corridor | null {
    const e = this.byRobot.get(robotId);
    if (!e) return null;
    return { segments: e.segments.map((s) => ({ ...s })) };
  }

  clearRobot(robotId: string): void {
    const e = this.byRobot.get(robotId);
    if (!e) return;
    this.unindex(e);
    this.byRobot.delete(robotId);
  }

  /** Spatial-hash accelerated check (may miss if index buggy — use assertDisjoint before commit). */
  canGrant(robotId: string, wanted: Corridor): boolean {
    for (const seg of wanted.segments) {
      for (const otherId of this.nearbyRobotIds(seg)) {
        if (otherId === robotId) continue;
        const other = this.byRobot.get(otherId);
        if (!other) continue;
        for (const oseg of other.segments) {
          if (!capsulesDisjoint(seg, oseg)) return false;
        }
      }
    }
    return true;
  }

  /** Prefix of wanted that remains disjoint; stops at first blocked segment. */
  partialGrant(robotId: string, wanted: Corridor): Corridor {
    const ok: Capsule[] = [];
    for (const seg of wanted.segments) {
      if (this.canGrant(robotId, { segments: [...ok, seg] })) {
        ok.push(seg);
        continue;
      }
      const cut = this.binaryCut(robotId, ok, seg);
      if (cut) ok.push(cut);
      break;
    }
    return { segments: ok };
  }

  /**
   * Full pairwise disjoint check ignoring spatial hash (I1 safety net).
   * Returns false and increments violationCount on failure.
   */
  assertDisjoint(robotId: string, held: Corridor): boolean {
    for (const other of this.byRobot.values()) {
      if (other.robotId === robotId) continue;
      if (!corridorsDisjoint(held, { segments: other.segments })) {
        this.violationCount++;
        return false;
      }
    }
    return true;
  }

  commit(
    robotId: string,
    leaseId: string,
    held: Corridor,
    leaseUntilMs: number,
    zoneId: ZoneId,
  ): boolean {
    if (!this.assertDisjoint(robotId, held)) return false;
    const prev = this.byRobot.get(robotId);
    if (prev) this.unindex(prev);
    const entry: LeaseEntry = {
      robotId,
      leaseId,
      segments: held.segments.map((s) => ({ ...s })),
      leaseUntilMs,
      zoneId,
    };
    this.byRobot.set(robotId, entry);
    this.indexEntry(entry);
    return true;
  }

  release(robotId: string, leaseId: string, freed: Corridor, retained: Corridor): boolean {
    const cur = this.byRobot.get(robotId);
    if (!cur) return freed.segments.length === 0;
    if (cur.leaseId !== leaseId && leaseId) return false;

    const unionCount = freed.segments.length + retained.segments.length;
    // Soft check: retained should be what we keep; if empty and freed empty, no-op.
    if (unionCount === 0) return true;

    this.unindex(cur);
    if (retained.segments.length === 0) {
      this.byRobot.delete(robotId);
      return true;
    }
    cur.segments = retained.segments.map((s) => ({ ...s }));
    this.indexEntry(cur);
    return true;
  }

  expireBefore(nowMs: number): string[] {
    const dropped: string[] = [];
    for (const [id, e] of [...this.byRobot.entries()]) {
      if (e.leaseUntilMs <= nowMs) {
        this.clearRobot(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  renewLease(robotId: string, leaseUntilMs: number): void {
    const e = this.byRobot.get(robotId);
    if (e) e.leaseUntilMs = leaseUntilMs;
  }

  private binaryCut(robotId: string, prefix: Capsule[], seg: Capsule): Capsule | null {
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    if (len < 2) return null;
    let lo = 0;
    let hi = 1;
    let best: Capsule | null = null;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const cut: Capsule = {
        x1: seg.x1,
        y1: seg.y1,
        x2: seg.x1 + (seg.x2 - seg.x1) * mid,
        y2: seg.y1 + (seg.y2 - seg.y1) * mid,
        r: seg.r,
      };
      if (this.canGrant(robotId, { segments: [...prefix, cut] })) {
        best = cut;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (!best) return null;
    const cutLen = Math.hypot(best.x2 - best.x1, best.y2 - best.y1);
    return cutLen >= 2 ? best : null;
  }

  private nearbyRobotIds(_seg: Capsule): Set<string> {
    // v0: full scan — spatial hash is only an accelerator later; correctness first.
    return new Set(this.byRobot.keys());
  }

  private indexEntry(e: LeaseEntry): void {
    for (const seg of e.segments) {
      for (const k of capsuleKeys(seg)) {
        let set = this.index.get(k);
        if (!set) {
          set = new Set();
          this.index.set(k, set);
        }
        set.add(e.robotId);
      }
    }
  }

  private unindex(e: LeaseEntry): void {
    for (const seg of e.segments) {
      for (const k of capsuleKeys(seg)) {
        const set = this.index.get(k);
        if (!set) continue;
        set.delete(e.robotId);
        if (set.size === 0) this.index.delete(k);
      }
    }
  }
}
