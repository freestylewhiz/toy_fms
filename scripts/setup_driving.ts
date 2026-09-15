import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorStore, DATA_DIR } from "../shared/store.ts";
import { isInflatedFree, robotFootprintClear } from "../shared/occupancy.ts";
import { isSemanticPoseBlocked } from "../shared/semanticNavigation.ts";
import type { ZoneResource } from "../shared/semantic.ts";

// Additive, repeatable setup. Run before starting the server so its projection
// and connected robots receive the same persisted resources at startup.
const store = new EditorStore();
const before = store.snapshot();
const backup = join(DATA_DIR, `before-driving-${Date.now()}.json`);
writeFileSync(backup, JSON.stringify(before, null, 2) + "\n");
const targets = [
  { id: "drive-hall-west", x: 240, y: 520, theta: 0 },
  { id: "drive-hall-east", x: 700, y: 520, theta: Math.PI },
  { id: "drive-corridor-entry", x: 810, y: 600, theta: 0 },
  { id: "drive-corridor-east", x: 1480, y: 600, theta: Math.PI },
  { id: "drive-corridor-north", x: 1248, y: 160, theta: Math.PI / 2 },
  { id: "drive-corridor-south", x: 1248, y: 1040, theta: -Math.PI / 2 },
];
for (const target of targets) {
  if (!isInflatedFree(target.x, target.y) || !robotFootprintClear(target.x, target.y, target.theta) || isSemanticPoseBlocked(before.zones, target)) {
    throw new Error(`Driving target ${target.id} is blocked; no resources written. Backup: ${backup}`);
  }
}
for (const target of targets) store.upsertWaypoint({ ...target, name: target.id });
// Treat the connected narrow corridor network as one capacity-1 resource.
// The polygon includes its walls; only occupancy-free pixels can be driven.
const corridor: ZoneResource = {
  id: "drive-corridor", family: "scene", kind: "corridor", name: "복도 · 한 대씩 통과", theta: 0, capacity: 1,
  polygon: [{ x: 860, y: 40 }, { x: 1560, y: 40 }, { x: 1560, y: 1160 }, { x: 860, y: 1160 }],
};
store.upsertZone(corridor);
console.log(`Driving resources ready: ${targets.length} waypoints + capacity-1 corridor. Backup: ${backup}`);
