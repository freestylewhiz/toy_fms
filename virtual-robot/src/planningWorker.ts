import { PlanningFailures } from "../../shared/config/robot.ts";
import { commitMapContext, prepareMapContext } from "../../shared/occupancy.ts";
import { MAP_ID } from "../../shared/constants.ts";
import { ObstacleMaskBuffer } from "../../shared/obstacles.ts";
import { planRoute, setPlanningObstacles, setSemanticZones } from "../../shared/planner.ts";
import { setExtraBlocked } from "../../shared/occupancy.ts";
import type { PlanningRequest, RoutePlan } from "./planning.ts";

type WorkerResponse = { requestId: number; route?: RoutePlan | null; error?: string; failure?: typeof PlanningFailures.code.timeout | typeof PlanningFailures.code.worker_error };

const mask = new ObstacleMaskBuffer();
let activeMapId = MAP_ID;

function respond(message: WorkerResponse): void {
  process.send?.(message);
}

process.on("disconnect", () => process.exit(0));
process.on("message", (request: PlanningRequest) => {
  try {
    if (request.mapId !== activeMapId) {
      commitMapContext(prepareMapContext(request.mapId));
      mask.clear();
      activeMapId = request.mapId;
    }
    setSemanticZones(request.zones);
    setExtraBlocked(request.obstacles.length ? mask.rasterize(request.obstacles) : null);
    // Bind exact geometry to the just-refreshed mask revision. A stale
    // geometry snapshot must never relax a newer conservative mask.
    setPlanningObstacles(request.obstacles);
    const started = performance.now();
    const route = planRoute(request.start, request.goal);
    const elapsed = performance.now() - started;
    // A synchronous A* cannot be interrupted from inside this process. The
    // client kills it when the budget expires; this check prevents a
    // late result from being accepted when the calculation crossed the budget.
    if (elapsed > request.timeBudgetMs) {
      respond({ requestId: request.requestId, error: "planning time budget exceeded", failure: PlanningFailures.code.timeout });
      return;
    }
    respond({ requestId: request.requestId, route });
  } catch (error) {
    respond({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error), failure: PlanningFailures.code.worker_error });
  }
});
