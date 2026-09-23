import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Recorder } from "./recorder.ts";
import { BlackboxHttpError, BlackboxQuery } from "./query.ts";

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(path);
    }
  };
  await visit(root);
  return result;
}

test("Recorder writes an immutable stream, redacts secrets, and copies frame assets", async () => {
  const root = `/tmp/blackbox-recorder-${crypto.randomUUID()}`;
  const asset = `${root}-map.png`;
  await writeFile(asset, "historical-map");
  const recorder = new Recorder({ source: "fms", mapId: "yard", root });
  const event = recorder.record({ timeMs: 1_700_000_000_000, category: "operation", kind: "move.requested", operationId: "op-1", payload: { target: { x: 1 }, token: "must-not-be-written" } });
  expect(event?.eventId).toBeString();
  recorder.frame({ robot: { x: 1 }, assets: { mapUrl: asset, width: 2, height: 2, pixelCm: 5 } });
  await recorder.close();
  const ndjson = (await files(root)).filter((path) => path.endsWith(".events.ndjson"));
  expect(ndjson.length).toBeGreaterThan(0);
  const text = (await Promise.all(ndjson.map((path) => readFile(path, "utf8")))).join("");
  expect(text).not.toContain("must-not-be-written");
  expect(text).not.toContain(asset);
  expect(text).toContain("scene.snapshot");
  expect(text).toContain("/api/blackbox/assets/");
  const frame = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { category: string; payload: { state?: Record<string, unknown> } }).find((item) => item.category === "frame");
  expect(frame?.payload.state?.assets).toBeUndefined();
  const copied = (await files(join(root, "assets"))).filter((path) => path.endsWith(".png"));
  expect(copied).toHaveLength(1);
  expect((await stat(copied[0]!)).size).toBe("historical-map".length);
});

test("Recorder keeps boot and sequence identity across events and rejects writes after close", async () => {
  const root = `/tmp/blackbox-recorder-close-${crypto.randomUUID()}`;
  const recorder = new Recorder({ source: "robot-1", mapId: "yard", root });
  const first = recorder.record({ timeMs: 10, category: "protocol", kind: "grpc.tx", payload: {} });
  const second = recorder.record({ timeMs: 11, category: "error", kind: "drive.failed", payload: {} });
  await recorder.close();
  expect(first?.bootId).toBe(second?.bootId);
  expect(second!.sequence).toBe(first!.sequence + 1);
  expect(recorder.record({ timeMs: 12, category: "error", kind: "late", payload: {} })).toBeUndefined();
});

test("indexed meaningful queries do not consume the raw-event scan budget", async () => {
  const root = `/tmp/blackbox-recorder-index-${crypto.randomUUID()}`;
  const recorder = new Recorder({ source: "fms", mapId: "yard", root });
  const event = recorder.record({ category: "operation", kind: "move.requested", operationId: "indexed-op", payload: {} });
  await recorder.close();
  const result = await new BlackboxQuery(root, { maxScanBytes: 10_000, maxIndexScanBytes: 100_000 }).listMeaningful({ mapId: "yard" });
  expect(result.events[0]?.eventId).toBe(event?.eventId);
});

test("active segment survives another recorder's retention pass", async () => {
  const root = `/tmp/blackbox-recorder-active-${crypto.randomUUID()}`;
  const first = new Recorder({ source: "fms", mapId: "yard", root });
  first.record({ category: "operation", kind: "move.requested", payload: {} });
  await first.flush();
  const current = (await files(root)).find((path) => path.endsWith(".events.ndjson"));
  expect(current).toBeString();
  await utimes(current!, new Date(0), new Date(0));
  const second = new Recorder({ source: "fms", mapId: "yard", root });
  await second.flush();
  expect(await stat(current!).then(() => true).catch(() => false)).toBe(true);
  await second.close();
  await first.close();
});

test("missing historical asset is not persisted as a live descriptor", async () => {
  const root = `/tmp/blackbox-recorder-asset-error-${crypto.randomUUID()}`;
  const recorder = new Recorder({ source: "fms", mapId: "yard", root });
  recorder.record({ category: "frame", kind: "scene.snapshot", payload: { state: {}, assets: { mapUrl: "/resources/maps/does-not-exist.png", width: 1, height: 1, pixelCm: 5 } } });
  await recorder.close();
  const ndjson = (await files(root)).find((path) => path.endsWith(".events.ndjson"));
  const text = await readFile(ndjson!, "utf8");
  expect(text).not.toContain("/resources/maps/does-not-exist.png");
  expect(text).toContain("assetCaptureError");
});

test("overflow gap sequence is monotonic in physical stream order", async () => {
  const root = `/tmp/blackbox-recorder-gap-${crypto.randomUUID()}`;
  const recorder = new Recorder({ source: "fms", mapId: "yard", root });
  (recorder as unknown as { maxQueue: number }).maxQueue = 1;
  recorder.record({ category: "protocol", kind: "first", payload: {} });
  recorder.record({ category: "protocol", kind: "dropped", payload: {} });
  await recorder.close();
  const ndjson = (await files(root)).find((path) => path.endsWith(".events.ndjson"));
  const rows = (await readFile(ndjson!, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; category: string });
  expect(rows.map((row) => row.sequence)).toEqual([...rows.map((row) => row.sequence)].sort((a, b) => a - b));
  expect(rows.some((row) => row.category === "gap")).toBe(true);
});
