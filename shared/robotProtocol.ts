import { CommandStates, type CommandState as CatalogCommandState } from "./config/index.ts";

/** Application protocol carried by RobotBridge.Session. */
export const PROTOCOL_VERSION = 5;
export const HEARTBEAT_MS = 500;
export const SESSION_TIMEOUT_MS = 3000;

export const COMMAND_STATES = CommandStates.values;
export type CommandState = CatalogCommandState;
export type CommandStateUpdate = { commandId: string; state: CommandState; reason: string };

export function parseCommandState(value: unknown): CommandState | null {
  return CommandStates.is(value) ? value : null;
}

export function isTerminalCommandState(state: CommandState): boolean {
  return state === "completed" || state === "cancelled" || state === "rejected" || state === "failed";
}

export type ProtocolEnvelope = { control_epoch: number; session_id: string };
export type MotionPauseRequest = ProtocolEnvelope & { request_id: string; paused: boolean };
export type MotionPauseAck = ProtocolEnvelope & { robot_id: string; request_id: string; paused: boolean; applied: boolean; reason_code: string };
