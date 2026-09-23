/** Browser-only blackbox source isolation check. Replay HTTP is mocked, while
 * live state is injected through an isolated Colyseus FMS and virtual robot.
 * Only that temporary FMS receives the test move; production and PM2/systemd
 * processes are never touched. */
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "./node_modules/colyseus.js/build/esm/index.mjs";

// This check owns an isolated FMS by default. An externally started isolated
// FMS may be supplied with ATLAS_WEB_URL plus E2E_PORT_OFFSET/FMS_PORT_OFFSET;
// refusing an un-offset external URL keeps the check from touching production.
const externalBaseUrl = process.env.ATLAS_WEB_URL;
const portOffset = Number(process.env.E2E_PORT_OFFSET ?? process.env.FMS_PORT_OFFSET ?? 9400);
assert(Number.isInteger(portOffset) && portOffset >= 1000 && portOffset < 15000, "isolated port offset required");
if (externalBaseUrl && !process.env.E2E_PORT_OFFSET && !process.env.FMS_PORT_OFFSET) {
  throw new Error("ATLAS_WEB_URL requires E2E_PORT_OFFSET or FMS_PORT_OFFSET for an isolated FMS");
}
const root = mkdtempSync(join(tmpdir(), "fms-blackbox-web-"));
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${5174 + portOffset}`;
const children: Bun.Subprocess[] = [];
function spawn(name: string, file: string, args: string[] = []): Bun.Subprocess {
  const env = {
    ...process.env,
    FMS_MAP_ID: "yard",
    FMS_PORT_OFFSET: String(portOffset),
    FMS_DATA_ROOT: root,
    TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite"),
    FMS_BLACKBOX: "0",
    FMS_WEB_PUBLIC_DIR: join(root, "public"),
  };
  const child = Bun.spawn(["bun", file, ...args], {
    env,
    stdout: Bun.file(join(root, `${name}.log`)),
    stderr: Bun.file(join(root, `${name}.err`)),
  });
  children.push(child);
  return child;
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out: ${label}; isolated diagnostics: ${root}`);
}

let room: any;
let browser: any;
let page: any;
async function cleanup(): Promise<void> {
  try { await room?.leave(); } catch {}
  try { await browser?.close(); } catch {}
  for (const child of children) {
    try { child.kill(); await child.exited; } catch {}
  }
}

try {
  if (!externalBaseUrl) {
    spawn("server", "server/src/index.ts");
    spawn("web", "web-client/src/server.ts");
    await until(async () => {
      try {
        room = await new Client(`ws://127.0.0.1:${2568 + portOffset}`).joinOrCreate("floor");
        return true;
      } catch { return false; }
    }, "isolated Colyseus room");
    spawn("robot-1", "virtual-robot/src/index.ts", ["--id", "robot-1"]);
    await until(() => Boolean(room.state?.robots?.get("robot-1")?.connected && room.state?.robots?.get("robot-1")?.controlReady), "isolated robot-1 ready", 30000);
  } else {
    const browserUrl = new URL(baseUrl);
    const colyseusPort = Number(process.env.BLACKBOX_COLYSEUS_PORT ?? 2568 + portOffset);
    room = await new Client(process.env.BLACKBOX_COLYSEUS_URL ?? `ws://${browserUrl.hostname}:${colyseusPort}`).joinOrCreate("floor");
    await until(() => Boolean(room.state?.robots?.get("robot-1")), "isolated robot-1 in supplied room");
  }
  room.onMessage("commandAck", () => {});
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
} catch (error) {
  await cleanup();
  throw error;
}
const errors: string[] = [];
let replayCount = 0;
let websocketSends = 0;
const robotId = "robot-1";

await page.addInitScript(() => {
  // LAN HTTP does not expose randomUUID, unlike the localhost test origin.
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  const send = WebSocket.prototype.send;
  (window as any).__blackboxWebsocketSends = 0;
  WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    (window as any).__blackboxWebsocketSends += 1;
    return send.call(this, data);
  };
});
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const assetBase = "/api/blackbox/assets/" + "a".repeat(64) + "/";
const robot = (driveState: string) => ({
  id: "robot-1", name: "robot-1", x: driveState === "moving" ? 40 : 10, y: 10, theta: 0,
  status: driveState === "moving" ? "move" : "idle", trafficStatus: "clear", connected: true,
  connectionState: "online", fmsControlState: "enabled", controlReady: true, workState: "idle",
  driveState, navigationMode: "free_navigation", pathPlanningAuthority: "fms", motion: driveState,
  commandId: "op-1", commandState: driveState === "moving" ? "running" : "idle", commandReason: "",
  lastSeenAt: 1_000, reportedAt: 1_000, stateChangedAt: 1_000, controlEpoch: 1,
  sessionId: "session-1", localPath: [], path: [], driveContexts: [], localHorizonS: 5, leaseId: "", headRoomPx: 0,
});
const frame = (id: string, timeMs: number, driveState: string, asset: string) => ({
  schemaVersion: 1, eventId: id, timeMs, sequence: timeMs, source: "fms", bootId: "boot-1", mapId: "yard",
  category: "frame", kind: "scene.snapshot", payload: {
    state: { mapId: "yard", robots: [robot(driveState)] },
    assets: { mapUrl: asset, width: 1, height: 1, pixelCm: 5, mapRevision: asset },
  },
});
const candidate = (id: string, timeMs: number, category: string) => ({
  schemaVersion: 1, eventId: id, timeMs, sequence: timeMs, source: "fms", bootId: "boot-1", mapId: "yard",
  category, kind: category === "operation" ? "move.requested" : "robot.error", robotId: "robot-1", operationId: "op-1", payload: { reason: "fixture" },
});

await page.route("**/api/blackbox/**", async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/events")) {
    await route.fulfill({ json: { asOf: Date.now(), events: [candidate("start", 1_000, "operation"), candidate("end", 2_000, "error")] } });
    return;
  }
  if (url.pathname.endsWith("/replay")) {
    replayCount += 1;
    const asset = `${assetBase}map-${replayCount}.png`;
    const driveState = replayCount === 1 ? "stationary" : "moving";
    const checkpoint = frame(`checkpoint-${replayCount}`, 900, driveState, asset);
    await route.fulfill({ json: {
      schemaVersion: 1, mapId: "yard", startEvent: candidate("start", 1_000, "operation"), endEvent: candidate("end", 2_000, "error"),
      checkpoint, events: [checkpoint, frame(`frame-${replayCount}`, 2_000, driveState, asset)], gaps: [],
    } });
    return;
  }
  if (url.pathname.includes("/api/blackbox/assets/")) {
    if (url.pathname.endsWith("map-1.png")) await Bun.sleep(800);
    await route.fulfill({ body: png, contentType: "image/png" });
    return;
  }
  await route.fulfill({ status: 404, body: "not found" });
});

try {
  const browserUrl = new URL(baseUrl);
  browserUrl.searchParams.set("map", "yard");
  browserUrl.searchParams.set("portOffset", String(portOffset));
  await page.goto(browserUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !(document.getElementById("blackbox-toggle") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 15000 });
  await page.locator("#modes [data-mode=operate]").click();
  await page.locator('button[data-detail="fleet"]').click();
  await page.waitForFunction(() => document.querySelector("#inspector")?.getAttribute("data-detail") === "fleet", undefined, { timeout: 5000 });
  await page.locator("#robot-cards .card[data-robot-id='robot-1']").waitFor({ state: "visible", timeout: 10000 });

  await page.locator("#blackbox-toggle").click();
  await page.locator("#blackbox-start-event option[value=start]").waitFor({ state: "attached" });
  await page.locator("#blackbox-load").click();
  // The first checkpoint is deliberately held on its historical asset. A
  // second selection must supersede it without showing its snapshot on the old map.
  await page.locator("#blackbox-load").click();
  await page.locator("#robot-cards .card[data-robot-id='robot-1']").waitFor({ state: "visible", timeout: 5000 });
  const replayCardText = await page.locator("#robot-cards .card[data-robot-id='robot-1']").textContent() ?? "";
  const replayCanvas = await page.locator("#map").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  assert.match(replayCardText, /주행 중/);
  assert.equal(await page.locator("#blackbox-toggle").getAttribute("aria-pressed"), "true");

  // Inject a real live state update through the isolated Colyseus room while
  // the browser is in replay. It deliberately uses the same robot ID but a
  // different pose/state. The browser's live subscription must not repaint
  // the replay scene, then the latest live state must be visible after exit.
  const liveRobot = room.state.robots.get(robotId);
  assert(liveRobot, "isolated live robot exists");
  const liveTarget = { x: Number(liveRobot.x) + 24, y: Number(liveRobot.y), theta: Number(liveRobot.theta) };
  const liveBeforeX = Number(liveRobot.x);
  room.send("commandRobot", { robotId, kind: "move", ...liveTarget, clientRequestId: crypto.randomUUID() });
  await until(() => ["running", "completed"].includes(String(room.state.robots.get(robotId)?.commandState)), "live command state update", 10000);
  await Bun.sleep(250);
  assert.notEqual(Number(room.state.robots.get(robotId)?.x), 40, "live pose differs from replay pose");
  assert.notEqual(Number(room.state.robots.get(robotId)?.x), liveBeforeX, "live pose was updated");
  assert.equal(await page.locator("#robot-cards .card[data-robot-id='robot-1']").textContent() ?? "", replayCardText, "live card update is isolated during replay");
  assert.equal(await page.locator("#map").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()), replayCanvas, "live pose/state does not repaint replay canvas");

  websocketSends = await page.evaluate(() => (window as any).__blackboxWebsocketSends as number);
  await page.locator('#modes [data-mode="operate"]').click();
  await page.locator("#tools-operate [data-tool=move]").click();
  await page.locator("#btn-cancel").click({ force: true });
  await page.keyboard.press("m");
  await Bun.sleep(100);
  assert.equal(await page.evaluate(() => (window as any).__blackboxWebsocketSends as number), websocketSends, "replay actions transmit no websocket command");
  assert.equal(replayCount, 2, "quick range reload completed two generations");

  await page.locator("#blackbox-toggle").click();
  await page.waitForFunction(() => document.querySelector("#blackbox-toggle")?.getAttribute("aria-pressed") === "false", undefined, { timeout: 10000 });
  await page.locator("#robot-cards .card[data-robot-id='robot-1']").waitFor({ state: "visible", timeout: 10000 });
  const liveCanvas = await page.locator("#map").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const liveCardText = await page.locator("#robot-cards .card[data-robot-id='robot-1']").textContent() ?? "";
  assert.notEqual(liveCanvas, replayCanvas, "live map redraws after replay exit");
  assert.notEqual(liveCardText, replayCardText, "latest live state returns after replay exit");

  // Exercise the shared send path without a preassigned runtime request ID.
  await page.locator("#robot-cards .card[data-robot-id='robot-1']").click();
  await page.locator("#tools-operate [data-tool=move]").click();
  const sendsBeforeMove = await page.evaluate(() => (window as any).__blackboxWebsocketSends as number);
  await page.locator("#map").click({ position: { x: 200, y: 200 } });
  await until(async () => await page.evaluate(() => (window as any).__blackboxWebsocketSends as number) > sendsBeforeMove, "HTTP-compatible move command transmission");

  // Leave a live runtime confirmation unresolved, swap source, then confirm.
  // The approval belongs to the old action generation and must not transmit.
  await page.locator("#robot-cards .card[data-robot-id='robot-1']").click();
  await page.locator('[data-runtime-action="disable"][data-robot-id="robot-1"]').click();
  await page.locator("#runtime-dialog").waitFor({ state: "visible" });
  const sendsBeforeStaleConfirm = await page.evaluate(() => (window as any).__blackboxWebsocketSends as number);
  await page.evaluate(() => (document.getElementById("blackbox-toggle") as HTMLButtonElement).click());
  await page.waitForFunction(() => document.querySelector("#blackbox-toggle")?.getAttribute("aria-pressed") === "true", undefined, { timeout: 10000 });
  await page.locator("#runtime-dialog-confirm").click({ force: true });
  await Bun.sleep(150);
  assert.equal(await page.evaluate(() => (window as any).__blackboxWebsocketSends as number), sendsBeforeStaleConfirm, "stale live confirmation transmits no command after replay transition");

  assert.deepEqual(errors, []);
  console.log("Blackbox browser check passed: isolated live injection, same-robot replay isolation, live restoration, historical asset race fencing, replay controls read-only, stale confirmation guard.");
} finally {
  await cleanup();
  console.log(`Isolated diagnostics preserved: ${root}`);
}
