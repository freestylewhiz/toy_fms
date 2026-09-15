import { isTerminalCommandState, type CommandState } from "../../shared/robotProtocol.ts";

export type CommandProjection = { commandId: string; commandState: CommandState; commandReason: string };

/** Monotonic command state projection shared by room and protocol tests. */
export function projectCommandState(current: CommandProjection, commandId: string, state: CommandState, reason: string): CommandProjection {
  if (!commandId) return current;
  if (current.commandId && current.commandId !== commandId) return current;
  if (current.commandId === commandId && isTerminalCommandState(current.commandState)) return current;
  const rank: Record<CommandState, number> = { idle: 0, sent: 1, accepted: 2, running: 3, interrupted: 4, completed: 5, cancelled: 5, rejected: 5, failed: 5 };
  if (current.commandId === commandId && current.commandState === "interrupted" && (state === "accepted" || state === "running")) return { commandId, commandState: state, commandReason: reason };
  if (current.commandId === commandId && rank[state] < rank[current.commandState]) return current;
  return { commandId, commandState: state, commandReason: reason };
}
