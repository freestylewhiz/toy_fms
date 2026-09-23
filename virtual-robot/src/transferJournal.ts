import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeMap } from "../../shared/maps.ts";

export type JournalPose = { x: number; y: number; theta: number };
export type JournalPending = { transferId: string; destinationMapId: string; destinationTarget: string; exit: JournalPose; clearing: { x: number; y: number } };
export type TransferJournal = { version: 1; robotId: string; currentMapId: string; pose: JournalPose; lastTransferId?: string; pending?: JournalPending };

/** A recovery boundary intentionally has no transferable mission state. */
export function settledPoseJournal(robotId: string, currentMapId: string, pose: JournalPose): TransferJournal {
  return { version: 1, robotId, currentMapId, pose: { x: pose.x, y: pose.y, theta: pose.theta } };
}

export function readTransferJournal(path: string, robotId: string): TransferJournal | null {
  if (!existsSync(path)) return null;
  let value: TransferJournal;
  try { value = JSON.parse(readFileSync(path, "utf8")) as TransferJournal; } catch (error) { throw new Error(`invalid transfer journal: ${String(error)}`); }
  if (value.version !== 1 || value.robotId !== robotId || !value.currentMapId) throw new Error("invalid transfer journal identity");
  try { runtimeMap(value.currentMapId); } catch { throw new Error("unknown transfer journal map"); }
  if (!finitePose(value.pose)) throw new Error("invalid transfer journal pose");
  if (value.pending && (!value.pending.transferId || !value.pending.destinationMapId || !finitePose(value.pending.exit) || ![value.pending.clearing.x, value.pending.clearing.y].every(Number.isFinite))) throw new Error("invalid pending transfer journal");
  return value;
}

export function writeTransferJournal(path: string, value: TransferJournal): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function finitePose(value: JournalPose | undefined): value is JournalPose {
  return !!value && [value.x, value.y, value.theta].every(Number.isFinite);
}
