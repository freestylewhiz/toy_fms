import { describe, expect, test } from "bun:test";
import { canDispatchRobot, projectTransport, snapshotFromState } from "./snapshot.ts";

function schemaMap<T extends Record<string, unknown>>(rows: T[]): { forEach(cb: (row: T, key: string) => void): void } {
  return { forEach: (cb) => rows.forEach((row, index) => cb(row, String(index))) };
}

describe("browser robot projection", () => {
  test("unknown display codes survive projection without being relabeled as idle or forbidden", () => {
    const snapshot = snapshotFromState({
      robots: schemaMap([{ id: "r", status: "future-status", trafficStatus: "future-traffic", commandState: "future-command" }]),
      zones: schemaMap([{ id: "z", family: "future-family", kind: "future-zone", paramsJson: JSON.stringify({ directedLimitation: "FUTURE_LIMIT", releaseLossBehavior: "FUTURE_RELEASE" }) }]),
      stations: schemaMap([{ id: "s", kind: "future-station" }]),
    });
    expect(snapshot.robots[0]).toMatchObject({ status: "future-status", trafficStatus: "future-traffic", commandState: "future-command" });
    expect(snapshot.zones[0]).toMatchObject({ family: "future-family", kind: "future-zone", directedLimitation: "FUTURE_LIMIT", releaseLossBehavior: "FUTURE_RELEASE" });
    expect(snapshot.stations[0].kind).toBe("future-station");
  });

  test("keeps active teleporter occupancy ahead of queued projections", () => {
    const snapshot = snapshotFromState({
      teleportersJson: JSON.stringify([{ id: "tp", name: "tp", endpoints: [
        { id: "a", mapId: "yard", position: { x: 10, y: 10 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: [] },
        { id: "b", mapId: "large_lab", position: { x: 20, y: 20 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: [] },
      ] }]),
      teleporterUsesJson: JSON.stringify([
        { teleporterId: "tp", endpointId: "a", state: "reserved", robotId: "r1", reason: "active" },
        { teleporterId: "tp", endpointId: "a", state: "queued", robotId: "r2", reason: "waiting" },
      ]),
    });
    expect(snapshot.teleporters[0].endpoints[0].occupancyState).toBe("reserved");
    expect(snapshot.teleporters[0].endpoints[0].occupancyRobotId).toBe("r1");
  });

  test("keeps terminal command lifecycle and reason visible", () => {
    const snapshot = snapshotFromState({
      robots: schemaMap([{
        id: "robot-1", x: 1, y: 2, theta: 0, status: "idle", trafficStatus: "clear",
        connected: true, motion: "stopped", commandId: "cmd-1", commandState: "failed",
        commandReason: "목표가 막혔어", lastSeenAt: 123, localHorizonS: 5,
        leaseId: "lease-1", headRoomPx: 2, path: schemaMap([]), localPath: schemaMap([]),
      }]),
    });
    expect(snapshot.robots[0].commandState).toBe("failed");
    expect(snapshot.robots[0].commandReason).toBe("목표가 막혔어");
    expect(snapshot.robots[0].commandId).toBe("cmd-1");
  });

  test("fails closed when connectivity is absent or false", () => {
    const absent = snapshotFromState({ robots: schemaMap([{ id: "r", x: 0, y: 0, theta: 0 }]) }).robots[0];
    const offline = snapshotFromState({ robots: schemaMap([{ id: "r", x: 0, y: 0, theta: 0, connected: false }]) }).robots[0];
    expect(canDispatchRobot(absent)).toBe(false);
    expect(canDispatchRobot(offline)).toBe(false);
  });

  test("transport projection disables stale robots after websocket loss", () => {
    const snapshot = snapshotFromState({ robots: schemaMap([{ id: "r", x: 0, y: 0, theta: 0, connected: true }]) });
    const disconnected = projectTransport(snapshot, false);
    expect(disconnected.robots[0].connected).toBe(false);
    expect(canDispatchRobot(disconnected.robots[0])).toBe(false);
    expect(projectTransport(snapshot, true).robots[0].connected).toBe(true);
  });

  test("projects modern runtime fields and drive context", () => {
    const snapshot = snapshotFromState({ robots: schemaMap([{
      id: "r", x: 0, y: 0, theta: 0, connected: true,
      workState: "busy", fmsControlState: "enabled", connectionState: "online",
      driveState: "waiting", driveContextJson: JSON.stringify([{ reasonCode: "resource_occupied", source: "fms", target: { mapId: "yard", kind: "zone", id: "z" }, since: 100 }]),
      controlEpoch: 4, controlReady: true, reportedAt: 200, stateChangedAt: 150,
      sessionId: "s", navigationMode: "graph_navigation", pathPlanningAuthority: "hybrid",
    }]) });
    const robot = snapshot.robots[0];
    expect(robot.workState).toBe("busy");
    expect(robot.driveState).toBe("waiting");
    expect(robot.driveContexts[0].target?.id).toBe("z");
    expect(robot.navigationMode).toBe("graph_navigation");
    expect(canDispatchRobot(robot)).toBe(true);
    const disconnected = projectTransport(snapshot, false).robots[0];
    expect(disconnected.connectionState).toBe("offline");
    expect(disconnected.workState).toBe("unknown");
    expect(disconnected.driveState).toBe("unknown");
    expect(disconnected.fmsControlState).toBe("enabled");
    expect(disconnected.controlReady).toBe(false);
  });

  test("unknown or incomplete runtime state stays unavailable", () => {
    const robot = snapshotFromState({ robots: schemaMap([{ id: "r", x: 0, y: 0, theta: 0, connected: true, driveState: "teleporting", workState: "surprise" }]) }).robots[0];
    expect(robot.workState).toBe("unknown");
    expect(robot.driveState).toBe("unknown");
    expect(canDispatchRobot(robot)).toBe(false);
  });
});
