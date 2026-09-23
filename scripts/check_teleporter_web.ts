import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const offset = Number(process.env.E2E_PORT_OFFSET ?? "10000");
if (!Number.isInteger(offset) || offset < 0 || offset > 15472) throw new Error("E2E_PORT_OFFSET must be an integer between 0 and 15472");
const root = mkdtempSync("/tmp/fms-teleporter-web-");
const env = { ...process.env, FMS_PORT_OFFSET: String(offset), FMS_DATA_ROOT: root, TELEPORTER_SQLITE_PATH: join(root, "teleporters.sqlite") };
const children: Bun.Subprocess[] = [];
let passed = false;
try {
  for (const map of ["yard", "large_lab"]) {
    children.push(Bun.spawn(["bun", "server/src/index.ts"], { cwd: repo, env: { ...env, FMS_MAP_ID: map }, stdout: Bun.file(join(root, `${map}.log`)), stderr: Bun.file(join(root, `${map}.err`)) }));
  }
  children.push(Bun.spawn(["bun", "web-client/src/server.ts"], { cwd: repo, env, stdout: Bun.file(join(root, "web.log")), stderr: Bun.file(join(root, "web.err")) }));
  await Bun.sleep(Number(process.env.E2E_STARTUP_WAIT_MS ?? "3500"));
  const test = Bun.spawn(["bun", "web-client/check_teleporter.ts"], {
    cwd: repo,
    env: { ...env, ATLAS_WEB_URL: `http://127.0.0.1:${5174 + offset}/?portOffset=${offset}`, TELEPORTER_SCREENSHOT: process.env.TELEPORTER_SCREENSHOT ?? "/tmp/teleporter-e2e.png" },
    stdout: "inherit", stderr: "inherit",
  });
  children.push(test);
  if (await test.exited !== 0) throw new Error(`teleporter web acceptance failed; logs: ${root}`);
  passed = true;
  console.log("PASS browser placement, map rejoin, persistence, cancel and delete");
} finally {
  for (const child of children) { try { child.kill(); } catch {} }
  await Promise.all(children.map(child => child.exited));
  if (passed) rmSync(root, { recursive: true, force: true }); else console.error(`logs: ${root}`);
}
