import { EVENT_CATEGORIES } from "./config/events.ts";
import { BLACKBOX_CONFIRMATIONS, BLACKBOX_SCOPES } from "./config/blackbox.ts";
/**
 * Browser-safe blackbox event contract.
 *
 * This module deliberately contains no filesystem, Bun, Node, or server
 * imports.  Live and replay channels can use the same envelope in the web
 * client while the server owns persistence and querying.
 */

export const BLACKBOX_SCHEMA_VERSION = 1 as const;

/** Only these sources may provide scene checkpoints for a replay channel. */
export function isAuthoritativeBlackboxFrameSource(source: string): boolean {
  return source === "fms" || source === "floor-room" || source.startsWith("fms-") || source.startsWith("fms:");
}

export type BlackboxCategory = (typeof EVENT_CATEGORIES.values)[number];

export type BlackboxPayload = Record<string, unknown>;

/** Fields assigned by Recorder and therefore omitted by producers. */
export type BlackboxEventInput = {
  timeMs?: number;
  category: BlackboxCategory;
  kind: string;
  robotId?: string;
  operationId?: string;
  commandId?: string;
  requestId?: string;
  payload: BlackboxPayload;
};

export type BlackboxEvent = Omit<BlackboxEventInput, "timeMs"> & {
  schemaVersion: typeof BLACKBOX_SCHEMA_VERSION;
  eventId: string;
  timeMs: number;
  sequence: number;
  source: string;
  bootId: string;
  mapId: string;
};

export type BlackboxAssetDescriptor = {
  mapUrl: string;
  occupancyUrl?: string;
  inflatedUrl?: string;
  width: number;
  height: number;
  pixelCm: number;
  mapRevision?: string;
};

export type BlackboxFramePayload = {
  state: Record<string, unknown>;
  assets?: BlackboxAssetDescriptor;
};

export type BlackboxRecorderOptions = {
  source: string;
  mapId: string;
  /** Blackbox root. Defaults to $FMS_DATA_ROOT/blackbox or ./data/blackbox. */
  root?: string;
};

export type BlackboxEventQuery = {
  asOf: number;
  events: BlackboxEvent[];
  nextCursor?: string;
};

export type BlackboxGap = {
  kind: string;
  source?: string;
  bootId?: string;
  mapId?: string;
  timeMs?: number;
  fromSequence?: number;
  toSequence?: number;
  detail?: string;
};

export type BlackboxReplayQuery = {
  schemaVersion: typeof BLACKBOX_SCHEMA_VERSION;
  mapId: string;
  startEvent: BlackboxEvent;
  endEvent: BlackboxEvent;
  checkpoint: BlackboxEvent;
  /** Render-channel events; raw protocol can be obtained from operation trace. */
  events: BlackboxEvent[];
  gaps: BlackboxGap[];
};

export type BlackboxOperationQuery = {
  operationId: string;
  events: BlackboxEvent[];
  nextCursor?: string;
};

export type RobotEventQueryInput = {
  mapId: string;
  robotId: string;
  fromMs?: number;
  toMs?: number;
  asOf?: number;
  cursor?: string;
  limit?: number;
  levels?: string[];
  categories?: BlackboxCategory[];
  includePose?: boolean;
};

export type RobotEventQuery = {
  asOf: number;
  events: BlackboxEvent[];
  nextCursor?: string;
  /** True when a recorder gap/truncation was observed while reading. */
  gap: boolean;
  truncated: boolean;
};

/** Stable storage generation. A reset advances this value atomically. */
export type BlackboxGeneration = {
  id: string;
  createdAt: number;
};

export type BlackboxCatalog = {
  schemaVersion: typeof BLACKBOX_SCHEMA_VERSION;
  mapId: string;
  generation: BlackboxGeneration;
  availableFrom?: number;
  availableTo?: number;
  latestCheckpoint?: BlackboxEvent;
  assets?: BlackboxAssetDescriptor;
  gap: boolean;
  truncated: boolean;
};

export type BlackboxWindowQueryInput = {
  mapId: string;
  fromMs?: number;
  toMs?: number;
  asOf?: number;
  cursor?: string;
  limit?: number;
};

export type BlackboxWindowQuery = {
  schemaVersion: typeof BLACKBOX_SCHEMA_VERSION;
  mapId: string;
  generation: BlackboxGeneration;
  asOf: number;
  fromMs: number;
  toMs: number;
  availableFrom?: number;
  availableTo?: number;
  checkpoint: BlackboxEvent;
  events: BlackboxEvent[];
  gaps: BlackboxGap[];
  assets: BlackboxAssetDescriptor;
  nextCursor?: string;
  gap: boolean;
  truncated: boolean;
};

export type BlackboxResetConfirmation = {
  /** Must be the explicit operator confirmation token. */
  confirmationToken: string;
  scope: (typeof BLACKBOX_SCOPES.values)[number];
};

export type BlackboxResetResult = {
  generation: BlackboxGeneration;
  cleared: true;
  cleanupComplete: boolean;
  cleanupError?: string;
};

export type BlackboxRecorder = {
  record(input: BlackboxEventInput): BlackboxEvent | undefined;
  frame(state: Record<string, unknown>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};
