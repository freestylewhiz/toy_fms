import { EditorStore } from "../shared/store.ts";
import { loadSeed, setExtraBlocked } from "../shared/occupancy.ts";
import { clearSemanticZones, planDrive, setSemanticSnapshot } from "../shared/planner.ts";
import { rasterizeObstacles } from "../shared/obstacles.ts";

const snapshot = new EditorStore().snapshot();
const targets = snapshot.waypoints.filter(p => p.id.startsWith("drive-"));
if (!targets.length) throw new Error("Run bun run setup:driving first");
setSemanticSnapshot(snapshot);
setExtraBlocked(rasterizeObstacles(snapshot.obstacles));
try {
  for (const robot of loadSeed().robots) {
    for (const target of [...targets, ...snapshot.chargers]) {
      const path = planDrive(robot, target);
      if (!path?.length) throw new Error(`No route: ${robot.id} -> ${target.id}`);
      const end = path[path.length - 1];
      if (Math.hypot(end.x - target.x, end.y - target.y) > 1) throw new Error(`Target only reachable by snapping: ${target.id}`);
      console.log(`ok ${robot.id} -> ${target.id}`);
    }
  }
} finally { clearSemanticZones(); setExtraBlocked(null); }
