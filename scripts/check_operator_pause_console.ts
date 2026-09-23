/** Real transports, isolated files/ports, and Chromium. Never targets live FMS. */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../web-client/node_modules/colyseus.js/build/esm/index.mjs";
import { settledPoseJournal, writeTransferJournal } from "../virtual-robot/src/transferJournal.ts";

const offset = Number(process.env.E2E_PORT_OFFSET ?? 11800);
assert(Number.isInteger(offset) && offset >= 1000 && offset < 15000, "isolated port offset required");
const root = mkdtempSync(join(tmpdir(), "fms-pause-console-"));
const base = `http://127.0.0.1:${5174 + offset}`;
const children: Bun.Subprocess[] = [];
const env = { ...process.env, FMS_MAP_ID: "yard", FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root,
  TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite"), FMS_WEB_PUBLIC_DIR: join(root, "public"), FMS_BLACKBOX: "1" };
let room: any;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const pauseResults: any[] = [];
const eventResults: any[] = [];
const commandResults: any[] = [];
const errors: string[] = [];
const checks: Record<string, unknown> = {};

function spawn(name: string, file: string, args: string[] = []) {
  const child = Bun.spawn(["bun", file, ...args], { env,
    stdout: Bun.file(join(root, `${name}.log`)), stderr: Bun.file(join(root, `${name}.err`)) });
  children.push(child);
  return child;
}
async function stop(child: Bun.Subprocess) {
  if (child.exitCode === null) child.kill();
  await child.exited;
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out: ${label}; diagnostics ${root}`);
}
async function connect() {
  await until(async () => {
    try { room = await new Client(`ws://127.0.0.1:${2568 + offset}`).joinOrCreate("floor"); return true; }
    catch { return false; }
  }, "isolated room");
  room.onMessage("*", () => {});
  room.onMessage("robot_motion_pause_result", (result: any) => pauseResults.push(result));
  room.onMessage("robot_events_result", (result: any) => eventResults.push(result));
  room.onMessage("commandAck", (result: any) => commandResults.push(result));
}
const r = (id = "robot-1") => room.state?.robots?.get(id);
const pathOf = (id = "robot-1") => JSON.stringify(r(id).path.toJSON());
const localPathOf = (id = "robot-1") => JSON.stringify(r(id).localPath.toJSON());
async function pause(id: string, paused: boolean) {
  const requestId = crypto.randomUUID();
  room.send("robot_motion_pause", { requestId, robotId: id, paused, expectedEpoch: r(id).controlEpoch });
  await until(() => pauseResults.some(x => x.requestId === requestId && !x.pending), `pause ACK ${id} ${paused}`);
  const result = pauseResults.findLast(x => x.requestId === requestId && !x.pending);
  assert.equal(result.ok, true, JSON.stringify(result));
  await until(() => r(id).operatorPaused === paused && !r(id).operatorPausePending, `observed pause ${id}`);
  return result;
}
async function events(id: string, extra: Record<string, unknown> = {}) {
  const requestId = crypto.randomUUID();
  room.send("robot_events_query", { requestId, robotId: id, fromMs: Date.now() - 300000, toMs: Date.now(), limit: 100, ...extra });
  await until(() => eventResults.some(x => x.requestId === requestId), "event query");
  const result = eventResults.find(x => x.requestId === requestId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

try {
  // Match deployed robots, which already have durable location journals. Fresh
  // seed-only simulators currently reset to their spawn pose across restarts.
  for (const seed of [{ id: "robot-1", x: 240, y: 520, theta: 0 }, { id: "robot-2", x: 420, y: 720, theta: 0 }]) {
    writeTransferJournal(join(root, "robots", `robot-${seed.id}.teleporter.json`), settledPoseJournal(seed.id, "yard", seed));
  }
  let server = spawn("server", "server/src/index.ts");
  spawn("web", "web-client/src/server.ts");
  await connect();
  let robots = ["robot-1", "robot-2"].map(id => spawn(id, "virtual-robot/src/index.ts", ["--id", id]));
  await until(() => ["robot-1", "robot-2"].every(id => r(id)?.connected && r(id)?.controlReady && !r(id)?.operatorPausePending), "two robots ready", 30000);
  await until(async () => { try { return (await fetch(base + "/runtime-config.json")).ok; } catch { return false; } }, "web ready");

  const initial = { x: r().x, y: r().y, theta: r().theta, epoch: r().controlEpoch };
  const targetId = "event-display-waypoint", targetName = '포장 <출구> & 검사';
  room.send("editorUpsert", { kind: "waypoint", id: targetId, name: targetName, x: initial.x + 80, y: initial.y, theta: initial.theta });
  await until(() => room.state.waypoints.get(targetId)?.name === targetName, "named event destination saved");
  room.send("commandRobot", { robotId: "robot-1", kind: "move", targetId,
    clientRequestId: crypto.randomUUID() });
  await until(() => r().commandState === "running" && r().x > initial.x + 4, "real motion before pause");
  const commandId = r().commandId;
  await pause("robot-1", true);
  const frozen = { x: r().x, y: r().y, theta: r().theta, path: pathOf(), localPath: localPathOf(), epoch: r().controlEpoch };
  await Bun.sleep(1300);
  assert.equal(r().x, frozen.x); assert.equal(r().y, frozen.y); assert.equal(r().theta, frozen.theta);
  assert.equal(r().commandId, commandId); assert.equal(r().commandState, "running");
  assert.equal(pathOf(), frozen.path); assert.equal(localPathOf(), frozen.localPath); assert.equal(r().controlEpoch, frozen.epoch);
  assert.equal(r().driveState, "paused");
  checks.pausePreservesMotionCommandPathEpoch = true;

  // A new move cannot replace the preserved mission while manual pause is active.
  room.send("commandRobot", { robotId: "robot-1", kind: "move", x: initial.x + 100, y: initial.y, theta: 0,
    clientRequestId: crypto.randomUUID() });
  await Bun.sleep(250);
  assert.equal(r().commandId, commandId); assert.equal(r().operatorPaused, true); assert.equal(r().x, frozen.x);
  checks.newMoveCannotReplacePausedMission = true;
  await pause("robot-1", false);
  await until(() => r().x > frozen.x + 3, "same mission resumes");
  assert.equal(r().commandId, commandId);
  await until(() => r().commandState === "completed", "original mission completes", 20000);
  checks.resumeCompletesOriginalCommand = true;
  // History must retain the original name after a later edit.
  room.send("editorUpsert", { kind: "waypoint", id: targetId, name: "변경된 이름", x: initial.x + 80, y: initial.y, theta: initial.theta });
  await until(() => room.state.waypoints.get(targetId)?.name === "변경된 이름", "destination renamed after completion");

  await until(async () => (await events("robot-1")).events.length > 0, "recorded robot events");
  const first = await events("robot-1");
  assert(first.events.every((event: any) => event.robotId === "robot-1"), "robot filter");
  checks.realRecordedEvents = first.events.length;

  if (process.env.E2E_NO_BROWSER !== "1") {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => errors.push(String(error)));
    await page.addInitScript(() => {
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    });
    await page.goto(`${base}/?map=yard&portOffset=${offset}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !(document.getElementById("blackbox-toggle") as HTMLButtonElement | null)?.disabled);
    await page.locator("#modes [data-mode=operate]").click();
    await page.locator("button[data-detail=fleet]").click();
    await page.locator("#robot-cards .card[data-robot-id='robot-1']").click();

    // UI selectors are assigned by the web component contract. These assertions
    // intentionally require the real new UI instead of silently skipping it.
    await page.locator("#robot-motion-pause").click();
    await until(() => r().operatorPaused === true, "web pause applied");
    await page.locator("#robot-motion-resume").click();
    await until(() => r().operatorPaused === false, "web resume applied");
    for (const id of ["robot-1", "robot-2"]) await page.locator(`#robot-pause-selection input[data-robot-id='${id}']`).check();
    await page.locator("#robot-motion-pause").click();
    await until(() => ["robot-1", "robot-2"].every(id => r(id).operatorPaused && !r(id).operatorPausePending), "web group pause applied");
    await page.locator("#robot-motion-resume").click();
    await until(() => ["robot-1", "robot-2"].every(id => !r(id).operatorPaused && !r(id).operatorPausePending), "web group resume applied");
    await stop(robots[1]!);
    await until(() => r("robot-2")?.connected === false, "isolated peer offline");
    await page.locator("#robot-motion-pause").click();
    await until(() => r().operatorPaused && !r().operatorPausePending, "eligible robot pauses during partial failure");
    await until(async () => /실패|오프라인|연결/.test(await page.locator("#robot-motion-result").innerText()), "partial failure visible");
    await page.locator("#robot-motion-resume").click();
    await until(() => !r().operatorPaused && !r().operatorPausePending, "eligible robot resumes during partial failure");
    robots[1] = spawn("robot-2-reconnected", "virtual-robot/src/index.ts", ["--id", "robot-2"]);
    await until(() => r("robot-2")?.connected && r("robot-2")?.controlReady && !r("robot-2")?.operatorPausePending, "peer reconnects");
    for (const id of ["robot-1", "robot-2"]) await page.locator(`#robot-pause-selection input[data-robot-id='${id}']`).uncheck();
    checks.browserTwoRobotSelectionAndPartialFailure = true;
    await page.locator("#robot-events-open").click();
    await page.locator("#robot-events-list [data-event-id]").first().waitFor({ state: "visible" });
    await page.locator("#robot-events-list [data-event-id]").first().click();
    assert.equal(await page.locator("#robot-events-detail").isVisible(), false, "selecting an event keeps JSON collapsed");
    assert.match(await page.locator("#robot-events-description").innerText(), /robot-1/);
    await page.locator("#robot-events-json summary").click();
    const detail = JSON.parse(await page.locator("#robot-events-detail").innerText());
    assert.equal(detail.robotId, "robot-1");
    assert.equal(await page.locator("#robot-events-copy").isEnabled(), true);
    await page.locator("#robot-events-copy").click();
    await until(async () => (await page.locator("#status-msg").innerText()).includes("JSON을 복사했습니다"), "LAN-compatible clipboard copy");
    await page.locator("#robot-events-follow").uncheck();
    const eventIds = () => page.locator("#robot-events-list [data-event-id]").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.eventId));
    const frozenEvents = await eventIds();
    await Bun.sleep(1400);
    assert.deepEqual(await eventIds(), frozenEvents, "console screen pause freezes the event list");
    assert.equal(r().operatorPaused, false, "console screen pause must not pause robot motion");
    await page.locator("#robot-events-range").selectOption("900000");
    await page.locator("#robot-events-level").selectOption("info");
    await page.locator("#robot-events-category").selectOption("operation");
    await page.locator("#robot-events-list [data-event-id]").first().waitFor({ state: "visible" });
    await page.locator("#robot-events-list [data-event-id]").first().click();
    assert.equal(await page.locator("#robot-events-detail").isVisible(), false, "filter changes close the JSON view");
    await page.locator("#robot-events-json summary").click();
    const filtered = JSON.parse(await page.locator("#robot-events-detail").innerText());
    assert.equal(filtered.category, "operation");
    const operationRow = page.locator("#robot-events-list [data-event-id]").filter({ hasText: targetName }).filter({ hasText: commandId }).first();
    await operationRow.waitFor({ state: "visible" });
    const description = await operationRow.innerText();
    assert.match(description, /이동|명령|완료/);
    assert(!description.includes("변경된 이름"), "historical target name wins over current name");
    assert.equal(await operationRow.locator("출구").count(), 0, "resource name is escaped text, not HTML");
    checks.browserNaturalEventAndHistoricalResourceName = description;
    // Close raw details before loading a related trace: it must stay a natural-language view.
    await page.locator("#robot-events-json").evaluate((element: HTMLDetailsElement) => { element.open = false; });
    await operationRow.click();
    await page.locator("#robot-events-trace").click();
    await until(async () => (await page.locator("#robot-events-related p").count()) > 0, "natural related operation trace");
    assert.equal(await page.locator("#robot-events-detail").isVisible(), false, "related records do not open raw JSON");
    assert.match(await page.locator("#robot-events-related").innerText(), /이동|명령|완료/);
    await Bun.sleep(1100);
    assert.equal(await page.locator("#robot-events-detail").isVisible(), false, "render refresh keeps JSON collapsed");
    checks.browserJsonOnlyInExplicitView = true;
    await page.screenshot({ path: join(root, "event-console-natural.png") });
    await page.locator("#robot-events-json summary").click();
    await until(async () => { try { return Array.isArray(JSON.parse(await page.locator("#robot-events-detail").innerText()).trace); } catch { return false; } }, "real related operation trace");
    checks.browserRelatedTrace = true;
    await page.locator("#robot-events-robot").selectOption("robot-2");
    await page.locator("#robot-events-list [data-event-id]").first().waitFor({ state: "visible" });
    await page.locator("#robot-events-list [data-event-id]").first().click();
    assert.equal(await page.locator("#robot-events-detail").isVisible(), false, "robot changes close JSON and clear previous trace");
    assert.equal(await page.locator("#robot-events-related").isVisible(), false);
    await page.locator("#robot-events-json summary").click();
    assert.equal(JSON.parse(await page.locator("#robot-events-detail").innerText()).robotId, "robot-2");
    await page.locator("#robot-events-category").selectOption("");
    await page.locator("#robot-events-robot").selectOption("robot-1");
    await page.locator("#robot-events-list [data-event-id]").first().waitFor({ state: "visible" });
    await until(async () => page.locator("#robot-events-more").isEnabled(), "history cursor available");
    const beforeHistory = await eventIds();
    await page.locator("#robot-events-more").click();
    await until(async () => (await eventIds()).some(id => !beforeHistory.includes(id)), "older events append without cursor mismatch");
    checks.browserScreenPauseFiltersAndHistory = true;
    await page.screenshot({ path: join(root, "event-console.png") });
    await page.locator("#blackbox-toggle").click();
    await until(async () => page.locator("#robot-events-panel").isHidden(), "console closed on replay transition");
    await until(async () => page.locator("#robot-motion-pause").isDisabled(), "replay cannot control live motion");
    checks.browserReplayClosesLiveConsoleAndDisablesControl = true;
    checks.browserPauseResumeAndRealConsole = true;
  }

  await Promise.all([pause("robot-1", true), pause("robot-2", true)]);
  const beforeRestart = ["robot-1", "robot-2"].map(id => ({ id, x: r(id).x, y: r(id).y }));
  await room.leave();
  for (const robot of robots) await stop(robot);
  await stop(server);
  server = spawn("server-restarted", "server/src/index.ts");
  await connect();
  robots = ["robot-1", "robot-2"].map(id => spawn(`${id}-restarted`, "virtual-robot/src/index.ts", ["--id", id]));
  await until(() => ["robot-1", "robot-2"].every(id => r(id)?.connected && r(id)?.controlReady && r(id)?.operatorPaused), "pause restored after restart", 30000);
  for (const old of beforeRestart) {
    assert.equal(r(old.id).x, old.x); assert.equal(r(old.id).y, old.y);
    assert.equal(r(old.id).commandState, "idle");
  }
  checks.twoRobotPauseSurvivesServerRobotRestart = true;
  await Promise.all([pause("robot-1", false), pause("robot-2", false)]);
  assert.deepEqual(errors, []);
  const result = { result: "PASS", root, isolatedPortOffset: offset, checks, pageErrors: errors };
  await Bun.write(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await Bun.write(join(root, "failure.json"), JSON.stringify({ error: String(error), checks, pageErrors: errors,
    robots: room?.state?.robots?.toJSON?.(), pauseResults: pauseResults.slice(-10),
    eventResults: eventResults.slice(-2).map(({ events, ...result }) => ({ ...result, eventCount: events?.length })),
  }, null, 2));
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(root, "failure.png") }); } catch {}
  throw error;
} finally {
  try { await room?.leave(); } catch {}
  try { await browser?.close(); } catch {}
  for (const child of children) { try { await stop(child); } catch {} }
  console.log(`Isolated diagnostics preserved: ${root}`);
}
