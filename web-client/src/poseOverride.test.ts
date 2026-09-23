import { describe, expect, test } from "bun:test";
import { poseConflicts } from "./poseOverride.ts";
import type { Snapshot } from "./snapshot.ts";

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  mapId: "yard", waypoints: [], chargers: [], robots: [], obstacles: [], zones: [], nodes: [], edges: [], stations: [], portals: [], rails: [], teleporters: [], runtimeOccupancies: [], ...overrides,
});

describe("virtual robot pose preview", () => {
  test("reports map, hard-zone, and robot conflicts", () => {
    const s = snapshot({
      zones: [{ id: "blocked", family: "scene", kind: "blocked", name: "blocked", polygon: [{x: 40,y:40},{x:80,y:40},{x:80,y:80},{x:40,y:80}], theta: 0 }],
      robots: [{ id: "robot-2", x: 120, y: 120, theta: 0 } as Snapshot["robots"][number]],
    });
    expect(poseConflicts({ robotId: "robot-1", x: 60, y: 60, theta: 0 }, s, 200, 200, () => true)).toContain("하드 존");
    expect(poseConflicts({ robotId: "robot-1", x: 120, y: 120, theta: 0 }, s, 200, 200, () => true)).toContain("다른 로봇 본체");
    expect(poseConflicts({ robotId: "robot-1", x: 2, y: 2, theta: 0 }, s, 200, 200, () => true)).toContain("맵 경계");
  });

  test("samples static occupancy around the candidate body", () => {
    const s = snapshot();
    expect(poseConflicts({ x: 100, y: 100, theta: 0 }, s, 200, 200, (x, y) => x < 105 || y !== 100)).toContain("정적 장애물");
  });
});
