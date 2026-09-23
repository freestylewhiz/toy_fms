import { expect, test } from "bun:test";
import { BlackboxEventChannel } from "./blackbox.ts";
import type { BlackboxEvent } from "../../shared/blackbox.ts";
const assets = { mapUrl: "/api/blackbox/assets/" + "a".repeat(64) + "/map.png", width: 10_000, height: 10_000, pixelCm: 5 };
function frame(id: string, timeMs: number, x: number): BlackboxEvent {
  return { schemaVersion: 1, eventId: id, timeMs, sequence: timeMs, source: "fms-yard", bootId: "boot", mapId: "yard", category: "frame", kind: "scene.snapshot", payload: { state: { mapId: "yard", robots: [{ id: "robot-1", x, y: 0, theta: 0 }] }, assets } };
}
function windowBody(events: BlackboxEvent[] = []) {
  return { schemaVersion: 1, mapId: "yard", generation: { id: "g1", createdAt: 0 }, asOf: 40_000, fromMs: 10_000, toMs: 40_000, checkpoint: frame("checkpoint", 1000, 1), events, gaps: [], assets, gap: false, truncated: false };
}

test("v2 idle scene uses selected time bounds even without operation markers", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel();
  globalThis.fetch = (async () => Response.json(windowBody())) as typeof fetch;
  try {
    await channel.loadWindow("yard", 10_000, 40_000);
    expect(channel.snapshot?.robots[0]?.x).toBe(1); expect(channel.clockMs).toBe(10_000);
    channel.seek(35_000); expect(channel.clockMs).toBe(35_000); expect(channel.snapshot?.robots[0]?.x).toBe(1);
    expect(channel.error).toBe("");
  } finally { channel.dispose(); globalThis.fetch = original; }
});

test("v2 selected interval includes intermediate frames across server cursor pages", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel(), requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    return Response.json(url.includes("cursor=older-page") ? windowBody([frame("late", 39_000, 99)]) : { ...windowBody([frame("early", 11_000, 11)]), nextCursor: "older-page" });
  }) as typeof fetch;
  try {
    await channel.loadWindow("yard", 10_000, 40_000);
    channel.seek(40_000);
    expect(channel.snapshot?.robots[0]?.x).toBe(99);
    expect(requests.some(url => url.includes("cursor=older-page"))).toBe(true);
  } finally { channel.dispose(); globalThis.fetch = original; }
});

test("v2 late window response cannot restore a disposed replay scene", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel(); let resolveResponse!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { resolveResponse = resolve; })) as typeof fetch;
  try {
    const pending = channel.loadWindow("yard", 10_000, 40_000);
    channel.invalidate(); resolveResponse(Response.json(windowBody([frame("late", 39_000, 99)]))); await pending;
    expect(channel.snapshot).toBeUndefined(); expect(channel.events).toHaveLength(0);
  } finally { channel.dispose(); globalThis.fetch = original; }
});


test("v2 a successful new range clears a previous error and can play again", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel();
  globalThis.fetch = (async () => Response.json(windowBody([frame("late", 39_000, 99)]))) as typeof fetch;
  try {
    channel.fail("previous unavailable range");
    await channel.loadWindow("yard", 10_000, 40_000);
    expect(channel.error).toBe(""); channel.play(); expect(channel.playing).toBe(true);
  } finally { channel.dispose(); globalThis.fetch = original; }
});


test("v2 partial cleanup preserves the server cause while invalidating old replay", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel();
  globalThis.fetch = (async () => Response.json({ generation: { id: "new", createdAt: 100 }, cleared: true, cleanupComplete: false, cleanupError: "archive cleanup denied" }, { status: 207 })) as typeof fetch;
  try {
    const generation = channel.generation, result = await channel.clearAll();
    expect(result.partial).toBe(true); expect(result.cleanupComplete).toBe(false);
    expect(result.errors).toContain("archive cleanup denied"); expect(channel.generation).toBeGreaterThan(generation);
  } finally { channel.dispose(); globalThis.fetch = original; }
});


test("v2 automatic entry omits unavailable start and pins server-clipped bounds on later pages", async () => {
  const original = globalThis.fetch, channel = new BlackboxEventChannel(), requests: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://test"); requests.push(url);
    const common = { ...windowBody(), fromMs: 25_000, toMs: 40_000, checkpoint: frame("fresh-checkpoint", 25_000, 25) };
    return Response.json(url.searchParams.has("cursor") ? { ...common, events: [frame("fresh-later", 39_000, 39)] } : { ...common, events: [], nextCursor: "fresh-page" });
  }) as typeof fetch;
  try {
    await channel.loadWindow("yard", undefined, 40_000);
    expect(requests[0]?.searchParams.has("fromMs")).toBe(false);
    expect(requests[1]?.searchParams.get("fromMs")).toBe("25000");
    expect(channel.clockMs).toBe(25_000); channel.seek(40_000); expect(channel.snapshot?.robots[0]?.x).toBe(39);
  } finally { channel.dispose(); globalThis.fetch = original; }
});
