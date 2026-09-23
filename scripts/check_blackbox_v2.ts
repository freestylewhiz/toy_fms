/** Real Large Lab recordings and Chromium; every mutation uses isolated data/ports. */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";
import { settledPoseJournal, writeTransferJournal } from "../virtual-robot/src/transferJournal.ts";
import { BlackboxQuery } from "../server/src/blackbox/query.ts";

const offset = Number(process.env.E2E_PORT_OFFSET ?? 12200);
assert(Number.isInteger(offset) && offset >= 1000 && offset < 15000, "isolated offset required");
const root = mkdtempSync(join(tmpdir(), "fms-blackbox-v2-"));
const base = `http://127.0.0.1:${5174 + offset}`;
const children: Bun.Subprocess[] = [];
const env = { ...process.env, FMS_MAP_ID: "large_lab", FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root,
  TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite"), FMS_WEB_PUBLIC_DIR: join(root, "public"), FMS_BLACKBOX: "1" };
const checks: Record<string, unknown> = {};
const errors: string[] = [];
const pauseResults: any[] = [], commandResults: any[] = [];
let room: any, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined;
function spawn(name: string, file: string, args: string[] = []) {
  const child = Bun.spawn(["bun", file, ...args], { env, stdout: Bun.file(join(root, `${name}.log`)), stderr: Bun.file(join(root, `${name}.err`)) });
  children.push(child); return child;
}
async function until(fn: () => boolean | Promise<boolean>, label: string, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}; diagnostics ${root}`);
}
const robot = (id = "robot-1") => room?.state?.robots?.get(id);
async function pause(id: string, paused: boolean) {
  const requestId = crypto.randomUUID();
  room.send("robot_motion_pause", { robotId: id, requestId, paused, expectedEpoch: robot(id).controlEpoch });
  await until(() => pauseResults.some(r => r.requestId === requestId && !r.pending), "motion pause ACK");
  assert(pauseResults.findLast(r => r.requestId === requestId && !r.pending).ok);
  await until(() => robot(id).operatorPaused === paused && !robot(id).operatorPausePending, "motion pause observed");
}
async function move(id: string, x: number, y: number) {
  const clientRequestId = crypto.randomUUID();
  const before = commandResults.length;
  room.send("commandRobot", { robotId: id, kind: "move", x, y, theta: 0, clientRequestId });
  await until(() => commandResults.slice(before).some(r => r.robotId === id), "move ACK");
  const ack = commandResults.slice(before).find(r => r.robotId === id);
  assert(ack.commandId && ack.operationId, JSON.stringify(ack));
  return ack;
}
async function api(path: string, options?: RequestInit) {
  const response = await fetch(base + path, options);
  const body = await response.json() as any;
  assert(response.ok, JSON.stringify({ path, status: response.status, body }));
  return body;
}
async function seek(timeMs: number) {
  await page!.locator("#blackbox-seek").evaluate((input: HTMLInputElement, value) => {
    input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true }));
  }, timeMs);
  await until(async () => Number(await page!.locator("#map").getAttribute("data-replay-time")) === timeMs, "seek applies recorded time");
}
async function windowInputs(fromMs: number, toMs: number) {
  for (const [selector, value] of [["#blackbox-time-from", fromMs], ["#blackbox-time-to", toMs]] as const) {
    const formatted = await page!.evaluate(ms => {
      const date = new Date(ms); return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    }, value);
    await page!.locator(selector).fill(formatted);
  }
  const response = page!.waitForResponse(r => r.url().includes("/api/blackbox/window?") && r.request().method() === "GET");
  await page!.locator("#blackbox-window-load").click();
  await (await response).finished();
  await page!.locator('#map[data-replay-ready="true"]').waitFor({ state: "attached" });
}

try {
  for (const seed of [{ id: "robot-1", x: 1400, y: 1300, theta: 0 }, { id: "robot-2", x: 1400, y: 1500, theta: 0 }]) {
    writeTransferJournal(join(root, "robots", `robot-${seed.id}.teleporter.json`), settledPoseJournal(seed.id, "large_lab", seed));
  }
  spawn("server", "server/src/index.ts");
  spawn("web", "web-client/src/server.ts");
  await until(async () => {
    try { room = await new Client(`ws://127.0.0.1:${2569 + offset}`).joinOrCreate("floor"); return true; }
    catch { return false; }
  }, "Large Lab room");
  room.onMessage("*", () => {});
  room.onMessage("commandAck", (r: any) => commandResults.push(r));
  room.onMessage("robot_motion_pause_result", (r: any) => pauseResults.push(r));
  for (const id of ["robot-1", "robot-2"]) spawn(id, "virtual-robot/src/index.ts", ["--id", id]);
  await until(() => ["robot-1", "robot-2"].every(id => robot(id)?.connected && robot(id)?.controlReady && !robot(id)?.operatorPausePending), "two physical simulators ready");
  await until(async () => { try { return (await fetch(base + "/runtime-config.json")).ok; } catch { return false; } }, "isolated web ready");
  const fromMs = Date.now();
  const first = await move("robot-1", 1800, 1300);
  const second = await move("robot-2", 1800, 1500);
  await until(() => robot().x > 1430, "first robot really moves");
  await pause("robot-1", true);
  const pausedPose = { x: robot().x, y: robot().y, theta: robot().theta };
  const pausedAt = Date.now();
  await Bun.sleep(1000);
  assert.equal(robot().x, pausedPose.x);
  await pause("robot-1", false);
  await until(() => robot().commandState === "completed" && robot("robot-2").commandState === "completed", "both real commands complete", 45000);
  const toMs = Date.now();
  // Recording is asynchronous across processes. Wait for the persisted FMS
  // checkpoint rather than pinning a window after an arbitrary short sleep.
  const catchupStarted = performance.now();
  await until(async () => {
    const catalog = await api("/api/blackbox/catalog?mapId=large_lab");
    return catalog.latestCheckpoint?.timeMs >= toMs;
  }, "completed scene persisted by asynchronous recorder", 10000);
  checks.recordingCatchupMs = Math.round(performance.now() - catchupStarted);
  checks.recordedRealMotionAndPause = { firstOperation: first.operationId, secondOperation: second.operationId, fromMs, toMs, pausedAt, pausedPose };
  const catalog = await api("/api/blackbox/catalog?mapId=large_lab");
  assert(catalog.latestCheckpoint && catalog.assets?.mapUrl, "idle scenes are discoverable without an operation boundary");
  assert.equal(catalog.assets.width, 10000);
  const windowFrom = Math.floor(fromMs / 1000) * 1000, windowTo = Math.ceil(toMs / 1000) * 1000;
  const recorded = await api(`/api/blackbox/window?mapId=large_lab&fromMs=${windowFrom}&toMs=${windowTo}`);
  let cursor = recorded.nextCursor;
  for (let i = 0; cursor && i < 20; i++) {
    const next = await api(`/api/blackbox/window?mapId=large_lab&fromMs=${recorded.fromMs}&toMs=${recorded.toMs}&asOf=${recorded.asOf}&cursor=${encodeURIComponent(cursor)}`);
    recorded.events.push(...next.events); cursor = next.nextCursor;
  }
  assert(!cursor, "bounded test window fully retrieved");
  const frames = [recorded.checkpoint, ...recorded.events.filter((e: any) => e.category === "frame")].sort((a: any, b: any) => a.timeMs - b.timeMs || a.sequence - b.sequence);
  const stateRobot = (event: any, id: string) => Object.values(event.payload.state.robots).find((r: any) => r.id === id) as any;
  const pauseFrame = frames.find((e: any) => e.timeMs >= pausedAt && stateRobot(e, "robot-1")?.operatorPaused);
  assert(pauseFrame, "real recorded pause frame");
  const endFrame = frames.findLast((e: any) => stateRobot(e, "robot-1")?.commandState === "completed");
  assert(endFrame, "real recorded completed frame");
  assert.equal(stateRobot(endFrame, "robot-1").x, 1800);
  assert((await fetch(base + recorded.assets.mapUrl)).ok, "archived full-size map exists");
  checks.actualRecordedFramesAndArchivedMap = { frameCount: frames.length, asset: recorded.assets.mapUrl };
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  page.on("pageerror", error => errors.push(String(error)));
  const rasterPixelProbe = () => {
    // Keep an image-only reference rendered with the same canvas transform.
    // The regression compares these actual raster pixels with the finished
    // map canvas, so an off-canvas draw call or an opaque covering layer fails.
    (window as any).__blackboxTestMapDraw = null;
    (window as any).__blackboxTestMapReference = null;
    (window as any).__blackboxTestHistoricalUrl = "";
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/blackbox/assets/") && url.endsWith(".png")) (window as any).__blackboxTestHistoricalUrl = new URL(url, location.href).href;
      return originalFetch(input, init);
    }) as typeof window.fetch;
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      const source = args[0];
      const historicalUrl = (window as any).__blackboxTestHistoricalUrl as string;
      const sourceUrl = source instanceof HTMLImageElement ? source.src : historicalUrl;
      if (this.canvas.id === "map" && sourceUrl.includes("/api/blackbox/assets/")
        && (source instanceof HTMLImageElement || (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap))) {
        const sourceWidth = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
        const sourceHeight = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
        (window as any).__blackboxTestMapDraw = { src: sourceUrl, width: sourceWidth, height: sourceHeight, worldWidth: args[3], worldHeight: args[4] };
        const reference = document.createElement("canvas");
        reference.width = this.canvas.width;
        reference.height = this.canvas.height;
        const referenceContext = reference.getContext("2d")!;
        referenceContext.setTransform(this.getTransform());
        (referenceContext.drawImage as any)(source, ...args.slice(1));
        (window as any).__blackboxTestMapReference = reference;
      }
      return (original as any).apply(this, args);
    };
  };
  await page.addInitScript(rasterPixelProbe);
  await page.goto(`${base}/?map=large_lab&portOffset=${offset}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !(document.getElementById("blackbox-toggle") as HTMLButtonElement | null)?.disabled);
  if (await page.locator("#map-select").inputValue() !== "large_lab") await page.locator("#map-select").selectOption("large_lab");
  await page.locator("#modes [data-mode=operate]").click();
  const openedAt = performance.now();
  await page.locator("#blackbox-toggle").click();
  await page.locator('#map[data-replay-ready="true"]').waitFor({ state: "attached" });
  await page.waitForFunction(() => (window as any).__blackboxTestMapDraw?.src.includes("/api/blackbox/assets/")
    && (window as any).__blackboxTestMapDraw?.width > 0 && (window as any).__blackboxTestMapDraw?.width <= 4096);
  const drawnHistoricalRaster = await page.evaluate(() => (window as any).__blackboxTestMapDraw);
  assert.equal(drawnHistoricalRaster.height, 4096);
  assert.equal(drawnHistoricalRaster.worldWidth, 10000, "raster downsampling preserves the historical world extent");
  assert.equal(drawnHistoricalRaster.worldHeight, 10000, "raster downsampling preserves the historical world extent");
  checks.autoEntryAndRealMapDrawMs = Math.round(performance.now() - openedAt);
  assert.equal(await page.locator("#map").getAttribute("data-replay-map-asset"), "historical");
  const assertHistoricalRasterVisible = async (target: Page, label: string) => {
    const pixels = await target.locator("#map").evaluate((canvas: HTMLCanvasElement) => {
      const reference = (window as any).__blackboxTestMapReference as HTMLCanvasElement | null;
      if (!reference || reference.width !== canvas.width || reference.height !== canvas.height) return null;
      const actual = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      const expected = reference.getContext("2d")!.getImageData(0, 0, reference.width, reference.height).data;
      let covered = 0, matching = 0, expectedDark = 0, visibleDark = 0, expectedLight = 0, visibleLight = 0;
      for (let i = 0; i < expected.length; i += 4) {
        if (expected[i + 3] === 0) continue;
        covered++;
        if (Math.abs(actual[i] - expected[i]) <= 2 && Math.abs(actual[i + 1] - expected[i + 1]) <= 2 && Math.abs(actual[i + 2] - expected[i + 2]) <= 2) matching++;
        const expectedLuma = (expected[i] + expected[i + 1] + expected[i + 2]) / 3;
        const actualLuma = (actual[i] + actual[i + 1] + actual[i + 2]) / 3;
        if (expectedLuma < 40) { expectedDark++; if (actualLuma < 40) visibleDark++; }
        if (expectedLuma > 210) { expectedLight++; if (actualLuma > 210) visibleLight++; }
      }
      return { covered, matching, ratio: matching / Math.max(1, covered), expectedDark, visibleDark, expectedLight, visibleLight };
    });
    assert(pixels && pixels.covered > 100_000, `${label}: archived map covers visible canvas pixels: ${JSON.stringify(pixels)}`);
    assert(pixels.expectedDark > 10_000 && pixels.visibleDark > 8_000 && pixels.expectedLight > 10_000 && pixels.visibleLight > 8_000,
      `${label}: archived raster dark and light regions are visible: ${JSON.stringify(pixels)}`);
    assert(pixels.ratio > 0.9, `${label}: archived raster remains visible in the final canvas: ${JSON.stringify(pixels)}`);
    return pixels;
  };
  checks.entryRasterPixels = await assertHistoricalRasterVisible(page, "replay entry");
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForFunction(() => {
    const canvas = document.getElementById("map") as HTMLCanvasElement | null;
    const reference = (window as any).__blackboxTestMapReference as HTMLCanvasElement | null;
    return Boolean(canvas && reference && reference.width === canvas.width && reference.height === canvas.height);
  });
  checks.resizedRasterPixels = await assertHistoricalRasterVisible(page, "replay resize");
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.waitForFunction(() => {
    const canvas = document.getElementById("map") as HTMLCanvasElement | null;
    const reference = (window as any).__blackboxTestMapReference as HTMLCanvasElement | null;
    return Boolean(canvas && reference && reference.width === canvas.width && reference.height === canvas.height);
  });
  checks.restoredRasterPixels = await assertHistoricalRasterVisible(page, "replay resize restore");
  await windowInputs(windowFrom, windowTo);
  await seek(pauseFrame.timeMs);
  checks.seekRasterPixels = await assertHistoricalRasterVisible(page, "seek");
  await page.locator("button[data-detail=fleet]").click();
  const card = page.locator("#robot-cards .card[data-robot-id='robot-1']");
  await until(async () => (await card.innerText()).includes("일시정지"), "recorded manual pause displayed");
  assert.equal(Number(await card.getAttribute("data-x")), stateRobot(pauseFrame, "robot-1").x);
  assert.equal(Number(await card.getAttribute("data-y")), stateRobot(pauseFrame, "robot-1").y);
  await card.click();
  assert(await page.locator("#robot-motion-resume").isDisabled(), "recorded paused robot cannot be resumed through live control");
  const pausedCanvas = await page.locator("#map").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await Bun.sleep(750);
  assert.equal(await page.locator("#map").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()), pausedCanvas, "paused replay is not repainted from live state");
  await page.screenshot({ path: join(root, "paused-replay.png") });
  await seek(endFrame.timeMs);
  await until(async () => (await card.innerText()).includes("완료"), "recorded completion displayed");
  assert.equal(Number(await card.getAttribute("data-x")), 1800);
  checks.seekReproducesPauseAndCompletion = true;
  await seek(pauseFrame.timeMs);
  await page.locator("#blackbox-speed").selectOption("4");
  await page.locator("#blackbox-play").click();
  await until(async () => Number(await page!.locator("#map").getAttribute("data-replay-time")) > pauseFrame.timeMs + 100, "playback advances recorded clock");
  await page.locator("#blackbox-play").click();
  const stoppedClock = await page.locator("#map").getAttribute("data-replay-time");
  await Bun.sleep(400);
  assert.equal(await page.locator("#map").getAttribute("data-replay-time"), stoppedClock);
  checks.playPauseAndSpeed = true;
  if (process.env.E2E_RESET === "1") {
    const active = await move("robot-1", 1860, 1300);
    await until(() => robot().x > 1810, "motion before record reset");
    await pause("robot-1", true);
    const preserved = { x: robot().x, y: robot().y, theta: robot().theta, epoch: robot().controlEpoch, commandId: robot().commandId,
      path: JSON.stringify(robot().path.toJSON()), localPath: JSON.stringify(robot().localPath.toJSON()) };
    assert.equal(preserved.commandId, active.commandId);
    const priorGeneration = (await api("/api/blackbox/generation")).generation;
    const manager = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    manager.on("pageerror", error => errors.push(String(error)));
    await manager.goto(`${base}/?map=large_lab&portOffset=${offset}`, { waitUntil: "domcontentloaded" });
    await manager.waitForFunction(() => !(document.getElementById("blackbox-toggle") as HTMLButtonElement | null)?.disabled);
    if (await manager.locator("#map-select").inputValue() !== "large_lab") await manager.locator("#map-select").selectOption("large_lab");
    await manager.locator("#modes [data-mode=operate]").click();
    await manager.locator("button[data-detail=fleet]").click();
    await manager.locator("#blackbox-clear").click();
    await manager.locator("#runtime-dialog-cancel").click();
    assert.deepEqual((await api("/api/blackbox/generation")).generation, priorGeneration, "cancel does not reset recordings");
    await manager.locator("#blackbox-clear").click();
    const resetResponse = manager.waitForResponse(r => r.url().endsWith("/api/blackbox/reset") && r.request().method() === "POST");
    await manager.locator("#runtime-dialog-confirm").click();
    const response = await resetResponse;
    const reset = await response.json();
    assert(response.ok(), JSON.stringify(reset));
    assert.equal(reset.cleared, true);
    assert.notEqual(reset.generation.id, priorGeneration.id);
    await until(async () => await page!.locator("#map").getAttribute("data-replay-ready") === "false", "other browser invalidates deleted replay", 15000);
    assert.equal(robot().x, preserved.x); assert.equal(robot().y, preserved.y); assert.equal(robot().theta, preserved.theta);
    assert.equal(robot().controlEpoch, preserved.epoch); assert.equal(robot().commandId, preserved.commandId);
    assert.equal(robot().operatorPaused, true); assert.equal(robot().commandState, "running");
    assert.equal(JSON.stringify(robot().path.toJSON()), preserved.path); assert.equal(JSON.stringify(robot().localPath.toJSON()), preserved.localPath);
    if (recorded.nextCursor) {
      const stale = await fetch(`${base}/api/blackbox/window?mapId=large_lab&fromMs=${recorded.fromMs}&toMs=${recorded.toMs}&asOf=${recorded.asOf}&cursor=${encodeURIComponent(recorded.nextCursor)}`);
      assert.equal(stale.status, 409, "old generation cursor cannot read new records");
    }
    await until(async () => {
      const fresh = await api("/api/blackbox/catalog?mapId=large_lab");
      return fresh.generation.id === reset.generation.id && fresh.latestCheckpoint?.timeMs >= reset.generation.createdAt;
    }, "idle paused scene is recorded after reset");
    await pause("robot-1", false);
    await until(() => robot().commandState === "completed", "same command completes after record reset");
    checks.resetPreservesActiveMotionAndInvalidatesOldReaders = true;
    await manager.locator("#blackbox-toggle").click();
    await manager.locator('#map[data-replay-ready="true"]').waitFor({ state: "attached" });
    await manager.screenshot({ path: join(root, "after-reset-replay.png") });
    await manager.close();
    checks.confirmedResetPreservesMotionAndRestartsRecording = true;
  }
  const latest = await api("/api/blackbox/catalog?mapId=large_lab");
  const assetParts = /\/assets\/([^/]+)\/([^/?]+)/.exec(latest.assets.mapUrl)!;
  const assetPath = await new BlackboxQuery(join(root, "blackbox")).assetPath(assetParts[1], assetParts[2]);
  assert(assetPath.startsWith(root + "/"), "only isolated archived assets may be changed");
  const missingContext = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await missingContext.addInitScript(rasterPixelProbe);
  const missingPage = await missingContext.newPage();
  missingPage.on("pageerror", error => errors.push(String(error)));
  await rename(assetPath, assetPath + ".test-hidden");
  try {
    await missingPage.goto(`${base}/?map=large_lab&portOffset=${offset}`, { waitUntil: "domcontentloaded" });
    await missingPage.waitForFunction(() => !(document.getElementById("blackbox-toggle") as HTMLButtonElement | null)?.disabled);
    if (await missingPage.locator("#map-select").inputValue() !== "large_lab") await missingPage.locator("#map-select").selectOption("large_lab");
    await missingPage.locator("#blackbox-toggle").click();
    await missingPage.locator('#blackbox-loading[data-state="error"]').waitFor({ state: "visible" });
    assert.notEqual(await missingPage.locator("#map").getAttribute("data-replay-ready"), "true");
    await missingPage.screenshot({ path: join(root, "missing-map-error.png") });
  } finally {
    await rename(assetPath + ".test-hidden", assetPath);
  }
  await missingPage.locator("#blackbox-toggle").click();
  await missingPage.locator("#blackbox-toggle").click();
  await missingPage.locator('#map[data-replay-ready="true"]').waitFor({ state: "attached" });
  checks.recoveredRasterPixels = await assertHistoricalRasterVisible(missingPage, "recovery after missing historical map");
  await missingContext.close();
  checks.missingArchivedMapFailsExplicitlyAndRecovers = true;
  assert.deepEqual(errors, []);
  const result = { result: "PASS", root, checks, errors };
  await Bun.write(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await Bun.write(join(root, "failure.json"), JSON.stringify({ error: String(error), checks, errors }, null, 2));
  try { await page?.screenshot({ path: join(root, "failure.png") }); } catch {}
  if (browser) {
    let index = 0;
    for (const context of browser.contexts()) for (const openPage of context.pages()) {
      try {
        await Bun.write(join(root, `failure-page-${index}.txt`), await openPage.locator("body").innerText());
        await openPage.screenshot({ path: join(root, `failure-page-${index++}.png`) });
      } catch {}
    }
  }
  throw error;
} finally {
  try { await room?.leave(); } catch {}
  try { await browser?.close(); } catch {}
  for (const child of children) { try { if (child.exitCode === null) child.kill(); await child.exited; } catch {} }
  console.log(`Isolated diagnostics preserved: ${root}`);
}
