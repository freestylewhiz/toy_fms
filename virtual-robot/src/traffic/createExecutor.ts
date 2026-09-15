import { TRAFFIC_POLICY_ID } from "../../../shared/constants.ts";
import { parseTrafficPolicyId } from "../../../shared/traffic/types.ts";
import { CorridorLeaseExecutor, grantFromProto } from "./CorridorLeaseExecutor.ts";
import { LocalPlanExecutor, grantFromProtoV1 } from "./LocalPlanExecutor.ts";
import type { TrafficExecutor, TrafficExecutorHooks, TrafficGrant } from "./TrafficExecutor.ts";

export function createTrafficExecutor(hooks: TrafficExecutorHooks): TrafficExecutor {
  const id = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  if (id === "local_plan_v1") {
    console.log("[robot] traffic executor = local_plan_v1");
    return new LocalPlanExecutor(hooks);
  }
  console.log("[robot] traffic executor = corridor_lease_v0");
  return new CorridorLeaseExecutor(hooks);
}

export function grantFromWire(msg: any): TrafficGrant {
  const id = parseTrafficPolicyId(TRAFFIC_POLICY_ID);
  if (id === "local_plan_v1") return grantFromProtoV1(msg);
  return grantFromProto(msg);
}
