import { describe, expect, test } from "bun:test";
import {
  advanceTeleporterTransfer,
  endpointPolygonContains,
  validateTeleporter,
  type TeleporterDefinition,
  type TeleporterTransfer,
} from "./teleporterRuntime.ts";

const endpoint = (id: string, mapId: string) => ({
  id, mapId, position: { x: 10, y: 20 }, entryTheta: 0, exitTheta: Math.PI,
  occupancyPolygon: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }],
  clearingPoint: { x: 20, y: 20 },
});

const definition = (): TeleporterDefinition => ({ id: "t1", revision: 3, enabled: true, endpoints: [endpoint("a", "yard"), endpoint("b", "large_lab")] });
const transfer = (): TeleporterTransfer => ({
  transferId: "x1", teleporterId: "t1", robotId: "robot-1", fromEndpointId: "a", toEndpointId: "b",
  phase: "requested", controlEpoch: 4, sourceMapId: "yard", destinationMapId: "large_lab", commandId: "c1", reason: "",
});

describe("teleporter runtime contract", () => {
  test("requires two endpoints on distinct maps and validates polygons", () => {
    expect(validateTeleporter(definition())).toEqual([]);
    expect(validateTeleporter({ ...definition(), endpoints: [endpoint("a", "yard"), endpoint("b", "yard")] })).toContain("endpoints must use different maps");
  });

  test("advances only in order and rejects stale ownership", () => {
    const t = transfer();
    expect(advanceTeleporterTransfer(t, "entry_approach", { transferId: "x1", robotId: "robot-1", controlEpoch: 4 })).toEqual(t);
    const reserved = advanceTeleporterTransfer(t, "reserved", { transferId: "x1", robotId: "robot-1", controlEpoch: 4 });
    expect(reserved.phase).toBe("reserved");
    expect(advanceTeleporterTransfer(reserved, "entry_approach", { transferId: "x1", robotId: "robot-1", controlEpoch: 5 })).toEqual(reserved);
  });

  test("uses endpoint-local polygons for occupancy", () => {
    const e = endpoint("a", "yard");
    expect(endpointPolygonContains(e, { x: 10, y: 20 })).toBe(true);
    expect(endpointPolygonContains(e, { x: 13, y: 20 })).toBe(false);
  });
});
