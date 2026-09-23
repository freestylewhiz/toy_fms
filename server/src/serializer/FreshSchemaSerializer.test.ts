import { expect, test } from "bun:test";
import { SchemaSerializer } from "@colyseus/core";
import { Decoder } from "@colyseus/schema";
import { FloorState, Robot } from "../schema.ts";
import { invalidateEmptyRoomSnapshot } from "./FreshSchemaSerializer.ts";

test("a returning client receives changes made while the room had no clients", () => {
  const state = new FloorState();
  const serializer = new SchemaSerializer<FloorState>();
  serializer.reset(state);
  serializer.getFullState({} as any);
  serializer.applyPatches([]);
  const encoder = (serializer as any).encoder;
  state.teleportersJson = JSON.stringify([{ id: "saved-on-another-map" }]);
  const robot = new Robot(); robot.id = "transferred-robot";
  state.robots.set(robot.id, robot);
  invalidateEmptyRoomSnapshot({ clients: [], _serializer: serializer } as any);
  serializer.applyPatches([]);
  expect((serializer as any).encoder).toBe(encoder);
  const restored = new FloorState();
  new Decoder(restored).decode(serializer.getFullState({} as any).subarray(1));
  expect(restored.teleportersJson).toBe(state.teleportersJson);
  expect(restored.robots.get(robot.id)?.id).toBe(robot.id);
});
