import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Recorder, resetBlackbox } from "./recorder.ts";
import { BlackboxQuery } from "./query.ts";

const confirmation = { confirmationToken: "BLACKBOX_RESET", scope: "blackbox" as const };

test("v2 reset isolates a different process with a pending historical asset copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "blackbox-v2-reset-"));
  const bytes = "old-generation-private-map";
  let announce!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { if (new URL(request.url).pathname === "/old.png") { announce(); await held; return new Response(bytes); } return new Response("current-generation-map"); } });
  const script = join(root, "writer.ts");
  await writeFile(script, `import { Recorder } from ${JSON.stringify(resolve("server/src/blackbox/recorder.ts"))};
const recorder = new Recorder({root:${JSON.stringify(root)},source:"fms-yard",mapId:"yard"});
recorder.frame({robots:[{id:"robot-1",x:10}],assets:{mapUrl:${JSON.stringify(`http://127.0.0.1:${server.port}/old.png`)},width:1,height:1,pixelCm:5}});
recorder.frame({robots:[{id:"robot-1",x:20}],assets:{mapUrl:${JSON.stringify(`http://127.0.0.1:${server.port}/current.png`)},width:1,height:1,pixelCm:5}});
await recorder.flush(); await recorder.close(); console.log("writer-finished");`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  try {
    await Promise.race([started, Bun.sleep(5000).then(() => { throw new Error("writer did not start asset capture"); })]);
    const resumeCopy = setTimeout(release, 700);
    const result = await resetBlackbox(root, confirmation);
    expect(result.cleared).toBe(true); expect(await child.exited).toBe(0); clearTimeout(resumeCopy);
    const hash = createHash("sha256").update(bytes).digest("hex");
    // A writer that started before deletion must not recreate deleted assets
    // in the active generation after reset has reported success.
    expect(await Bun.file(join(root, "assets", hash, "old.png")).exists()).toBe(false);
    expect(await Bun.file(join(root, "generations", result.generation.id, "assets", hash, "old.png")).exists()).toBe(false);
  } finally { release(); child.kill(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 10_000);

test("v2 reset requires explicit confirmation and preserves sibling operational files", async () => {
  const data = await mkdtemp(join(tmpdir(), "blackbox-v2-preserve-")), root = join(data, "blackbox");
  try {
    await writeFile(join(data, "runtime.sqlite"), "operator-state");
    await expect(resetBlackbox(root, { confirmationToken: "", scope: "blackbox" })).rejects.toThrow();
    expect(await readFile(join(data, "runtime.sqlite"), "utf8")).toBe("operator-state");
    await resetBlackbox(root, confirmation);
    expect(await readFile(join(data, "runtime.sqlite"), "utf8")).toBe("operator-state");
    expect((await readdir(data)).sort()).toEqual(["blackbox", "runtime.sqlite"]);
  } finally { await rm(data, { recursive: true, force: true }); }
});


test("v2 reset renews an idle checkpoint and recopies assets without changing the recorded scene", async () => {
  const data = await mkdtemp(join(tmpdir(), "blackbox-v2-idle-")), root = join(data, "blackbox"), map = join(data, "map.png");
  await writeFile(map, "source-map");
  const recorder = new Recorder({ root, source: "fms-yard", mapId: "yard" });
  const state = { mapId: "yard", robots: [{ id: "robot-1", x: 17, y: 23, commandId: "running-command", commandState: "running", operatorPaused: true }], assets: { mapUrl: map, width: 1, height: 1, pixelCm: 5 } };
  try {
    recorder.frame(state); await recorder.flush();
    const query = new BlackboxQuery(root), before = await query.catalog({ mapId: "yard" });
    expect(before.latestCheckpoint).toBeDefined();
    const reset = await resetBlackbox(root, confirmation); await recorder.flush();
    const after = await query.catalog({ mapId: "yard" });
    expect(after.generation.id).toBe(reset.generation.id);
    expect(after.latestCheckpoint?.eventId).not.toBe(before.latestCheckpoint?.eventId);
    expect(after.latestCheckpoint?.payload.state).toEqual(before.latestCheckpoint?.payload.state);
    expect(after.assets?.mapUrl).toBeTruthy();
    const second = await resetBlackbox(root, confirmation); await recorder.flush();
    expect(second.generation.id).not.toBe(reset.generation.id);
    const oldGenerationPresent = await stat(join(root, "generations", reset.generation.id)).then(() => true, () => false);
    expect(oldGenerationPresent).toBe(false);
    expect((await query.catalog({ mapId: "yard" })).latestCheckpoint).toBeDefined();
  } finally { await recorder.close(); await rm(data, { recursive: true, force: true }); }
});
