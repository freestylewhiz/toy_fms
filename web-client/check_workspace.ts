import { chromium } from "playwright";
import { strict as assert } from "node:assert";

const baseUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5174";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#viewport").waitFor();

  // Ctrl/Cmd-K opens quick tools and filtering leaves only matching tools.
  await page.keyboard.press("Control+k");
  await page.locator("#command-dialog").waitFor({ state: "visible" });
  await page.locator("#command-search").fill("waypoint");
  const commandResults = page.locator("#command-results button");
  assert((await commandResults.count()) > 0, "command palette filters tools");
  assert.match((await commandResults.first().textContent()) ?? "", /이동 지점|waypoint/i);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator('#modes [data-mode="scene"]').getAttribute("aria-pressed"), "true", "command selects scene mode");
  assert.equal(await page.locator('#tools-scene [data-tool="waypoint"]').getAttribute("aria-pressed"), "true", "command selects waypoint tool");
  await page.locator('#tools-scene [data-tool="select"]').click();

  // The VDA tool layers expose graph, zone rules and auxiliary tools separately.
  await page.locator('#modes [data-mode=vda]').click();
  await page.locator('[data-vda-section=zone]').click();
  assert(await page.locator('#tools-vda-zone').isVisible());
  assert.equal(await page.locator('#tools-vda-graph').isVisible(), false);
  await page.keyboard.press('Control+k');
  await page.locator('#command-search').fill('portal');
  await page.keyboard.press('Enter');
  assert(await page.locator('#tools-vda-aux').isVisible(), 'palette reveals the matching VDA tool layer');
  assert.equal(await page.locator('#tools-vda-aux [data-tool=portal]').getAttribute('aria-pressed'), 'true');
  await page.locator('#modes [data-mode=scene]').click();
  await page.locator('#tools-scene [data-tool=select]').click();

  // Search filters resources by display name/ID without changing the map.
  const search = page.locator("#resource-search");
  await search.fill("waypoint");
  await page.waitForTimeout(100);
  const totalItems = await page.locator("#outliner button").count();
  const visibleItems = page.locator("#outliner button:not([hidden])");
  assert(totalItems > 0, "outliner has seeded resources");
  assert((await visibleItems.count()) <= totalItems, "resource filter remains usable");
  await search.fill("resource-that-does-not-exist");
  assert.equal(await visibleItems.count(), 0, "unknown resource search is empty");
  await search.fill("");
  await page.locator('.resource-filters [data-filter="zone"]').click();
  for (const item of await page.locator("#outliner button:not([hidden])").all()) assert.equal(await item.getAttribute("data-kind"), "zone");
  await page.locator('.resource-filters [data-filter="all"]').click();

  // Shift-F toggles focus mode and restores the full workspace.
  await page.locator("#map").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Shift+f");
  assert.equal(await page.locator("#focus-workspace").getAttribute("aria-pressed"), "true");
  const shellBox = await page.locator(".shell").boundingBox();
  const viewportBox = await page.locator("#viewport").boundingBox();
  assert(shellBox && viewportBox && Math.abs(shellBox.width - viewportBox.width) < 2, "focus viewport fills shell");
  await page.keyboard.press("Shift+f");
  assert.equal(await page.locator("#focus-workspace").getAttribute("aria-pressed"), "false");

  const blueprint = page.locator("#map-render-style");
  const beforeBlueprint = await blueprint.getAttribute("aria-pressed");
  await blueprint.click();
  assert.notEqual(await blueprint.getAttribute("aria-pressed"), beforeBlueprint);
  await blueprint.click();
  assert.equal(await blueprint.getAttribute("aria-pressed"), beforeBlueprint);

  const minimap = page.locator("#overview-map");
  await minimap.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "overview-map");

  for (const width of [1280, 900, 640, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // Layout transitions may still be settling immediately after a resize.
    // Wait for the same bounds we assert below rather than sampling mid-frame.
    await page.waitForFunction(() => ["#open-command", "#focus-workspace", "#map-render-style"].every(id => {
      const rect = document.querySelector(id)?.getBoundingClientRect();
      return rect && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }), undefined, { timeout: 5000 });
    await page.locator("#open-command").waitFor();
    assert(await page.locator("#open-command").isVisible(), `quick command visible at ${width}px`);
    assert(await page.locator("#focus-workspace").isVisible(), `focus control visible at ${width}px`);
    assert(await page.locator("#map").isVisible(), `map visible at ${width}px`);
    for (const id of ["#open-command", "#focus-workspace", "#map-render-style"]) {
      const box = await page.locator(id).boundingBox();
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900, `${id} fits at ${width}px`);
    }
    assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `no horizontal overflow at ${width}px`);
    if (width === 390) {
      await page.waitForFunction(() => document.querySelector(".shell")?.classList.contains("hide-library"));
      await page.locator("#toggle-library").click();
      assert(await search.isVisible(), "mobile navigator opens from header");
      await search.fill("mobile-search-no-match");
      assert.equal(await page.locator("#outliner button:not([hidden])").count(), 0);
      await search.fill("");
      await page.locator("#toggle-library").click();
      assert.equal(await search.isVisible(), false, "mobile navigator closes");
    }
  }
  assert.deepEqual(errors, []);
  console.log("Workspace smoke passed: command search, resource filter, focus restore, blueprint, minimap and responsive controls.");
} finally {
  await browser.close();
}
