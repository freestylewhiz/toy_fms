/** Application protocol carried by RobotBridge.Session. */
export const PROTOCOL_VERSION = 2;
export const HEARTBEAT_MS = 500;
export const SESSION_TIMEOUT_MS = 3000;

export const COMMAND_STATES = [
  "idle", "sent", "accepted", "running", "completed", "cancelled", "rejected", "failed", "interrupted",
] as const;
export type CommandState = typeof COMMAND_STATES[number];
export type CommandStateUpdate = { commandId: string; state: CommandState; reason: string };

export function parseCommandState(value: unknown): CommandState | null {
  return typeof value === "string" && (COMMAND_STATES as readonly string[]).includes(value) ? value as CommandState : null;
}

export function isTerminalCommandState(state: CommandState): boolean {
  return state === "completed" || state === "cancelled" || state === "rejected" || state === "failed";
}

export type ProtocolEnvelope = { control_epoch: number; session_id: string };
