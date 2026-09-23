import { chromium } from "playwright";
import { strict as assert } from "node:assert";

/**
 * PILOT-14 browser acceptance. Start isolated FMS/web processes first with
 * FMS_DATA_ROOT=<tmp> and FMS_PORT_OFFSET=<n>, then run this file with the
 * same ATLAS_WEB_URL (including ?portOffset=<n>). No production database is
 * touched by this check.
 */
const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174/?portOffset=0";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
const id = `e2e-teleporter-${crypto.randomUUID()}`;

/**
 * A Large Lab endpoint is normally viewed at roughly 5--10% scale.  Checking
 * the inspector or outliner alone does not prove that an operator can see the
 * marker, so sample the canvas around the known screen-space placement point.
 */
async function hasTeleporterMarker(x: number, y: number): Promise<boolean> {
  return page.locator("#map").evaluate((canvas, point) => {
    const map = canvas as HTMLCanvasElement;
    const context = map.getContext("2d");
    if (!context) return false;
    const rect = map.getBoundingClientRect();
    const dpr = map.width / rect.width;
    const radius = Math.ceil(16 * dpr);
    const cx = Math.round(point.x * dpr);
    const cy = Math.round(point.y * dpr);
    const pixels = context.getImageData(cx - radius, cy - radius, radius * 2 + 1, radius * 2 + 1).data;
    for (let i = 0; i < pixels.length; i += 4) {
      // The free endpoint marker is #67e8f9. Accept antialiasing, but keep
      // the threshold distinct from the grayscale Large Lab blueprint.
      if (pixels[i] > 70 && pixels[i + 1] > 170 && pixels[i + 2] > 180 && pixels[i + 3] > 180) return true;
    }
    return false;
  }, { x, y });
}

async function teleporterMarkerCenter(): Promise<{ x: number; y: number } | null> {
  return page.locator("#map").evaluate((canvas) => {
    const map = canvas as HTMLCanvasElement;
    const context = map.getContext("2d");
    if (!context) return null;
    const pixels = context.getImageData(0, 0, map.width, map.height).data;
    const bins = new Map<string, number>();
    for (let y = 0; y < map.height; y += 2) for (let x = 0; x < map.width; x += 2) {
      const i = (y * map.width + x) * 4;
      if (pixels[i] > 70 && pixels[i + 1] > 170 && pixels[i + 2] > 180 && pixels[i + 3] > 180) {
        const key = `${Math.floor(x / 12)}:${Math.floor(y / 12)}`;
        bins.set(key, (bins.get(key) ?? 0) + 1);
      }
    }
    const peak = [...bins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!peak || peak[1] < 3) return null;
    const [bx, by] = peak[0].split(":").map(Number);
    const rect = map.getBoundingClientRect();
    const dpr = map.width / rect.width;
    return { x: (bx * 12 + 6) / dpr, y: (by * 12 + 6) / dpr };
  });
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  // Scene authoring is the operator-facing Yard placement path. Keep this
  // separate from the VDA auxiliary flow below so a missing scene tool cannot
  // be hidden by a passing VDA test.
  await page.locator("#modes [data-mode=scene]").click();
  await page.locator("#tools-scene [data-tool=teleporter]").click();
  await page.locator("#map").click({ position: { x: 420, y: 360 } });
  assert.equal(await page.locator("body").getAttribute("data-editing"), "true", "Scene teleporter click creates a Yard draft");
  assert.equal(await page.locator("#teleporter-target-map").count(), 1, "Scene placement opens teleporter properties");
  const clearBefore = await page.locator("#teleporter-a-clear-x").inputValue();
  await page.locator("#teleporter-a-clear-place").click();
  await page.waitForFunction(() => document.querySelector("#status-msg")?.textContent?.includes("clearing"));
  await page.locator("#map").click({ position: { x: 470, y: 380 } });
  assert.notEqual(await page.locator("#teleporter-a-clear-x").inputValue(), clearBefore, "Scene canvas click updates clearing point");
  await page.locator("#btn-properties-cancel").click();
  assert.equal(await page.locator("body").getAttribute("data-editing"), "false", "Scene placement can be cancelled atomically");
  await page.locator("#modes [data-mode=vda]").click();
  await page.locator("[data-vda-section=aux]").click();
  await page.locator("#tools-vda-aux [data-tool=teleporter]").click();
  const map = page.locator("#map");
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator("#insp-name").fill(id);
  assert.equal(await page.locator("#teleporter-target-map").count(), 1, "dedicated target selector is visible");
  const target = await page.locator("#teleporter-target-map").inputValue();
  // Choosing the target floor is itself the transition into endpoint-B editing.
  // The draft and selected teleporter must survive the room/map switch.
  await page.locator("#teleporter-target-map").selectOption(target);
  await page.waitForFunction((mapId) => document.body.dataset.map === mapId, target);
  assert((await page.locator("#teleporter-place-target").textContent())?.includes("B"), "target map keeps B placement active");
  await map.click({ position: { x: 600, y: 400 } });
  assert.equal(await page.locator("#teleporter-b-entry").count(), 1, `B endpoint exists after placement (${await page.locator('#status-msg').textContent()} / ${await page.locator('#teleporter-place-target').textContent()})`);
  await page.locator('[data-teleporter-clear-map="yard"]').click();
  assert((await page.locator("#status-msg").textContent())?.includes("yard"), "A clearing cannot be placed from the B map");
  assert.equal(await page.locator('#tools-vda-aux [data-tool=teleporter]').getAttribute('aria-pressed'), 'true', 'B placement tool remains active');
  assert.equal(await page.locator("#teleporter-a-polygon").count(), 0, "polygon is edited through vertex controls");
  assert((await page.locator("[data-teleporter-a-vertex]").count()) >= 8, "A polygon vertices are editable");
  await page.locator('[data-teleporter-a-vertex="0"][data-axis="x"]').fill("-30");
  await page.locator("#teleporter-a-clear-x").fill("480");
  await page.locator("#teleporter-a-clear-y").fill("360");
  await page.locator("#btn-properties-cancel").click();
  assert.equal(await page.locator("#edit-chrome").isVisible(), false, "cancel closes the atomic draft");
  await page.locator("#map-select").selectOption("yard");
  await page.waitForTimeout(500);

  // Recreate, save, then verify the save control is acknowledged by the server.
  await page.locator("#tools-vda-aux [data-tool=teleporter]").click();
  await map.click({ position: { x: 420, y: 360 } });
  await page.locator("#insp-name").fill(id);
  await page.locator("#teleporter-target-map").selectOption(target);
  await page.locator("#teleporter-place-target").click();
  await page.waitForFunction((mapId) => document.body.dataset.map === mapId, target);
  await map.click({ position: { x: 600, y: 400 } });
  await page.locator("#btn-properties-save").click();
  try { await page.locator("#status-msg").filter({ hasText: "텔레포터 저장 완료" }).waitFor({ state: "visible", timeout: 15000 }); }
  catch { throw new Error(`teleporter save did not acknowledge: ${await page.locator("#property-state").textContent()} / ${await page.locator("#status-msg").textContent()} / ${errors.join("; ")}`); }
  const savedId = await page.locator("#insp-id").textContent();
  assert(savedId && savedId.includes("teleporter"), "teleporter ack selects the saved resource");
  const endpointIds = await page.locator("#geometry-content").textContent();
  assert(endpointIds && endpointIds.includes("고유 ID"), "saved geometry is rendered");
  assert(endpointIds.includes("A 엔드포인트") && endpointIds.includes("B 엔드포인트"), "both endpoint ids are rendered");
  // This is the actual Large Lab regression: a 10,000px map must still show
  // its endpoint, and a direct canvas drag must open a draft and move both
  // the endpoint and its clearing point before persistence.
  await page.waitForFunction(() => document.body.dataset.map === "large_lab");
  assert.equal(await hasTeleporterMarker(600, 400), true, "Large Lab endpoint marker is visible at fit zoom");
  const largeLabClearButton = page.locator('[data-teleporter-clear-map="large_lab"]');
  const largeLabPrefix = (await largeLabClearButton.getAttribute("id"))?.startsWith("teleporter-b") ? "b" : "a";
  const beforeLargeLabClear = await page.locator(`#teleporter-${largeLabPrefix}-clear-x`).inputValue();
  await map.hover({ position: { x: 600, y: 400 } });
  await page.mouse.move((await map.boundingBox())!.x + 600, (await map.boundingBox())!.y + 400);
  await page.mouse.down();
  await page.mouse.move((await map.boundingBox())!.x + 660, (await map.boundingBox())!.y + 440, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.locator("body").getAttribute("data-editing"), "true", "direct Large Lab marker drag opens a draft");
  assert.notEqual(await page.locator(`#teleporter-${largeLabPrefix}-clear-x`).inputValue(), beforeLargeLabClear, "Large Lab marker drag moves its clearing point");
  const draggedMarker = await teleporterMarkerCenter();
  assert(draggedMarker, "Large Lab marker remains visibly rendered after dragging");
  await page.locator("#btn-properties-save").click();
  await page.locator("#status-msg").filter({ hasText: "텔레포터 저장 완료" }).waitFor({ state: "visible", timeout: 15000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.map === "large_lab");
  const persistedMarker = await teleporterMarkerCenter();
  assert(persistedMarker, "saved Large Lab endpoint remains visible after reload");
  await map.click({ position: persistedMarker });
  assert.equal(await page.locator("body").getAttribute("data-editing"), "true", "saved Large Lab endpoint can be selected directly on the canvas");
  await page.locator("#btn-properties-cancel").click();
  await page.locator("#map-select").selectOption("yard");
  await page.waitForFunction(() => document.body.dataset.map === "yard");
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).waitFor({ state: "attached", timeout: 15000 });
  await page.locator("#map-select").selectOption(target);
  await page.waitForFunction((mapId) => document.body.dataset.map === mapId, target);
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).waitFor({ state: "attached", timeout: 15000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).click();
  const reloadedGeometry = await page.locator("#geometry-content").textContent();
  assert(reloadedGeometry && reloadedGeometry.includes("A 엔드포인트") && reloadedGeometry.includes("B 엔드포인트"), "reload preserves endpoint ids");
  await page.locator("#map-select").selectOption("yard");
  await page.waitForFunction(() => document.body.dataset.map === "yard");
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).waitFor({ state: "attached", timeout: 15000 });
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).click();
  const yardClearButton = page.locator('[data-teleporter-clear-map="yard"]');
  const clearPrefix = (await yardClearButton.getAttribute("id"))?.startsWith("teleporter-b") ? "b" : "a";
  const reloadedClear = await page.locator(`#teleporter-${clearPrefix}-clear-x`).inputValue();
  await yardClearButton.click();
  await page.locator("#map").click({ position: { x: 500, y: 410 } });
  assert.notEqual(await page.locator(`#teleporter-${clearPrefix}-clear-x`).inputValue(), reloadedClear, "saved teleporter map edit updates the Yard clearing point");
  assert.equal(await page.locator("#btn-properties-cancel").isEnabled(), true, "editing a saved teleporter opens a draft");
  await page.locator("#btn-properties-cancel").click();
  assert.equal(await page.locator(`#teleporter-${clearPrefix}-clear-x`).inputValue(), reloadedClear, "cancel restores the saved clearing point");
  await page.locator("#btn-delete").click();
  await page.locator("#delete-confirm").click();
  await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).waitFor({ state: "detached", timeout: 15000 });
  await page.locator("#map-select").selectOption("yard");
  await page.waitForFunction(() => document.body.dataset.map === "yard");
  // Do not assert during the map-loading window: the outliner is intentionally
  // cleared before the new room snapshot arrives. Online is the room join
  // boundary, so this checks the authoritative post-rejoin snapshot.
  await page.locator("#conn[data-state=online]").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator(`#outliner [data-kind=teleporter][data-id="${savedId}"]`).count(), 0, "delete is absent from source map snapshot");
  await page.screenshot({ path: process.env.TELEPORTER_SCREENSHOT ?? "/tmp/teleporter-e2e.png", fullPage: true });
  assert.equal(errors.length, 0, errors.join("; "));
} finally {
  await browser.close();
}
