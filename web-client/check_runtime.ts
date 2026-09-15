/** Live runtime recovery check. Creates/deletes only its own zone; uses one idle
 * enabled virtual robot and restores its enabled state in finally. */
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { Client } from "colyseus.js";
import { COLYSEUS_PORT, ROOM_NAME } from "../shared/constants.ts";
import type { ResourceOccupancy, RuntimeAck } from "../shared/robotRuntime.ts";

const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174";
const room = await new Client(`ws://${new URL(baseUrl).hostname}:${COLYSEUS_PORT}`).joinOrCreate(ROOM_NAME);
const errors: string[] = [];
room.onMessage("error", (e: { message: string }) => errors.push(e.message));
room.onMessage("editorAck", () => {});
room.onMessage("commandAck", () => {});
const acks = new Map<string, RuntimeAck>();
room.onMessage("runtimeAck", (ack: RuntimeAck) => acks.set(ack.requestId, ack));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", e => errors.push(String(e)));
const zoneId = `runtime-e2e-${crypto.randomUUID()}`;
let robot: any;
let zoneCreated = false;
const occupancies = (): ResourceOccupancy[] => JSON.parse((room.state as any)?.runtimeOccupanciesJson || "[]");
async function until(check: () => boolean, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}; ${errors.join("; ")}`);
}
async function enableRobot() {
  const requestId = crypto.randomUUID();
  room.send("setRobotControl", { robotId: robot.id, enabled: true, expectedEpoch: robot.controlEpoch, requestId });
  await until(() => acks.has(requestId), "reactivation acknowledgement");
  assert.equal(acks.get(requestId)?.ok, true, acks.get(requestId)?.message);
  await until(() => robot.fmsControlState === "enabled" && robot.controlReady, "reactivation synchronized");
}

try {
  await until(() => [...((room.state as any)?.robots?.values?.() ?? [])].some((r: any) =>
    r.connected && r.fmsControlState === "enabled" && r.controlReady && r.workState === "idle"), "idle enabled robot");
  robot = [...(room.state as any).robots.values()].find((r: any) =>
    r.connected && r.fmsControlState === "enabled" && r.controlReady && r.workState === "idle");
  const x = robot.x, y = robot.y;
  room.send("editorUpsert", { kind: "zone", id: zoneId, family: "scene", zoneKind: "corridor",
    name: "런타임 복구 검증", theta: 0, capacity: 1,
    polygon: [{x:x-20,y:y-20},{x:x+20,y:y-20},{x:x+20,y:y+20},{x:x-20,y:y+20}] });
  zoneCreated = true;
  await until(() => occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id && o.state === "occupied"), "actual occupancy persisted and published");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('#modes [data-mode="scene"]').click();
  await page.locator(`#outliner button[data-kind="zone"][data-id="${zoneId}"]`).click();
  await page.locator('button[data-detail="fleet"]').click();
  const release = page.locator(`[data-runtime-action="release"][data-resource-id="${zoneId}"][data-robot-id="${robot.id}"]`);
  await release.click();
  await page.locator("#runtime-dialog").waitFor({ state: "visible" });
  await page.locator("#runtime-dialog-cancel").click();
  assert.equal(robot.fmsControlState, "enabled", "cancel leaves control enabled");
  assert(occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id), "cancel preserves occupancy");
  await release.click();
  await page.locator("#runtime-dialog-confirm").click();
  await until(() => robot.fmsControlState === "disabled" && !occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id), "release and disable together");
  const seenAt = robot.lastSeenAt;
  await until(() => robot.lastSeenAt > seenAt, "disabled robot keeps reporting telemetry");
  await Bun.sleep(500);
  assert(!occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id), "telemetry cannot resurrect released occupancy");
  await page.locator('#modes [data-mode="operate"]').click();
  await page.locator('button[data-detail="fleet"]').click();
  await page.locator("#robot-cards .card").filter({ has: page.locator(".id", { hasText: new RegExp(`^${robot.id}$`) }) }).click();
  await page.screenshot({ path: "/tmp/atlas-runtime-disabled.png", fullPage: true });
  const enable = page.locator(`[data-runtime-action="enable"][data-robot-id="${robot.id}"]`);
  await enable.click();
  await page.locator("#runtime-dialog-confirm").click();
  await until(() => robot.fmsControlState === "enabled" && robot.controlReady, "UI reactivation");
  assert.equal(robot.workState, "idle", "old task is not replayed");
  await page.screenshot({ path: "/tmp/atlas-runtime-enabled.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Runtime browser E2E passed: occupancy, confirmation cancellation, atomic release+disable, ongoing telemetry, no reacquisition, explicit synchronized reactivation.");
} finally {
  try {
    try { if (robot?.fmsControlState === "disabled" && robot.connected) await enableRobot(); }
    catch (error) { console.error("Runtime fixture robot restore failed", error); }
    if (zoneCreated) {
      room.send("editorDelete", { kind: "zone", id: zoneId });
      await until(() => !(room.state as any).zones.has(zoneId), "fixture cleanup");
    }
  } finally { await room.leave(); await browser.close(); }
}
