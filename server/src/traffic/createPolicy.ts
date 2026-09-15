import { TRAFFIC_POLICY_ID } from "../../../shared/constants.ts";
import { parseTrafficPolicyId } from "../../../shared/traffic/types.ts";
import { CorridorLeasePolicy } from "./policies/CorridorLeasePolicy.ts";
import { LocalPlanPolicy } from "./policies/LocalPlanPolicy.ts";
import type { TrafficPolicy, TrafficPolicyContext } from "./TrafficPolicy.ts";

export function createTrafficPolicy(
  ctx: TrafficPolicyContext,
  listHeldRobotIds: () => string[],
): TrafficPolicy {
  const id = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  if (id === "local_plan_v1") {
    console.log("[traffic] policy = local_plan_v1");
    return new LocalPlanPolicy(ctx);
  }
  console.log("[traffic] policy = corridor_lease_v0");
  const p = new CorridorLeasePolicy(ctx);
  p.listHeldRobotIds = listHeldRobotIds;
  return p;
}
