import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { commitMapContext, isPlanFree, prepareMapContext, robotFootprintClear, setExtraBlocked } from "../shared/occupancy.ts";
import { ObstacleMaskBuffer, poseHitsAny, type DynObstacle } from "../shared/obstacles.ts";
import { PEER_OBSTACLE_RADIUS_PX } from "../shared/constants.ts";
import { clearSemanticZones, planRoute, setSemanticZones } from "../shared/planner.ts";
import { buildSemanticNavigation, isSemanticPoseBlocked } from "../shared/semanticNavigation.ts";
import type { Point, ZoneResource } from "../shared/semantic.ts";

type Frame = {
  payload: {
    state: {
      robots: Record<string, any>;
      zones: Record<string, any>;
    };
  };
};

type Route = NonNullable<ReturnType<typeof planRoute>>;
type Mode = "fine" | "coarse";

const framePath = process.env.FMS_COARSE_FRAME ?? "/tmp/fms-bottleneck-frame.json";
const outputPath = process.env.FMS_COARSE_BENCHMARK_OUT ?? "/tmp/fms-coarse-planner-benchmark.json";
const frame = JSON.parse(readFileSync(framePath, "utf8")) as Frame;
const state = frame.payload.state;
const source = state.robots["robot-1"];
const peer = state.robots["robot-2"];
const start: Point = { x: source.x, y: source.y };
const goal: Point = { x: 2565.5633180387413, y: 2262.3423220583577 };

function parseZones(): ZoneResource[] {
  return Object.values(state.zones).map((raw) => ({
    ...raw,
    ...JSON.parse(raw.paramsJson ?? "{}"),
    polygon: JSON.parse(raw.polygonJson),
  })) as ZoneResource[];
}

function obstacles(): DynObstacle[] {
  return [
    {
      id: "peer:robot-2",
      kind: "circle",
      x: peer.x,
      y: peer.y,
      theta: peer.theta,
      size: PEER_OBSTACLE_RADIUS_PX,
    },
    ...peer.localPath
      .filter((_: Point, i: number) => i % 2 === 0)
      .map((point: Point, i: number) => ({
        id: `peerplan:robot-2:${i * 2}`,
        kind: "circle" as const,
        x: point.x,
        y: point.y,
        theta: 0,
        size: PEER_OBSTACLE_RADIUS_PX,
      })),
  ];
}

function physicalDistance(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

function weightedCost(points: Point[], navigation: ReturnType<typeof buildSemanticNavigation>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const multiplier = navigation.costs?.[Math.round(midpoint.y) * 10_000 + Math.round(midpoint.x)] ?? navigation.costAt?.(midpoint) ?? 1;
    total += distance * multiplier;
  }
  return total;
}

function validate(route: Route | null, zones: ZoneResource[], navigation: ReturnType<typeof buildSemanticNavigation>, dynamicObstacles: DynObstacle[]): { valid: boolean; startErrorPx: number; endpointErrorPx: number; distancePx: number; weightedCost: number; followPoints: number; displayPoints: number; diagnostics?: Route["diagnostics"] } {
  if (!route) return { valid: false, startErrorPx: Infinity, endpointErrorPx: Infinity, distancePx: Infinity, weightedCost: Infinity, followPoints: 0, displayPoints: 0 };
  const routeStart = route.follow[0];
  const endpoint = route.follow.at(-1);
  const startErrorPx = routeStart ? Math.hypot(routeStart.x - start.x, routeStart.y - start.y) : Infinity;
  const endpointErrorPx = endpoint ? Math.hypot(endpoint.x - goal.x, endpoint.y - goal.y) : Infinity;
  let safe = route.follow.length > 0 && startErrorPx < 1e-6 && endpointErrorPx < 1e-6;
  for (let i = 1; i < route.follow.length && safe; i++) {
    const a = route.follow[i - 1], b = route.follow[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(distance));
    const heading = distance > 1e-9 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x >= 10_000 || point.y < 0 || point.y >= 10_000 || !isPlanFree(point.x, point.y) || isSemanticPoseBlocked(zones, point) || navigation.isBlocked?.(point) || poseHitsAny(point.x, point.y, heading, dynamicObstacles) || !robotFootprintClear(point.x, point.y, heading)) {
        safe = false;
        break;
      }
    }
  }
  return {
    valid: safe,
    startErrorPx,
    endpointErrorPx,
    distancePx: physicalDistance(route.follow),
    weightedCost: weightedCost(route.follow, navigation),
    followPoints: route.follow.length,
    displayPoints: route.display.length,
    diagnostics: route.diagnostics,
  };
}

function runMode(mode: Mode, context: ReturnType<typeof prepareMapContext>, zones: ZoneResource[], mask: Uint8Array, dynamicObstacles: DynObstacle[], navigation: ReturnType<typeof buildSemanticNavigation>): { mode: Mode; setupMs: number; coldMs: number; warmMs: number[]; refreshedWarmMs: number[]; cold: ReturnType<typeof validate>; warm: ReturnType<typeof validate>[]; refreshedWarm: ReturnType<typeof validate>[] } {
  // A fresh context makes the first route a cold static-cache request. The
  // obstacle and semantic snapshot are identical for both modes.
  const setupStart = performance.now();
  commitMapContext(context);
  setSemanticZones(zones);
  setExtraBlocked(mask);
  const setupMs = performance.now() - setupStart;
  const options = mode === "fine" ? { coarseCellSizePx: 1 } : undefined;
  const coldStart = performance.now();
  const coldRoute = planRoute(start, goal, options);
  const coldMs = performance.now() - coldStart;
  const warmMs: number[] = [];
  const warm: ReturnType<typeof validate>[] = [];
  for (let i = 0; i < 3; i++) {
    const begin = performance.now();
    const route = planRoute(start, goal, options);
    warmMs.push(performance.now() - begin);
    warm.push(validate(route, zones, navigation, dynamicObstacles));
  }
  const refreshedWarmMs: number[] = [];
  const refreshedWarm: ReturnType<typeof validate>[] = [];
  for (let i = 0; i < 3; i++) {
    const refreshStart = performance.now();
    setSemanticZones(zones);
    setExtraBlocked(mask);
    const routeStart = performance.now();
    const route = planRoute(start, goal, options);
    refreshedWarmMs.push(performance.now() - routeStart + (routeStart - refreshStart));
    refreshedWarm.push(validate(route, zones, navigation, dynamicObstacles));
  }
  return { mode, setupMs, coldMs, warmMs, refreshedWarmMs, cold: validate(coldRoute, zones, navigation, dynamicObstacles), warm, refreshedWarm };
}

const context = prepareMapContext("large_lab");
commitMapContext(context);
const zones = parseZones();
const dynamicObstacles = obstacles();
const mask = new ObstacleMaskBuffer().rasterize(dynamicObstacles);
const navigation = buildSemanticNavigation(zones, { width: 10_000, height: 10_000 });
const results = [runMode("fine", context, zones, mask, dynamicObstacles, navigation), runMode("coarse", context, zones, mask, dynamicObstacles, navigation)];
clearSemanticZones();
setExtraBlocked(null);

const summary = {
  generatedAt: new Date().toISOString(),
  framePath,
  mapId: "large_lab",
  source: { start, goal },
  coarseCellSizePx: 16,
  repeats: 3,
  processIsolation: "single benchmark process; both modes use the same recorded snapshot",
  results,
};
await Bun.write(outputPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
