/** 테스트 야드: 큰 홀 + 좁은 복도 + 교차로. 1px = 5cm → 80m × 60m. */
export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1200;
export const PIXEL_CM = 5;
export const FREE_LUMA_THRESHOLD = 230;

/** Robot body in map pixels (heading along +length). */
export const ROBOT_LENGTH_PX = 16;
export const ROBOT_WIDTH_PX = 10;
export const PLAN_INFLATE_PX = 8;

export const LINEAR_SPEED_PX_S = 12; // 0.60 m/s
export const ANGULAR_SPEED_RAD_S = Math.PI / 2; // 90 deg/s
export const TICK_MS = 50;
export const HEADING_TOLERANCE_RAD = (3 * Math.PI) / 180;
export const LOOKAHEAD_S = 5;
export const PLACE_QUERY_TIMEOUT_MS = 700;
export const OBSTACLE_MIN_SIZE = 10;
export const OBSTACLE_MAX_SIZE = 80;

/** Robot circumscribed radius (px). Corridor radius must exceed this (I2). */
export const ROBOT_CIRCUMRADIUS_PX = Math.hypot(ROBOT_LENGTH_PX, ROBOT_WIDTH_PX) / 2;
export const CORRIDOR_MIN_RADIUS = 12;
export const CORRIDOR_MAX_RADIUS = 26;
export const CORRIDOR_GAP_PX = 4;
export const CAPSULE_FIT_TOL_PX = 1.5;

export const PERMIT_HORIZON_S = LOOKAHEAD_S;
export const LEASE_REQUEST_AHEAD_S = 2;
export const AUTHORITY_HZ = 10;
export const LEASE_MS = 400;
export const RELEASE_HYSTERESIS_PX = 8;

export const BID_WINDOW_MS = 120;
export const STARVATION_MS = 8000;
export const ZONE_HYSTERESIS_MS = 500;
export const DEADLOCK_CONFIRM_MS = 2000;

export const EVASION_DEADLINE_MS = 800;
export const MAX_REROUTE_ROUNDS = 2;
export const MAX_REVERSAL = 1;
export const PROGRESS_EPSILON_PX = 2;

export const COORD_SAMPLE_PX = 4;
export const TRAFFIC_SEP_PX = 2 * CORRIDOR_MIN_RADIUS;
export const TRAFFIC_CELL_PX = 20;

export const DISCONNECT_HALO_PX = LINEAR_SPEED_PX_S * LOOKAHEAD_S;
export const DISCONNECT_FREEZE_MS = 3000;
export const WATCHDOG_TOLERANCE_PX = 2;

export const AVOIDANCE_MODE_DEFAULT = true;
export const BREADCRUMB_SPACING_PX = 20;
export const BREADCRUMB_MAX = 64;

/**
 * TRAFFIC_POLICY_ID — which traffic stack to run.
 *
 * local_plan_v1     : robots share ~5s local paths; FMS syncs + deadlock evade
 * corridor_lease_v0 : exclusive corridor leases (traffic light)
 *
 * Override with env TRAFFIC_POLICY_ID without changing code.
 */
export const TRAFFIC_POLICY_ID = (typeof process !== "undefined" && process.env?.TRAFFIC_POLICY_ID) || "local_plan_v1";

/**
 * SIM_PEER_SENSING — virtual-robot only "sensor proxy".
 *
 * Real robots would see a stopped peer via onboard sensing and treat it as an
 * obstacle. Virtual robots have no LIDAR, so when this flag is true the FMS
 * forwards other robots' poses over gRPC and each robot merges them as local
 * circle obstacles. This intentionally relaxes PI6 for the simulator only.
 *
 * false → strict PI6 (no peer geometry from FMS); peers are invisible locally.
 */
export const SIM_PEER_SENSING_DEFAULT = true;

/**
 * Circle radius used when projecting a sensed peer into DynObstacle space.
 * Sized like the robot circumscribed radius plus a small sensing margin.
 */
export const PEER_OBSTACLE_RADIUS_PX = ROBOT_CIRCUMRADIUS_PX + 2;

/** How often FMS pushes sensed_peers snapshots when SIM_PEER_SENSING is on. */
export const SIM_PEER_SENSING_HZ = 10;

/**
 * Opportunistic replan vs peers (sim sensing).
 * Drop stale detours when a peer has parked or left — but never replan during
 * an active traffic STOP/partial/hold fight (that re-triggers corridor deadlock).
 */
export const SIM_PEER_REPLAN_MIN_MS = 900;
/** Peer translation that counts as "moved" for parked detection. */
export const SIM_PEER_MOVE_REPLAN_PX = 6;
/** Peer must stay still this long to count as parked (then A* may go around). */
export const SIM_PEER_STATIONARY_MS = 700;
/** Absolute remaining-length improvement required to switch paths. */
export const SIM_PEER_REPLAN_IMPROVE_PX = 28;
/** Relative improvement vs current remaining length (0.12 = 12%). */
export const SIM_PEER_REPLAN_IMPROVE_RATIO = 0.12;

if (!(CORRIDOR_MIN_RADIUS > ROBOT_CIRCUMRADIUS_PX)) {
  throw new Error("CORRIDOR_MIN_RADIUS must exceed ROBOT_CIRCUMRADIUS_PX");
}
if (!(CORRIDOR_GAP_PX > (LINEAR_SPEED_PX_S * TICK_MS) / 1000 * 4)) {
  throw new Error("CORRIDOR_GAP_PX too small vs tick travel");
}
if (!(COORD_SAMPLE_PX < TRAFFIC_SEP_PX / 2)) {
  throw new Error("COORD_SAMPLE_PX must be < TRAFFIC_SEP_PX / 2");
}
if (!(LEASE_MS >= 3 * (1000 / AUTHORITY_HZ))) {
  throw new Error("LEASE_MS must cover ≥3 authority periods");
}

/** 원본 bg_fms(2567/50061/5173)와 동시에 띄울 수 있게 포트를 옮김. */
export const COLYSEUS_PORT = 2568;
export const GRPC_PORT = 50062;
export const WEB_CLIENT_PORT = 5174;

export const ROOM_NAME = "floor";

export const ROBOT_IDS = ["robot-1", "robot-2"] as const;
export const ROBOT_SPRITES: Record<string, string> = {
  "robot-1": "robot.png",
  "robot-2": "robot-2.png",
};
