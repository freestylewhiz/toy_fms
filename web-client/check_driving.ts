import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { Client } from "colyseus.js";
import { COLYSEUS_PORT, ROOM_NAME, MAP_WIDTH, MAP_HEIGHT } from "../shared/constants.ts";
import { isInflatedFree } from "../shared/occupancy.ts";
import { fitCamera } from "./src/camera.ts";

const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  (window as any).testSockets = [];
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      (window as any).testSockets.push(this);
    }
  };
});
const errors: string[] = [];
const room = await new Client(`ws://${new URL(baseUrl).hostname}:${COLYSEUS_PORT}`).joinOrCreate(ROOM_NAME);
room.onMessage("error", (e: { message: string }) => errors.push(e.message));
room.onMessage("commandAck", () => {});
async function until(check: () => boolean, label: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}; ${errors.join("; ")}`);
}
let robotId = "";
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#modes [data-mode=operate]").click();
  await page.locator('button[data-detail="fleet"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#robot-cards .card").length > 0);

  await until(() => [...(room.state?.robots?.values?.() ?? [])].some((r: any) => r.connected && r.status === "idle"), "idle connected robot", 5000);
  const state: any = [...room.state.robots.values()].find((r: any) => r.connected && r.status === "idle");
  robotId = state.id;
  const robot = page.locator("#robot-cards .card").filter({ has: page.locator(".id", { hasText: new RegExp(`^${robotId}$`) }) });
  await robot.click();
  const cardHandle = await robot.elementHandle();
  await robot.focus();
  await Bun.sleep(200);
  assert(await cardHandle!.evaluate(el => el.isConnected && document.activeElement === el), "telemetry preserves card identity and keyboard focus");
  assert.notEqual(await page.locator("#sel-robot-id").textContent(), "—");
  assert.match(await page.locator("#traffic-selected").textContent() ?? "", /M 이동 명령/);

  const start = { x: state.x, y: state.y };
  const target = [{ x: start.x + 24, y: start.y }, { x: start.x - 24, y: start.y }, { x: start.x, y: start.y + 24 }]
    .find(p => isInflatedFree(p.x, p.y) && ![...room.state.waypoints.values()].some((w: any) => Math.hypot(w.x - p.x, w.y - p.y) < 14));
  assert(target, "nearby free destination without waypoint snapping");
  async function moveTo(p: { x: number; y: number }) {
    await page.locator("#view-fit").click();
    const size = await page.locator("#viewport").evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
    const cam = fitCamera(size.w, size.h, MAP_WIDTH, MAP_HEIGHT);
    await page.locator("#tools-operate [data-tool=move]").click();
    // Chromium rounds input coordinates to screen pixels. Check the destination
    // represented by the actual pointer event, not the pre-rounded world point.
    await page.locator("#map").evaluate((el) => {
      el.addEventListener("pointerdown", (event) => {
        const e = event as PointerEvent;
        const rect = el.getBoundingClientRect();
        (el as HTMLElement).dataset.testPointer = JSON.stringify({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }, { once: true });
    });
    await page.locator("#map").click({ position: { x: cam.x + p.x * cam.scale, y: cam.y + p.y * cam.scale } });
    const pointer = JSON.parse((await page.locator("#map").getAttribute("data-test-pointer"))!);
    return { x: (pointer.x - cam.x) / cam.scale, y: (pointer.y - cam.y) / cam.scale };
  }
  const previousId = state.commandId;
  const clickedTarget = await moveTo(target);
  await until(() => state.commandId !== previousId && state.commandState === "running", "browser command reaches robot");
  await until(() => state.commandState === "completed", "robot completes browser command");
  console.log("arrival", { clickedTarget, actual: { x: state.x, y: state.y } });
  await until(() => Math.hypot(state.x - clickedTarget.x, state.y - clickedTarget.y) < 0.5, "arrival pose");
  await page.waitForFunction(() => /완료/.test(document.querySelector("#traffic-selected")?.textContent ?? ""));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#modes [data-mode=operate]").click();
  await page.locator('button[data-detail="fleet"]').click();
  await robot.click();
  await page.waitForFunction(() => /완료/.test(document.querySelector("#traffic-selected")?.textContent ?? ""));
  await moveTo(start);
  await until(() => state.commandState === "running", "return running");
  await page.locator("#btn-cancel").click();
  await until(() => state.commandState === "cancelled" && state.status === "idle", "robot cancellation");
  await page.waitForFunction(() => /취소/.test(document.querySelector("#traffic-selected")?.textContent ?? ""));
  const stopped = { x: state.x, y: state.y };
  await Bun.sleep(300);
  assert(Math.hypot(state.x - stopped.x, state.y - stopped.y) < 0.7, "stable stop");
  await page.screenshot({ path: "/tmp/bg-fms-driving-e2e.png", fullPage: true });

  await page.evaluate(() => {
    for (const socket of (window as any).testSockets as WebSocket[]) {
      if (socket.readyState === WebSocket.OPEN) socket.close(4000, "E2E outage");
    }
  });
  await page.waitForFunction(() => document.querySelector("#conn-label")?.textContent !== "online");
  assert(await page.locator("#btn-cancel").isDisabled(), "commands locked while disconnected");
  await page.waitForFunction(() => document.querySelector("#conn-label")?.textContent === "online", undefined, { timeout: 15000 });
  await robot.click();
  await page.waitForFunction(() => /취소/.test(document.querySelector("#traffic-selected")?.textContent ?? ""));

  await page.locator("#modes [data-mode=scene]").click();
  await page.locator(".map-library-drawer summary").click();
  await page.locator('[data-map-target="1st_floor"]').click();
  await page.waitForFunction(() => document.body.dataset.map === "1st_floor");
  await page.locator("#tools-scene [data-tool=waypoint]").click();
  assert.equal(await page.locator("#tools-scene [data-tool=select]").getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#status-msg").textContent() ?? "", /미리보기/);

  assert.deepEqual(errors, []);
  console.log("Browser E2E passed: UI dispatch, gRPC motion/completion, UI result, reload snapshot, UI cancellation/stable stop, WebSocket reconnect, read-only preview. Screenshot: /tmp/bg-fms-driving-e2e.png");
} catch (error) {
  console.error("E2E UI state", await page.locator("#conn-label").textContent(), await page.locator("#traffic-selected").textContent(), await page.locator("#status-msg").textContent());
  throw error;
} finally {
  if (robotId) room.send("cancelRobot", { robotId });
  await room.leave();
  await browser.close();
}
