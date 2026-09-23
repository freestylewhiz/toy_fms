import { describe, expect, test } from "bun:test";
import type { Client } from "@colyseus/core";
import { handleEditorUpsert, parseZoneUpsert } from "./editorHandlers.ts";
import type { FloorState } from "./schema.ts";

const square = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
  { x: 10, y: 30 },
];

function zone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "zone", family: "scene", zoneKind: "prefer", polygon: square, ...overrides };
}

describe("semantic zone editor contract", () => {
  test("canonicalizes a valid polygon and preserves an applicable factor", () => {
    const result = parseZoneUpsert(zone({ polygon: [...square].reverse(), factor: "0.4", theta: "1.5" }));
    expect(result).toEqual({
      zone: expect.objectContaining({
        family: "scene",
        kind: "prefer",
        factor: 0.4,
        theta: 1.5,
        polygon: square,
      }),
    });
  });

  test("rejects malformed, degenerate, and oversized polygon snapshots", () => {
    expect(parseZoneUpsert(zone({ polygon: [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 }] }))).toEqual({ error: "존이 접히면 안 돼. 꼭짓점을 다시 잡아" });
    expect(parseZoneUpsert(zone({ polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] }))).toEqual({ error: "zone area must be nonzero" });
    expect(parseZoneUpsert(zone({ polygon: Array.from({ length: 257 }, (_, x) => ({ x, y: x % 2 })) }))).toEqual({ error: "zone needs 3-256 finite vertices" });
  });

  test("accepts only finite numeric factor values on soft-cost zones", () => {
    expect(parseZoneUpsert(zone({ factor: false }))).toEqual({ error: "factor must be finite" });
    expect(parseZoneUpsert(zone({ factor: -0.1 }))).toEqual({ error: "factor must be nonnegative" });
    expect(parseZoneUpsert(zone({ zoneKind: "corridor", factor: 1 }))).toEqual({ error: "factor is only valid for prefer, avoid, priority, and penalty zones" });
  });

  test("returns the validation error to the editor before any persistence work", () => {
    const messages: unknown[][] = [];
    const client = { send: (...args: unknown[]) => messages.push(args) } as unknown as Client;
    const state = {} as FloorState;
    expect(handleEditorUpsert(state, client, zone({ polygon: [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 }] }))).toBeNull();
    expect(messages).toEqual([["error", { message: "존이 접히면 안 돼. 꼭짓점을 다시 잡아" }]]);
  });

  test("enforces the family-kind vocabulary while accepting legacy family omission", () => {
    expect(parseZoneUpsert(zone({ family: "scene", zoneKind: "blocked" }))).toEqual({ error: "invalid scene zoneKind" });
    const legacy = parseZoneUpsert(zone({ family: undefined, zoneKind: "blocked" }));
    expect(legacy).toEqual({ zone: expect.objectContaining({ family: "vda", kind: "blocked" }) });
  });
});
