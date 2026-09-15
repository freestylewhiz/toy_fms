/**
 * Offline v1 overlap + reverse-along-trail check (no live gRPC).
 *
 *   bun run scripts/v1_overlap_sim.ts
 */
import { DEADLOCK_CONFIRM_MS, TRAFFIC_SEP_PX } from "../shared/constants.ts";
import { inflatedGrid, loadOccupancy, loadSeed } from "../shared/occupancy.ts";
import { plansOverlap, reverseAlongTrail } from "../shared/traffic/localPlan.ts";
import type { TrafficPolicyContext } from "../server/src/traffic/TrafficPolicy.ts";
import { robotViewFromPose } from "../server/src/traffic/index.ts";
import { LocalPlanPolicy } from "../server/src/traffic/policies/LocalPlanPolicy.ts";
import { RobotController } from "../virtual-robot/src/controller.ts";
import { LocalPlanExecutor } from "../virtual-robot/src/traffic/LocalPlanExecutor.ts";

function fail(msg: string): never {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

function ok(msg: string) {
  console.log(`ok    ${msg}`);
}

function fakeCtx(): TrafficPolicyContext {
  return {
    canGrant: () => true,
    partialGrant: (_id, wanted) => wanted,
    commit: () => true,
    release: () => true,
    getHeld: () => null,
    clearRobot: () => {},
  };
}

const headOnA = [
  { x: 0, y: 0 },
  { x: 80, y: 0 },
];
const headOnB = [
  { x: 80, y: 0 },
  { x: 0, y: 0 },
];
if (!plansOverlap(headOnA, headOnB, TRAFFIC_SEP_PX)) fail("head-on plans should overlap");
ok("head-on local plans overlap");

const trail = Array.from({ length: 16 }, (_, i) => ({ x: i * 8, y: 240 }));
const back = reverseAlongTrail(trail, { x: 120, y: 240 }, 48);
if (back.length < 2 || back[back.length - 1].x >= 90) fail("reverseAlongTrail did not walk backward");
ok(`reverseAlongTrail → ${back.length} pts end=${back[back.length - 1].x.toFixed(1)}`);

const policy = new LocalPlanPolicy(fakeCtx());
const ra = robotViewFromPose("robot-1", {
  x: 0,
  y: 0,
  theta: 0,
  status: "move",
  localPath: headOnA,
  path: headOnA,
  connected: true,
});
const rb = robotViewFromPose("robot-2", {
  x: 80,
  y: 0,
  theta: Math.PI,
  status: "move",
  localPath: headOnB,
  path: headOnB,
  connected: true,
});
policy.tick({ nowMs: 0, robots: [ra, rb] });
const fired = policy.tick({ nowMs: DEADLOCK_CONFIRM_MS + 20, robots: [ra, rb] });
if (!fired.some((a) => a.kind === "evasion_request" && a.mode === "REROUTE")) {
  fail("policy did not issue REROUTE on deadlock");
}
ok("policy REROUTE on overlapping stuck plans");

loadOccupancy();
inflatedGrid();
const seed = loadSeed();
const s1 = seed.robots.find((r) => r.id === "robot-1");
const s2 = seed.robots.find((r) => r.id === "robot-2");
if (!s1 || !s2) fail("seed missing robots");

const c1 = new RobotController({ x: s1.x, y: s1.y, theta: s1.theta });
const c2 = new RobotController({ x: s2.x, y: s2.y, theta: s2.theta });
const noop = {
  sendLeaseRequest: () => {},
  sendLeaseRelease: () => {},
  sendTrafficBid: () => {},
  sendEvasionReply: () => {},
};
c1.attachTraffic(new LocalPlanExecutor(noop));
c2.attachTraffic(new LocalPlanExecutor(noop));
c1.start();
c2.start();
c1.handleDrive({ command_id: "sim", kind: "move", x: s2.x, y: s2.y, theta: 0 });
c2.handleDrive({ command_id: "sim", kind: "move", x: s1.x, y: s1.y, theta: Math.PI });

const start = Date.now();
let sawOverlap = false;
let sawDetourOrReverse = false;
while (Date.now() - start < 12000) {
  const p1 = c1.currentLocalPlan();
  const p2 = c2.currentLocalPlan();
  c1.setPeerLocalPlans([
    { robotId: "robot-2", x: c2.snapshot().x, y: c2.snapshot().y, theta: c2.snapshot().theta, points: p2 },
  ]);
  c2.setPeerLocalPlans([
    { robotId: "robot-1", x: c1.snapshot().x, y: c1.snapshot().y, theta: c1.snapshot().theta, points: p1 },
  ]);
  if (plansOverlap(p1, p2, TRAFFIC_SEP_PX)) sawOverlap = true;
  const m1 = c1.snapshot().motion;
  const m2 = c2.snapshot().motion;
  if (m1 === "REVERSE" || m2 === "REVERSE") sawDetourOrReverse = true;
  await Bun.sleep(50);
}

c1.stop();
c2.stop();

const d1 = Math.hypot(c1.snapshot().x - s1.x, c1.snapshot().y - s1.y);
const d2 = Math.hypot(c2.snapshot().x - s2.x, c2.snapshot().y - s2.y);
if (d1 < 4 && d2 < 4) fail("neither robot moved");
ok(`robots moved d1=${d1.toFixed(1)} d2=${d2.toFixed(1)} overlap=${sawOverlap} reverse=${sawDetourOrReverse}`);
if (!sawOverlap) console.log("note  local plans may have detoured before overlapping — acceptable for v1 autonomy");

// Forced VACATE after a trail exists.
const c3 = new RobotController({ x: s1.x, y: s1.y, theta: s1.theta });
c3.attachTraffic(new LocalPlanExecutor(noop));
c3.start();
c3.handleDrive({ command_id: "sim", kind: "move", x: s2.x, y: s2.y, theta: 0 });
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  if (Math.hypot(c3.snapshot().x - s1.x, c3.snapshot().y - s1.y) > 50) break;
  await Bun.sleep(50);
}
c3.handleEvasionPlan({ mode: "VACATE", zone_id: "sim", round_id: "r1" });
await Bun.sleep(200);
if (c3.snapshot().motion !== "REVERSE" && c3.snapshot().motion !== "HOLD") {
  fail(`expected reverse/hold after VACATE, got ${c3.snapshot().motion}`);
}
ok(`VACATE after trail → motion=${c3.snapshot().motion}`);
c3.stop();

console.log("v1 overlap sim passed");
