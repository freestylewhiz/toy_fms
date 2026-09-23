import { describe, expect, test } from "bun:test";
import { BlackboxEventChannel, LiveEventChannel, meaningfulBlackboxEvent, type BlackboxEvent } from "./blackbox.ts";
import { snapshotFromState } from "./snapshot.ts";

function event(category: BlackboxEvent["category"], timeMs: number, id = category): BlackboxEvent {
  return { schemaVersion: 1, eventId: id, timeMs, sequence: timeMs, source: "test", bootId: "boot", mapId: "yard", category, kind: "test", payload: {} };
}

describe("blackbox channels", () => {
  test("meaningful candidates exclude ordinary frame and protocol noise", () => {
    expect(meaningfulBlackboxEvent(event("operation", 1))).toBe(true);
    expect(meaningfulBlackboxEvent(event("error", 2))).toBe(true);
    expect(meaningfulBlackboxEvent(event("forced", 3))).toBe(true);
    expect(meaningfulBlackboxEvent(event("frame", 4))).toBe(false);
    expect(meaningfulBlackboxEvent(event("protocol", 5))).toBe(false);
  });

  test("live channel publishes one common snapshot contract", () => {
    const channel = new LiveEventChannel();
    const seen: string[] = [];
    channel.subscribe(update => { if (update.snapshot) seen.push(update.snapshot.robots[0]?.id ?? "none"); });
    channel.publish(snapshotFromState({ robots: [{ id: "robot-1", x: 1, y: 2, theta: 0 }] }));
    channel.publish(snapshotFromState({ robots: [{ id: "robot-1", x: 9, y: 8, theta: 0 }] }));
    expect(seen).toEqual(["robot-1", "robot-1"]);
    expect(channel.snapshot?.robots[0]?.x).toBe(9);
  });

  test("blackbox invalidation advances generation and does not expose live state", () => {
    const channel = new BlackboxEventChannel();
    const generation = channel.generation;
    channel.invalidate();
    expect(channel.generation).toBe(generation + 1);
    expect(channel.snapshot).toBeUndefined();
  });

  test("live and blackbox channels keep the same robot id in separate scene sources", async () => {
    const originalFetch = globalThis.fetch;
    const frame = (id: string, timeMs: number, x: number): BlackboxEvent => ({
      ...event("frame", timeMs, id),
      payload: { state: { mapId: "yard", robots: [{ id: "robot-1", x, y: 0, theta: 0 }] }, assets: { mapUrl: "/api/blackbox/assets/a/map.png", width: 1, height: 1, pixelCm: 5 } },
    });
    const operation = { ...event("operation", 1_100, "operation"), operationId: "op-1" };
    const failure = { ...event("error", 1_100, "error"), operationId: "op-1" };
    globalThis.fetch = (async () => Response.json({
      schemaVersion: 1, mapId: "yard", startEvent: operation, endEvent: failure,
      checkpoint: frame("checkpoint", 900, 10), events: [frame("frame", 1_000, 20), operation, failure], gaps: [],
    })) as typeof fetch;
    try {
      const replay = new BlackboxEventChannel();
      const replayX: number[] = [];
      const sources: string[] = [];
      replay.subscribe(update => { sources.push(update.source); if (update.snapshot) replayX.push(update.snapshot.robots[0]?.x ?? -1); });
      await replay.loadReplay("yard", "operation", "error", 2_000);
      const live = new LiveEventChannel();
      live.subscribe(update => sources.push(update.source));
      live.publish(snapshotFromState({ mapId: "yard", robots: [{ id: "robot-1", x: 999, y: 0, theta: 0 }] }));
      expect(replay.snapshot?.robots[0]?.x).toBe(10);
      expect(replayX).not.toContain(999);
      expect(sources).toContain("blackbox");
      expect(sources).toContain("live");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("step follows meaningful event markers including same-time sequence order", async () => {
    const originalFetch = globalThis.fetch;
    const frame = (id: string, timeMs: number): BlackboxEvent => ({
      ...event("frame", timeMs, id),
      payload: { state: { mapId: "yard", robots: [] }, assets: { mapUrl: "/api/blackbox/assets/a/map.png", width: 1, height: 1, pixelCm: 5 } },
    });
    const operation = { ...event("operation", 1_100, "operation"), sequence: 1 };
    const failure = { ...event("error", 1_100, "error"), sequence: 2 };
    globalThis.fetch = (async () => Response.json({ schemaVersion: 1, mapId: "yard", startEvent: operation, endEvent: failure, checkpoint: frame("checkpoint", 900), events: [frame("frame", 1_000), operation, failure], gaps: [] })) as typeof fetch;
    try {
      const channel = new BlackboxEventChannel();
      const seen: string[] = [];
      channel.subscribe(update => { if (update.event) seen.push(update.event.eventId); });
      await channel.loadReplay("yard", "operation", "error", 2_000);
      channel.step(1);
      channel.step(1);
      expect(seen.slice(-2)).toEqual(["operation", "error"]);
      channel.step(-1);
      expect(seen.at(-1)).toBe("operation");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("paused replay clock is stable and sequential replay equals checkpoint seek", async () => {
    const originalFetch = globalThis.fetch;
    const frame = (id: string, timeMs: number, x: number): BlackboxEvent => ({
      ...event("frame", timeMs, id), payload: { state: { mapId: "yard", robots: [{ id: "robot-1", x, y: 0, theta: 0 }] },
        assets: { mapUrl: "/api/blackbox/assets/a/map.png", width: 1, height: 1, pixelCm: 5 } },
    });
    const start = event("operation", 1000, "start"), end = event("error", 1100, "end");
    globalThis.fetch = (async () => Response.json({ schemaVersion: 1, mapId: "yard", startEvent: start, endEvent: end,
      checkpoint: frame("checkpoint", 900, 1), events: [start, frame("middle", 1050, 50), end], gaps: [] })) as typeof fetch;
    const channel = new BlackboxEventChannel();
    try {
      await channel.loadReplay("yard", "start", "end", 2000);
      await Bun.sleep(40);
      expect(channel.clockMs).toBe(1000);
      channel.play();
      await Bun.sleep(180);
      const played = structuredClone(channel.snapshot);
      expect(channel.playing).toBe(false);
      expect(played?.robots[0]?.x).toBe(50);
      channel.seek(1000);
      expect(channel.snapshot?.robots[0]?.x).toBe(1);
      channel.seek(1100);
      expect(channel.snapshot).toEqual(played);
    } finally { channel.dispose(); globalThis.fetch = originalFetch; }
  });

  test("late candidate response cannot repopulate a different channel generation", async () => {
    const originalFetch = globalThis.fetch;
    let resolveOld!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { resolveOld = resolve; })) as typeof fetch;
    const channel = new BlackboxEventChannel();
    try {
      const pending = channel.loadCandidates("yard", 2000, true);
      channel.invalidate();
      resolveOld(Response.json({ asOf: 2000, events: [event("operation", 1500, "old")] }));
      await pending;
      expect(channel.candidates).toEqual([]);
    } finally { channel.dispose(); globalThis.fetch = originalFetch; }
  });
});
