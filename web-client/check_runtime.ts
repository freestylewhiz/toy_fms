/** Live runtime recovery check. Creates/deletes only its own zone; uses one idle
 * enabled virtual robot and restores its enabled state in finally. */
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { Client } from "colyseus.js";
import { COLYSEUS_PORT, MAP_ID, ROOM_NAME } from "../shared/constants.ts";
import type { ResourceOccupancy, RuntimeAck } from "../shared/robotRuntime.ts";

const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174";
const browserUrl = new URL(baseUrl);
// Make the browser use exactly the same isolated ports as this test client.
if (process.env.FMS_PORT_OFFSET) browserUrl.searchParams.set("portOffset", process.env.FMS_PORT_OFFSET);
browserUrl.searchParams.set("map", MAP_ID);
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
const secondZoneId = `runtime-e2e-${crypto.randomUUID()}`;
let robot: any;
const zoneIds: string[] = [];
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
  zoneIds.push(zoneId);
  await until(() => occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id && o.state === "occupied"), "actual occupancy persisted and published");

  await page.goto(browserUrl.toString(), { waitUntil: "networkidle" });
  await page.locator('#modes [data-mode="operate"]').click();
  await page.locator('button[data-detail="fleet"]').click();
  await page.locator("#robot-cards .card").filter({ has: page.locator(".id", { hasText: new RegExp(`^${robot.id}$`) }) }).click();
  const release = page.locator(`[data-runtime-action="release"][data-resource-id="${zoneId}"][data-robot-id="${robot.id}"]`);
  await release.click();
  await page.locator("#runtime-dialog").waitFor({ state: "visible" });
  await page.locator("#runtime-dialog-cancel").click();
  assert.equal(robot.fmsControlState, "enabled", "cancel leaves control enabled");
  assert(occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id), "cancel preserves occupancy");
  await release.click();
  await page.locator("#runtime-dialog-confirm").click();
  await until(() => robot.fmsControlState === "disabled" && !occupancies().some(o => o.resourceRef.id === zoneId && o.robotId === robot.id), "release and disable together");
  assert.equal(robot.x, x, "disabled robot body remains present at its last reported x");
  assert.equal(robot.y, y, "disabled robot body remains present at its last reported y");
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

  // Exercise the robot-level control action with a live claim. This is distinct
  // from the selected-resource release flow above: disabling the robot must
  // clear every logical claim, including teleporter reservations and queues.
  room.send("editorUpsert", { kind: "zone", id: secondZoneId, family: "scene", zoneKind: "corridor",
    name: "운영 제외 전체 해제 검증", theta: 0, capacity: 1,
    polygon: [{x:x-20,y:y-20},{x:x+20,y:y-20},{x:x+20,y:y+20},{x:x-20,y:y+20}] });
  zoneIds.push(secondZoneId);
  await until(() => occupancies().some(o => o.resourceRef.id === secondZoneId && o.robotId === robot.id && o.state === "occupied"), "second occupancy persisted and published");
  await page.locator('#modes [data-mode="operate"]').click();
  await page.locator('button[data-detail="fleet"]').click();
  await page.locator("#robot-cards .card").filter({ has: page.locator(".id", { hasText: new RegExp(`^${robot.id}$`) }) }).click();
  const disable = page.locator(`[data-runtime-action="disable"][data-robot-id="${robot.id}"]`);
  await disable.click();
  await page.locator("#runtime-dialog").waitFor({ state: "visible" });
  const disableWarning = await page.locator("#runtime-dialog .dialog-note").textContent();
  assert.match(disableWarning ?? "", /모든 논리 점유·예약·대기열\(텔레포터 포함\)을 해제/);
  assert.match(disableWarning ?? "", /위치·상태 보고는 계속/);
  assert.match(disableWarning ?? "", /명시적인 운영 재개와 재동기화/);
  assert.match(disableWarning ?? "", /텔레포터 포함/);
  await page.locator("#runtime-dialog-cancel").click();
  assert.equal(robot.fmsControlState, "enabled", "robot-level cancellation leaves control enabled");
  assert(occupancies().some(o => o.robotId === robot.id), "robot-level cancellation preserves all claims");
  await disable.click();
  await page.locator("#runtime-dialog-confirm").click();
  await until(() => robot.fmsControlState === "disabled", "robot-level disable acknowledged");
  await until(() => !occupancies().some(o => o.robotId === robot.id), `robot-level disable releases every logical claim (remaining=${JSON.stringify(occupancies().filter(o => o.robotId === robot.id))})`);
  const disabledSeenAt = robot.lastSeenAt;
  await until(() => robot.lastSeenAt > disabledSeenAt, "disabled robot continues telemetry after robot-level disable");
  let disabledCommandError = "";
  const expectedErrorCount = errors.length;
  room.onMessage("error", (error: { message?: string }) => { if (!disabledCommandError) disabledCommandError = String(error.message ?? ""); });
  room.send("commandRobot", { robotId: robot.id, kind: "move", x: robot.x, y: robot.y, theta: robot.theta });
  await until(() => Boolean(disabledCommandError), "disabled robot rejects move/dock operational command");
  assert.match(disabledCommandError, /운영 상태|동기화/);
  errors.splice(expectedErrorCount);
  const poseButton = page.locator(`[data-runtime-action="pose"][data-robot-id="${robot.id}"]`);
  await poseButton.waitFor({ state: "visible" });
  const poseRequestId = crypto.randomUUID();
  let poseAck: any;
  room.onMessage("virtualRobotPoseAck", (ack: any) => { if (ack.requestId === poseRequestId) poseAck = ack; });
  room.send("setVirtualRobotPose", { testOnly: true, robotId: robot.id, mapId: MAP_ID, x: robot.x, y: robot.y, theta: robot.theta, requestId: poseRequestId, expectedEpoch: robot.controlEpoch });
  await until(() => !!poseAck, "disabled test-position acknowledgement");
  assert.equal(poseAck.ok ?? poseAck.accepted, true, poseAck.reason);
  assert.equal(robot.fmsControlState, "disabled", "test position does not implicitly resume operations");
  await page.locator(`[data-runtime-action="enable"][data-robot-id="${robot.id}"]`).click();
  await page.locator("#runtime-dialog-confirm").click();
  await until(() => robot.fmsControlState === "enabled" && robot.controlReady, "explicit robot-level reactivation");
  await page.screenshot({ path: "/tmp/atlas-runtime-enabled.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Runtime browser E2E passed: selected release, robot-level all-claim release, teleporter-aware confirmation, physical body, ongoing telemetry, cancellation, no reacquisition, explicit synchronized reactivation.");
} finally {
  try {
    try { if (robot?.fmsControlState === "disabled" && robot.connected) await enableRobot(); }
    catch (error) { console.error("Runtime fixture robot restore failed", error); }
    for (const id of zoneIds) room.send("editorDelete", { kind: "zone", id });
    for (const id of zoneIds) await until(() => !(room.state as any).zones.has(id), `fixture cleanup: ${id}`);
  } finally { await room.leave(); await browser.close(); }
}
