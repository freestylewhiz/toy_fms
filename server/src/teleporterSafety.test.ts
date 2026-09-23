import { describe, expect, test } from "bun:test";
import { endpointClearingPathBlocked, poseOverlapsRobotBodies, type WorldRobotFootprint } from "./teleporterSafety.ts";
import { defaultTeleporterOccupancyPolygon, type TeleporterEndpoint } from "../../shared/teleporterRuntime.ts";

const endpoint: TeleporterEndpoint = { id: "a", mapId: "yard", position: { x: 100, y: 100 }, entryTheta: 0, exitTheta: 0, occupancyPolygon: defaultTeleporterOccupancyPolygon(), clearingPoint: { x: 160, y: 100 } };
const robot = (robotId: string, x: number, y: number): WorldRobotFootprint => ({ robotId, x, y, bodyPolygon: [{ x: x - 8, y: y - 5 }, { x: x + 8, y: y - 5 }, { x: x + 8, y: y + 5 }, { x: x - 8, y: y + 5 }] });

describe("teleporter clearing safety", () => {
  test("blocks a different robot on the exit path", () => expect(endpointClearingPathBlocked(endpoint, [robot("other", 130, 100)])).toBe(true));
  test("allows only the requesting robot on the path", () => expect(endpointClearingPathBlocked(endpoint, [robot("requester", 130, 100)], "requester")).toBe(false));
  test("does not treat a completed ordinary robot as exempt", () => expect(endpointClearingPathBlocked(endpoint, [robot("completed", 130, 100)], "requester")).toBe(true));
  test("fails closed for a world robot without a body polygon", () => expect(endpointClearingPathBlocked(endpoint, [{ robotId: "unknown", x: 130, y: 100 } as WorldRobotFootprint])).toBe(true));
  test("detects full body overlap for an administrative pose without treating its own body as a blocker", () => {
    expect(poseOverlapsRobotBodies({ x: 100, y: 100, theta: 0 }, [robot("other", 112, 100)])).toBe(true);
    expect(poseOverlapsRobotBodies({ x: 100, y: 100, theta: 0 }, [robot("self", 100, 100)], "self")).toBe(false);
  });
});
