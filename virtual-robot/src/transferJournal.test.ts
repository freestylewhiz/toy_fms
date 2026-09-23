import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTransferJournal, settledPoseJournal, writeTransferJournal, type TransferJournal } from "./transferJournal.ts";

const dir = () => mkdtempSync(`/tmp/teleporter-journal-${crypto.randomUUID()}-`);
const completed: TransferJournal = { version: 1, robotId: "robot-1", currentMapId: "large_lab", pose: { x: 1340, y: 1300, theta: 0 } };

test("atomically persists and restores completed destination pose", () => {
  const path = join(dir(), "state.json");
  writeTransferJournal(path, completed);
  expect(readTransferJournal(path, "robot-1")).toEqual(completed);
});

test("restores pending transfer identity and clearing pose", () => {
  const path = join(dir(), "state.json");
  const value = { ...completed, pending: { transferId: "t1", destinationMapId: "large_lab", destinationTarget: "localhost:62063", exit: completed.pose, clearing: { x: 1340, y: 1300 } } };
  writeTransferJournal(path, value);
  expect(readTransferJournal(path, "robot-1")?.pending?.transferId).toBe("t1");
});

test("operator pose override persists a settled pose without a resumable transfer", () => {
  const path = join(dir(), "state.json");
  const override = settledPoseJournal("robot-1", "yard", { x: 320, y: 520, theta: Math.PI / 2 });
  writeTransferJournal(path, override);
  expect(readTransferJournal(path, "robot-1")).toEqual(override);
  expect(override.pending).toBeUndefined();
  expect(override.lastTransferId).toBeUndefined();
});

test("rejects corrupt, nonfinite, unknown map, and wrong robot journals", () => {
  const path = join(dir(), "state.json");
  writeFileSync(path, "not-json");
  expect(() => readTransferJournal(path, "robot-1")).toThrow();
  writeFileSync(path, JSON.stringify({ ...completed, pose: { x: null, y: 1, theta: 0 } }));
  expect(() => readTransferJournal(path, "robot-1")).toThrow("pose");
  writeFileSync(path, JSON.stringify({ ...completed, currentMapId: "missing" }));
  expect(() => readTransferJournal(path, "robot-1")).toThrow("map");
  writeFileSync(path, JSON.stringify({ ...completed, robotId: "robot-2" }));
  expect(() => readTransferJournal(path, "robot-1")).toThrow("identity");
});
