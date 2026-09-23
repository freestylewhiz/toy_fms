import { chromium } from "playwright";
import { strict as assert } from "node:assert";
import { Client } from "colyseus.js";
import { COLYSEUS_PORT, MAP_HEIGHT, MAP_WIDTH, ROOM_NAME } from "../shared/constants.ts";
import { isFree } from "../shared/occupancy.ts";
import { fitCamera } from "./src/camera.ts";

// Inspector E2E. The server must already be running on the usual development ports.
// Every fixture uses a UUID so a failed run can never collide with a real resource.
const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const room = await new Client(`ws://${new URL(baseUrl).hostname}:${COLYSEUS_PORT}`).joinOrCreate(ROOM_NAME);
const errors: string[] = [];
room.onMessage("error", (p: { message?: string } | string) => errors.push(typeof p === "string" ? p : p.message ?? "server error"));
room.onMessage("editorAck", () => {});
room.onMessage("obstacleAck", () => {});
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const suffix = crypto.randomUUID();
const zoneId = `e2e-zone-${suffix}`;
const nodeId = `e2e-node-${suffix}`;
const node2Id = `e2e-node2-${suffix}`;
const chargerId = `e2e-charger-${suffix}`;
const stationId = `e2e-station-${suffix}`;
const edgeId = `e2e-edge-${suffix}`;
const portalId = `e2e-portal-${suffix}`;
const railId = `e2e-rail-${suffix}`;
const batchIds = [`e2e-batch1-${suffix}`, `e2e-batch2-${suffix}`];
const zonePolygon = [{ x: 900, y: 300 }, { x: 980, y: 300 }, { x: 980, y: 360 }, { x: 900, y: 360 }];
const nodePoint = [[300, 400], [720, 600], [320, 360], [500, 500]].find(([x, y]) => isFree(x, y));
const waypointWorld = [[720, 600], [300, 400], [500, 500]].find(([x, y]) => isFree(x, y));
assert(nodePoint, "known free node fixture point");
assert(waypointWorld, "known free waypoint fixture point");
let obstacleId = "";
let createdWaypointId = "";
let createdZoneId = "";

async function until(check: () => boolean, label: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(50); }
  throw new Error(`Timed out: ${label}; ${errors.join("; ")}`);
}
function has(map: unknown, id: string): boolean {
  return Boolean(map && typeof (map as { has?: unknown }).has === "function" && (map as { has: (id: string) => boolean }).has(id));
}
function stateHas(kind: "zones" | "nodes" | "obstacles" | "waypoints" | "chargingStations" | "stations" | "edges" | "portals" | "rails", id: string): boolean {
  return has((room.state as any)?.[kind], id);
}
async function selectOutliner(kind: string, id: string) {
  const item = page.locator(`#outliner [data-kind="${kind}"][data-id="${id}"]`);
  await item.waitFor();
  await item.click();
}
async function mapPoint(x: number, y: number) {
  await page.locator("#view-fit").click();
  const size = await page.locator("#viewport").evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
  const cam = fitCamera(size.w, size.h, MAP_WIDTH, MAP_HEIGHT);
  return { x: cam.x + x * cam.scale, y: cam.y + y * cam.scale };
}

try {
  room.send("editorUpsert", { kind: "zone", id: zoneId, family: "scene", zoneKind: "prefer", name: `e2e-zone-${suffix}`, polygon: zonePolygon, theta: 0, factor: 0.4 });
  room.send("editorUpsert", { kind: "node", id: nodeId, x: nodePoint[0], y: nodePoint[1], theta: 0, name: `e2e-node-${suffix}` });
  room.send("editorUpsert", { kind: "node", id: node2Id, x: 320, y: 360, theta: 0, name: `e2e-node2-${suffix}` });
  room.send("editorUpsert", { kind: "charger", id: chargerId, x: waypointWorld[0], y: waypointWorld[1], theta: 0, name: `e2e-charger-${suffix}` });
  room.send("editorUpsert", { kind: "station", id: stationId, x: nodePoint[0], y: nodePoint[1], theta: 0, stationKind: "wait", name: `e2e-station-${suffix}` });
  room.send("editorUpsert", { kind: "edge", id: edgeId, startNodeId: nodeId, endNodeId: node2Id, name: `e2e-edge-${suffix}`, theta: 0, trajectory: [{ x: nodePoint[0], y: nodePoint[1] }, { x: 320, y: 360 }], corridor: { leftWidth: 0.6, rightWidth: 0.6 } });
  room.send("editorUpsert", { kind: "portal", id: portalId, zoneId, name: `e2e-portal-${suffix}`, ax: 900, ay: 330, bx: 980, by: 330, waitPose: { x: 940, y: 330, theta: 0 } });
  room.send("editorUpsert", { kind: "rail", id: railId, zoneId, name: `e2e-rail-${suffix}`, theta: 0, points: [{ x: 910, y: 330 }, { x: 970, y: 330 }] });
  batchIds.forEach((id, i) => room.send("editorUpsert", { kind: "node", id, name: id, x: 650 + i * 50, y: 750, theta: 0 }));
  // Allow robots to process the fixture snapshot burst before the bounded placement query.
  await Bun.sleep(8000);
  obstacleId = `e2e-obstacle-${suffix}`;
  room.send("editorUpsert", { kind: "obstacle", obstacleKind: "circle", id: obstacleId, name: "Test circle", x: 1100, y: 850, size: 20, theta: 0 });
  await until(() => stateHas("zones", zoneId) && stateHas("nodes", nodeId) && stateHas("nodes", node2Id) && stateHas("chargingStations", chargerId) && stateHas("stations", stationId) && stateHas("edges", edgeId) && stateHas("portals", portalId) && stateHas("rails", railId) && stateHas("obstacles", obstacleId), "fixture resources");

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  // Create a real prefer polygon, name it before saving, then delete it from the inspector.
  await page.locator("#modes [data-mode=scene]").click();
  await page.locator('#tools-scene [data-tool="prefer"]').click();
  for (const [x, y] of [[600, 250], [660, 250], [660, 300]] as const) {
    await page.locator("#map").click({ position: await mapPoint(x, y) });
  }
  await page.keyboard.press("Enter");
  await page.locator("#insp-name").waitFor();
  await page.locator("#insp-name").fill(`created-prefer-${suffix}`);
  await page.locator("#btn-properties-save").click();
  createdZoneId = (await page.locator("#insp-id").textContent()) ?? "";
  assert.match(createdZoneId, /^zone-/);
  await until(() => stateHas("zones", createdZoneId), "prefer polygon create");
  await page.locator("#insp-name").fill(`edited-prefer-${suffix}`);
  await page.locator("#btn-properties-save").click();
  await until(() => (room.state as any).zones.get(createdZoneId)?.name === `edited-prefer-${suffix}`, "prefer polygon edit");
  // Deletion is explicitly confirmed in the themed native dialog; cancel keeps drafts intact.
  const deleteDraft = `delete-draft-${suffix}`;
  await page.locator("#insp-name").fill(deleteDraft);
  await page.locator("#btn-delete").click();
  const deleteDialog = page.locator("#delete-dialog");
  await deleteDialog.waitFor({ state: "visible" });
  assert.match((await deleteDialog.textContent()) ?? "", new RegExp(deleteDraft));
  assert(stateHas("zones", createdZoneId), "delete dialog must not delete before confirmation");
  await page.locator("#delete-cancel").click();
  assert.equal(await page.locator("#insp-name").inputValue(), deleteDraft, "cancel preserves draft");
  await page.locator("#btn-properties-cancel").click();
  await page.locator("#btn-delete").click();
  await page.locator("#delete-confirm").click();
  await until(() => !stateHas("zones", createdZoneId), "prefer polygon button delete");
  assert.equal(await page.locator("#edit-chrome").isVisible(), false, "deleted polygon leaves no ghost edit chrome");
  await page.locator("#modes [data-mode=vda]").click();
  await selectOutliner("zone", zoneId);
  await page.locator("#insp-name").waitFor();
  assert.equal(await page.locator("#insp-id").textContent(), zoneId);
  assert.equal(await page.locator("#zone-guidance").isVisible(), true, "prefer zone guidance is visible");
  assert.match((await page.locator("#zone-guidance").textContent()) ?? "", /내부 유도|경계에서 멀/);
  assert.match(await page.locator("#resource-geometry").textContent() ?? "", /900\.00|980\.00/);

  // Draft name must not be overwritten by Colyseus telemetry patches.
  const draftName = `draft-${suffix}`;
  await page.locator("#insp-name").fill(draftName);
  await Bun.sleep(250);
  assert.equal(await page.locator("#insp-name").inputValue(), draftName);
  assert.equal(await page.locator("#btn-properties-cancel").isEnabled(), true);
  await page.locator("#btn-properties-cancel").click();
  assert.equal(await page.locator("#insp-name").inputValue(), `e2e-zone-${suffix}`);
  await page.locator("#insp-name").fill(`saved-${suffix}`);
  await page.locator("#btn-properties-save").click();
  await until(() => (room.state as any).zones.get(zoneId)?.name === `saved-${suffix}`, "zone name save");

  // The inspector exposes degrees while the wire/state representation remains radians.
  const slider = page.locator("#insp-theta");
  await slider.evaluate((el) => { const input = el as HTMLInputElement; input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  const sliderBox = await slider.boundingBox();
  assert(sliderBox, "theta slider is laid out");
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.5, sliderBox.y + sliderBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sliderBox.x + sliderBox.width * 0.75, sliderBox.y + sliderBox.height / 2);
  await page.mouse.up();
  await page.locator("#insp-theta-num").fill("90");
  assert.match(await page.locator("#insp-theta-num").inputValue(), /^90(?:\.0+)?$/);
  await page.locator("#btn-properties-save").click();
  await until(() => Math.abs(Number((room.state as any).zones.get(zoneId)?.theta) - Math.PI / 2) < 0.02, "zone theta save");
  const geometry = await page.locator("#resource-geometry").textContent() ?? "";
  for (const point of ["970.00, 290.00", "970.00, 370.00", "910.00, 370.00", "910.00, 290.00"]) assert.match(geometry, new RegExp(point.replace(/[.]/g, "\\.")));

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#modes [data-mode=vda]").click();
  await selectOutliner("zone", zoneId);
  assert.equal(await page.locator("#insp-name").inputValue(), `saved-${suffix}`);
  assert.match(await page.locator("#insp-theta-num").inputValue(), /^90(?:\.0+)?$/);

  // Graph and auxiliary resources retain their identity metadata while edited in the dock.
  await selectOutliner("edge", edgeId);
  await page.locator("#insp-name").fill(`saved-edge-${suffix}`);
  await page.locator("#insp-theta-num").fill("45");
  await page.locator("#btn-properties-save").click();
  await until(() => (room.state as any).edges.get(edgeId)?.name === `saved-edge-${suffix}`, "edge metadata save");
  assert.equal((room.state as any).edges.get(edgeId)?.startNodeId, nodeId);
  assert.equal((room.state as any).edges.get(edgeId)?.endNodeId, node2Id);
  assert(Math.abs(Number((room.state as any).edges.get(edgeId)?.theta) - Math.PI / 4) < 0.02, "edge theta save");
  await selectOutliner("rail", railId);
  await page.locator("#insp-name").fill(`saved-rail-${suffix}`);
  await page.locator("#insp-theta-num").fill("30");
  await page.locator("#btn-properties-save").click();
  await until(() => (room.state as any).rails.get(railId)?.name === `saved-rail-${suffix}`, "rail metadata save");
  assert.equal((room.state as any).rails.get(railId)?.zoneId, zoneId);
  assert.equal(JSON.parse((room.state as any).rails.get(railId)?.pointsJson ?? "[]").length, 2);
  assert(Math.abs(Number((room.state as any).rails.get(railId)?.theta) - Math.PI / 6) < 0.02, "rail theta save");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#modes [data-mode=vda]").click();
  for (const [kind, id, name] of [["charger", chargerId, `e2e-charger-${suffix}`], ["node", nodeId, `e2e-node-${suffix}`], ["station", stationId, `e2e-station-${suffix}`], ["edge", edgeId, `saved-edge-${suffix}`], ["rail", railId, `saved-rail-${suffix}`]] as const) {
    await selectOutliner(kind, id);
    assert.equal(await page.locator("#insp-name").inputValue(), name, `${kind} name reload`);
  }

  await selectOutliner("obstacle", obstacleId);
  assert.equal(await page.locator("#resource-geometry").textContent().then((t) => /circle/i.test(t ?? "")), true);
  await page.locator("#insp-size").fill("32");
  await page.locator("#btn-properties-save").click();
  await until(() => Number((room.state as any).obstacles.get(obstacleId)?.size) === 32, "circle radius save");
  assert.match(await page.locator("#resource-geometry").textContent() ?? "", /32|radius/i);

  // Exercise the create flow and its confirm button when the standard free-floor point is available.
  await page.locator("#modes [data-mode=scene]").click();
  await page.locator('#tools-scene [data-tool="waypoint"]').click();
  const before = new Set([...((room.state as any).waypoints?.keys?.() ?? [])]);
  const waypointPoint = await mapPoint(waypointWorld[0], waypointWorld[1]);
  await page.locator("#map").click({ position: waypointPoint });
  assert.equal(await page.locator("#btn-edit-confirm").isVisible(), true, "waypoint creation confirm");
  // Creation must expose the same name draft before confirm.
  const createName = page.locator("#insp-name");
  await createName.waitFor();
  assert.equal(await createName.isVisible(), true);
  await createName.fill(`created-${suffix}`);
  await page.locator("#btn-edit-confirm").click();
  await until(() => [...((room.state as any).waypoints?.keys?.() ?? [])].some((id: string) => !before.has(id)), "waypoint create");
  createdWaypointId = [...((room.state as any).waypoints?.keys?.() ?? [])].find((id: string) => !before.has(id)) ?? "";
  await until(() => (room.state as any).waypoints.get(createdWaypointId)?.name === `created-${suffix}`, "waypoint name save");

  // A vertex click starts zone edit; Delete must remove the resource itself.
  await page.locator("#modes [data-mode=vda]").click();
  await selectOutliner("zone", zoneId);
  const center = await mapPoint(940, 330);
  await page.locator("#map").click({ position: center });
  const zoneBeforeDeleteName = await page.locator("#insp-name").inputValue();
  await page.keyboard.press("Delete");
  await page.locator("#delete-dialog").waitFor({ state: "visible" });
  assert.match((await page.locator("#delete-dialog").textContent()) ?? "", new RegExp(zoneBeforeDeleteName));
  assert(stateHas("zones", zoneId), "Delete key only opens confirmation");
  await page.keyboard.press("Delete");
  assert(stateHas("zones", zoneId), "repeated Delete cannot bypass confirmation");
  await page.keyboard.press("Escape");
  assert(stateHas("zones", zoneId), "Escape cancels deletion");
  assert.equal(await page.locator("#insp-name").inputValue(), zoneBeforeDeleteName);
  await page.keyboard.press("Delete");
  await page.locator("#delete-confirm").click();
  await until(() => !stateHas("zones", zoneId), "zone delete during edit");
  // Pure marquee selection has no single selected resource. Both keyboard and
  // batch-panel actions must still confirm exactly the captured fixture set.
  await page.locator('[data-tool="marquee"]').click();
  const a = await mapPoint(630, 730);
  const z = await mapPoint(720, 770);
  const canvasBox = await page.locator('#map').boundingBox();
  assert(canvasBox);
  await page.mouse.move(canvasBox.x + a.x, canvasBox.y + a.y);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + z.x, canvasBox.y + z.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Delete');
  await page.locator('#delete-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#delete-items .delete-item').count(), 2);
  const batchText = await page.locator('#delete-items').textContent() ?? '';
  for (const id of batchIds) assert(batchText.includes(id), 'only disposable batch fixture selected');
  await page.keyboard.press('Enter'); // Initial focus is cancel, never destructive.
  assert.equal(await page.locator('#delete-dialog').count(), 0);
  for (const id of batchIds) assert(stateHas('nodes', id), 'Enter cancels without mutation');
  await page.locator('#multi-delete').click();
  await page.locator('#delete-confirm').click();
  await until(() => batchIds.every(id => !stateHas('nodes', id)), 'confirmed batch deletion');
  assert.deepEqual(errors, []);
  console.log("Browser E2E passed: stable outliner selection, draft name, degree/radian theta save, geometry and circle radius inspector, waypoint confirm, zone Delete during edit.");
} catch (error) {
  console.error(error);
  if (await page.locator('#inspect-panel').count()) {
  await page.screenshot({ path: '/tmp/atlas-properties-failure.png', fullPage: true });
  console.log(await page.locator('#inspect-panel').evaluate(el => ({ text: el.textContent, inputs: [...el.querySelectorAll('input')].map(i => ({id:i.id,value:i.value,valid:i.checkValidity(),hidden:!!i.closest('[hidden]')})) })));
  console.log('status:', await page.locator('#status-msg').textContent());
  }
  throw error;
} finally {
  if (createdWaypointId) room.send("deleteAsset", { kind: "waypoint", id: createdWaypointId });
  if (obstacleId && stateHas("obstacles", obstacleId)) room.send("deleteObstacle", { id: obstacleId });
  if (stateHas("zones", zoneId)) room.send("editorDelete", { kind: "zone", id: zoneId });
  if (createdZoneId && stateHas("zones", createdZoneId)) room.send("editorDelete", { kind: "zone", id: createdZoneId });
  for (const [kind, id] of [["charger", chargerId], ["station", stationId], ["edge", edgeId], ["portal", portalId], ["rail", railId], ["node", node2Id], ["node", nodeId]] as const) {
    const collection = kind === "charger" ? "chargingStations" : kind === "station" ? "stations" : kind === "edge" ? "edges" : kind === "portal" ? "portals" : kind === "rail" ? "rails" : "nodes";
    if (stateHas(collection, id)) room.send("editorDelete", { kind, id });
  }
  for (const id of batchIds) if (stateHas("nodes", id)) room.send("editorDelete", { kind: "node", id });
  await room.leave();
  await browser.close();
}
