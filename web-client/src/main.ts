import { Client, type Room } from "colyseus.js";
import {
  COLYSEUS_PORT,
  canonicalRobotId,
  MAP_HEIGHT as YARD_MAP_HEIGHT,
  MAP_WIDTH as YARD_MAP_WIDTH,
  ROBOT_SPRITES,
  ROOM_NAME,
} from "../../shared/constants.ts";
import { clampObstaclePos, clampObstacleSize, parseObstacleKind, type ObstacleKind } from "../../shared/obstacles.ts";
import { SCENE_ZONE_KINDS, type Point } from "../../shared/semantic.ts";
import {
  centroid,
  signedArea,
  canAppendVertex,
  insertVertex,
  isSimplePolygon,
  removeVertex,
  replaceVertex,
  translatePoly,
} from "../../shared/polygon.ts";
import { applyCamera, fitCamera, screenToWorld, type Camera, zoomAt } from "./camera.ts";
import { drawPoseEditor, drawWorld, hitPoseEditor, hitTest, hitZoneHandle } from "./render.ts";
import { canDispatchRobot, projectTransport, snapshotFromState, type Snapshot } from "./snapshot.ts";
import { mountWorkspace } from "./workspace.ts";
import { confirmResourceDeletion } from "./confirmation.ts";
import { icon, resourceLabels } from "./icons.ts";
import { createBlueprint, drawOverview } from "./overview.ts";
import { rectangle, enclosed, selectionItems, selectionKey, type SelectionItem } from './selection.ts';
import { validateZoneForGuidance, zoneGuidance } from './zoneGuidance.ts';
import { poseConflicts, type PoseCandidate } from './poseOverride.ts';
import {
  BlackboxEventChannel,
  LiveEventChannel,
  type BlackboxEvent,
  type BlackboxUpdate,
  type HistoricalAssets,
} from './blackbox.ts';
import { EVENT_CATEGORIES, EVENT_LEVELS } from '../../shared/config/events.ts';
import { REASON_CODES } from '../../shared/config/reasons.ts';
import {
  EditHandles, TimeRangeBounds, type EditHandle, type TimeRangeBound,
  AppModes, CommandStates, ConnectionStates, DirectedLimitations, DriveStates, EditModes,
  EditSessionStatuses, FmsControlStates, NavigationModes, OccupancyLayers, OccupancyStates,
  PathPlanningAuthorities, PoseAssets, PreviewMapIds, ResourceFamilies, RuntimeMapIds,
  ReplayStatuses, StationKinds, TeleporterEndpointSteps, TrafficStatuses, TrafficStatusDetails, ToolKinds, ViewSources, WorkStates,
  ZoneKinds, ZoneReleaseLossBehaviors,
  type AppMode, type EditMode, type EditSessionStatus, type OccupancyLayer, type PoseAsset as PoseAssetCode,
  type ResourceFamily, type TeleporterEndpointStep, type ToolKind, type ViewSource as ViewSourceCode, type ZoneKind,
} from '../../shared/config/index.ts';
import { formatEventLabel, formatEventMessage, formatEventTime } from '../../shared/eventDisplay.ts';

let multiSelection = new Set<string>();
let marquee: { start: Point; end: Point; additive: boolean } | null = null;
let cursorScreen: { x: number; y: number } | null = null;
function updateCanvasCursor(): void {
  let cursor = tool === 'select' ? 'default' : 'crosshair';
  if (panning) cursor = 'grabbing';
  else if (spaceDown) cursor = 'grab';
  else if (editDrag === EditHandles.code.rotate) cursor = 'crosshair';
  else if (editDrag === EditHandles.code.size) cursor = 'nwse-resize';
  else if (editDrag || zoneDrag || dragging) cursor = 'grabbing';
  else if (cursorScreen && !marquee) {
    const p = screenToWorld(cam, cursorScreen.x, cursorScreen.y);
    const px = 1 / Math.max(cam.scale, 0.005);
    if (editSession?.kind === 'pose') {
      const handle = hitPoseEditor(editSession, p.x, p.y, px);
      cursor = handle === 'rotate' ? 'crosshair' : handle === 'body' ? 'grab' : editSession.asset === 'obstacle' ? 'nwse-resize' : 'grab';
    } else if (tool === 'select') {
      const s = snap();
      const handle = hitZoneHandle(s, p.x, p.y, selected?.kind === 'zone' ? selected.id : undefined, px, zonePreview ?? undefined);
      const hit = hitTest(s, p.x, p.y, 24 / Math.max(cam.scale, .01));
      cursor = handle ? (handle.type === 'mid' ? 'copy' : 'grab')
        : hit ? (['waypoint', 'charger', 'obstacle', 'node', 'station', 'zone'].includes(hit.kind) ? 'grab' : 'pointer') : 'default';
    }
  }
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
}
function selectedItems(): SelectionItem[] {
  return selectionItems(snap(), layers).filter(item => multiSelection.has(selectionKey(item)));
}
function clearMulti(): void {
  multiSelection.clear();
  marquee = null;
}
function fitSelection(): void {
  const items = selectedItems();
  if (!items.length) return;
  const x = Math.min(...items.map(i => i.bounds.x)), y = Math.min(...items.map(i => i.bounds.y));
  const width = Math.max(40, Math.max(...items.map(i => i.bounds.right)) - x);
  const height = Math.max(40, Math.max(...items.map(i => i.bounds.bottom)) - y);
  cam = fitCamera(viewport.clientWidth, viewport.clientHeight, width, height, 70);
  cam.x -= x * cam.scale;
  cam.y -= y * cam.scale;
  draw();
}

type Mode = AppMode;
type Tool = ToolKind;
type PoseAsset = PoseAssetCode;
type MapId = (typeof RuntimeMapIds.values)[number] | (typeof PreviewMapIds.values)[number];

type EditSession = (
  | {
      kind: "pose";
      mode: EditMode;
      asset: PoseAsset;
      id?: string;
      x: number;
      y: number;
      theta: number;
      size?: number;
    }
  | {
      kind: "zone";
      mode: EditMode;
      id?: string;
      family: ResourceFamily;
      zoneKind: ZoneKind;
      name: string;
      polygon: Point[];
      factor?: number;
      maximumSpeed?: number;
      capacity?: number;
      theta: number;
    }
) & { name: string; source?: Record<string, any> };

type MapSpec = {
  id: MapId;
  serverPort?: number;
  label: string;
  version: string;
  width: number;
  height: number;
  pixelCm: number;
  map: string;
  occupancy: string;
  inflated: string;
  editable: boolean;
};

const MAP_CATALOG: Record<MapSpec["id"], MapSpec> = {
  [RuntimeMapIds.code.yard]: {
    id: RuntimeMapIds.code.yard,
    label: "Yard",
    version: "v1",
    width: YARD_MAP_WIDTH,
    height: YARD_MAP_HEIGHT,
    pixelCm: 5,
    map: "/resources/maps/yard.png",
    occupancy: "/resources/maps/occupancy.bin",
    inflated: "/resources/maps/occupancy_inflated.bin",
    editable: true,
    serverPort: 2568,
  },
  [RuntimeMapIds.code.large_lab]: {
    id: RuntimeMapIds.code.large_lab, label: "Large Lab · 1억 픽셀", version: "v1",
    width: 10000, height: 10000, pixelCm: 5,
    map: "/resources/maps/large_lab.preview.png",
    occupancy: "/resources/maps/large_lab.occupancy.bin",
    inflated: "/resources/maps/large_lab.occupancy_inflated.bin",
    editable: true, serverPort: 2569,
  },
  [PreviewMapIds.code["1st_floor"]]: {
    id: PreviewMapIds.code["1st_floor"],
    label: "1st Floor",
    version: "v1",
    width: 720,
    height: 560,
    pixelCm: 5,
    map: "/resources/maps/1st_floor.png",
    occupancy: "/resources/maps/1st_floor.occupancy.bin",
    inflated: "/resources/maps/1st_floor.occupancy_inflated.bin",
    editable: false,
  },
};

const initialMapId = new URLSearchParams(location.search).get("map");
let browserPortOffset = Number(new URLSearchParams(location.search).get("portOffset") ?? 0) || 0;
let browserPortsApplied = false;
let activeMap: MapSpec = MAP_CATALOG[initialMapId as MapSpec["id"]] ?? MAP_CATALOG[RuntimeMapIds.code.yard];
function applyBrowserPortOffset(offset: number): void {
  if (!Number.isFinite(offset) || browserPortsApplied) return;
  browserPortOffset = offset;
  for (const spec of Object.values(MAP_CATALOG)) if (spec.serverPort) spec.serverPort += offset;
  browserPortsApplied = true;
}
applyBrowserPortOffset(browserPortOffset);
let mapLoading = false;

let connectionGeneration = 0;
const ASSETS = {
  waypoint: "/resources/images/waypoint/waypoint.png",
  charger: "/resources/images/charing-station/charging_station.png",
  robots: {
    "robot-1": `/resources/images/robots/${ROBOT_SPRITES["robot-1"]}`,
    "robot-2": `/resources/images/robots/${ROBOT_SPRITES["robot-2"]}`,
  },
} as const;

const zoneTool = (family: ResourceFamily, zoneKind: ZoneKind) => ({ family, zoneKind });
const ZONE_TOOLS: Partial<Record<ZoneKind, { family: ResourceFamily; zoneKind: ZoneKind }>> = {
  [ZoneKinds.code.forbidden]: zoneTool(ResourceFamilies.code.scene, ZoneKinds.code.forbidden),
  [ZoneKinds.code.prefer]: zoneTool(ResourceFamilies.code.scene, ZoneKinds.code.prefer),
  [ZoneKinds.code.avoid]: zoneTool(ResourceFamilies.code.scene, ZoneKinds.code.avoid),
  [ZoneKinds.code.corridor]: zoneTool(ResourceFamilies.code.scene, ZoneKinds.code.corridor),
  [ZoneKinds.code.complex]: zoneTool(ResourceFamilies.code.scene, ZoneKinds.code.complex),
  [ZoneKinds.code.blocked]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.blocked),
  [ZoneKinds.code.release]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.release),
  [ZoneKinds.code.line_guided]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.line_guided),
  [ZoneKinds.code.speed_limit]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.speed_limit),
  [ZoneKinds.code.priority]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.priority),
  [ZoneKinds.code.penalty]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.penalty),
  [ZoneKinds.code.directed]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.directed),
  [ZoneKinds.code.bidirected]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.bidirected),
  [ZoneKinds.code.replanning]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.replanning),
  [ZoneKinds.code.action_zone]: zoneTool(ResourceFamilies.code.vda, ZoneKinds.code.action_zone),
};

const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
const ctx = canvas.getContext("2d")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;

let room: Room | null = null;
let transportConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1500;
type ViewSource = ViewSourceCode;
let viewSource: ViewSource = ViewSources.code.live;
const liveChannel = new LiveEventChannel();
const blackboxChannel = new BlackboxEventChannel();
let liveViewGeneration = 0;
let replayAssetKey = "";
let replayAssetLoadingKey = "";
let replayAssetLoadingGeneration = -1;
let replaySceneReady = false;
let replayAssetGeneration = 0;
let liveActionGeneration = 0;

function emptySnapshot(mapId: string): Snapshot {
  return { mapId, waypoints: [], chargers: [], robots: [], obstacles: [], zones: [], nodes: [], edges: [], stations: [], portals: [], rails: [], teleporters: [], runtimeOccupancies: [] };
}

function isReplayView(): boolean { return viewSource === ViewSources.code.blackbox; }
function canWriteToLive(): boolean { return viewSource === ViewSources.code.live; }

function invalidateLiveActions(): void {
  liveActionGeneration += 1;
  for (const timer of runtimeTimers.values()) clearTimeout(timer);
  runtimeTimers.clear();
  runtimePending.clear();
  runtimeRequests.clear();
  poseOverrideRequests.clear();
  poseOverride = null;
  resetRobotEvents();
}

function applyCurrentSource(): void {
  const s = snap();
  renderRobots(s); renderOutliner(s); fillInspector(s); draw();
}

function scheduleReconnect(): void {
  if (reconnectTimer || transportConnected || room || !activeMap.serverPort || mapLoading) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(10000, Math.round(reconnectDelayMs * 1.7));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch(() => {
      scheduleReconnect();
    });
  }, delay);
}
let mode: Mode = AppModes.code.operate;
let tool: Tool = ToolKinds.code.select;
let cam: Camera = { x: 0, y: 0, scale: 1 };
let spaceDown = false;
let panning: { sx: number; sy: number; cam: Camera } | null = null;
let selected: { kind: string; id: string } | null = null;
let selectedRobot = "";
let poseOverride: (PoseCandidate & { status: EditSessionStatus; requestId?: string; error?: string }) | null = null;
const poseOverrideRequests = new Set<string>();
let obstacleShape: ObstacleKind = "square";
let occLayer: OccupancyLayer = OccupancyLayers.code.off;
let occGrid: Uint8Array | null = null;
let inflatedGrid: Uint8Array | null = null;
let occOverlay: HTMLCanvasElement | null = null;
let draftPoly: Point[] = [];
let draftCursor: Point | null = null;
let draftLine: Point[] = [];
let edgeStart: string | null = null;
/** 운용 Move 명령 초안만. 배치/수정은 editSession. */
let poseDraft: { x: number; y: number; theta: number } | null = null;
let editSession: EditSession | null = null;
let resourceDraft: { mode: EditMode; data: Record<string, any> } | null = null;
let teleporterStep: TeleporterEndpointStep | null = null;
let teleporterPointMode: { endpointId: string } | null = null;
let teleporterPolyDrag: { endpoint: any; index: number } | null = null;
let teleporterEndpointDrag: { endpoint: any; dx: number; dy: number } | null = null;
let savePending = false;
let deleteConfirmationPending = false;
let blueprint: HTMLCanvasElement | null = null;
let blueprintEnabled = true;
let lastOverviewFrame = 0;
let inspectorKey = "";
function newResourceId(kind: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  return `${kind}-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
function resourceOf(s: Snapshot, kind: string, id: string): Record<string, any> | undefined {
  const collections: Record<string, readonly any[]> = { waypoint: s.waypoints, charger: s.chargers, obstacle: s.obstacles, zone: s.zones, node: s.nodes, edge: s.edges, station: s.stations, portal: s.portals, rail: s.rails, teleporter: s.teleporters, robot: s.robots };
  return collections[kind]?.find(r => r.id === id);
}
function showProperties(): void {
  document.querySelector('.shell')?.classList.remove('hide-details', 'focus-mode');
  $('focus-workspace')?.setAttribute('aria-pressed', 'false');
  $('toggle-details')?.setAttribute('aria-pressed', 'true');
  document.querySelector<HTMLButtonElement>('button[data-detail="properties"]')?.click();
}
function beginResourceCreate(data: Record<string, any>): void {
  resourceDraft = { mode: EditModes.code.create, data: { ...data, id: newResourceId(data.kind), name: data.kind, theta: data.theta ?? 0 } };
  selected = null;
  syncEditChrome(); showProperties(); fillInspector(snap()); draw();
}
function defaultTeleporterPolygon(_x: number, _y: number): Point[] { return [{x:-20,y:-20},{x:20,y:-20},{x:20,y:20},{x:-20,y:20}]; }
function beginTeleporterCreate(x: number, y: number): void {
  const target = Object.values(MAP_CATALOG).find(m => m.id !== activeMap.id && m.editable);
  const endpoint = { id: newResourceId("teleporter-endpoint"), mapId: activeMap.id, position: { x, y }, entryTheta: 0, exitTheta: 0, occupancyPolygon: defaultTeleporterPolygon(x, y), clearingPoint: { x: x + 40, y } };
  resourceDraft = { mode: EditModes.code.create, data: { kind: "teleporter", id: newResourceId("teleporter"), name: "teleporter", endpoints: [endpoint], enabled: true, revision: 0, targetMapId: target?.id ?? "" } };
  teleporterStep = TeleporterEndpointSteps.code.A;
  selected = null; syncEditChrome(); showProperties(); fillInspector(snap()); draw();
}
function teleporterEndpointDraft(ep: any): any {
  const position = ep.position ? { ...ep.position } : { x: Number(ep.x ?? 0), y: Number(ep.y ?? 0) };
  return { ...ep, mapId: ep.mapId ?? ep.map_id ?? "", position, entryTheta: Number(ep.entryTheta ?? ep.entry_theta ?? 0), exitTheta: Number(ep.exitTheta ?? ep.exit_theta ?? 0), occupancyPolygon: ep.occupancyPolygon ?? ep.occupancy_polygon ?? [], clearingPoint: ep.clearingPoint ?? { x: position.x + 40, y: position.y } };
}
function teleporterPolygonContains(poly: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x-a.x)*(point.y-a.y)/(b.y-a.y) + a.x) inside = !inside;
  }
  return inside;
}
let editDrag: EditHandle | null = null;
let editGrab: { dx: number; dy: number } | null = null;
let dragging: { kind: string; id: string; dx: number; dy: number } | null = null;
let zoneDrag:
  | { type: "vertex"; id: string; index: number; poly: Point[] }
  | { type: "label"; id: string; origin: Point[]; sx: number; sy: number }
  | null = null;
let zonePreview: { id: string; polygon: Point[] } | null = null;
let selectedVertex: number | null = null;
let lastError = "";
let lastAck = "";
let flashUntil = 0;

const images = {
  map: new Image() as CanvasImageSource,
  waypoint: new Image(),
  charger: new Image(),
  robots: {} as Record<string, HTMLImageElement>,
};
let replayMapBitmap: ImageBitmap | null = null;

function replaceReplayMapImage(next: CanvasImageSource): void {
  if (replayMapBitmap && replayMapBitmap !== next) replayMapBitmap.close();
  replayMapBitmap = typeof ImageBitmap !== "undefined" && next instanceof ImageBitmap ? next : null;
  images.map = next;
}

async function loadHistoricalMapImage(url: string, width: number, height: number): Promise<CanvasImageSource> {
  if (typeof createImageBitmap !== "function") return loadImage(url);
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const maxSide = 4096;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const options: ImageBitmapOptions = {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: "high",
  };
  return createImageBitmap(blob, options);
}

const layers = { zones: true, graph: true, corridor: true, scene: true, robots: true };

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}
function send(type: string, payload: Record<string, unknown>): boolean {
  if (!canWriteToLive()) {
    status("블랙박스 리플레이에서는 운용·편집 명령을 보낼 수 없습니다.");
    return false;
  }
  if (!mapLoading && activeMap.editable && transportConnected && room) {
    const requestPayload = payload.requestId || payload.clientRequestId
      ? payload
      : { ...payload, clientRequestId: runtimeRequestId("command") };
    room.send(type, requestPayload);
    return true;
  }
  return false;
}
function snap(): Snapshot {
  if (viewSource === ViewSources.code.blackbox) return replaySceneReady ? blackboxChannel.snapshot ?? emptySnapshot(activeMap.id) : emptySnapshot(activeMap.id);
  if (viewSource === ViewSources.code["live-resync"]) return emptySnapshot(activeMap.id);
  const runtime = liveChannel.snapshot
    ? projectTransport(liveChannel.snapshot, transportConnected)
    : projectTransport(snapshotFromState(room?.state as Record<string, unknown> | undefined), transportConnected);
  // The browser's active room/map is the authoritative visual context. The
  // server schema's default MAP_ID is evaluated when its module loads, so a
  // second FMS process can still expose "yard" here. Using that stale value
  // made Large Lab render and hit-test the Yard endpoint instead of its own.
  if (activeMap.editable) return { ...runtime, mapId: activeMap.id };
  // Preview maps never display resources from a runtime server.
  return {
    ...runtime,
    robots: [],
    waypoints: [],
    chargers: [],
    obstacles: [],
    zones: [],
    nodes: [],
    edges: [],
    stations: [],
    portals: [],
    rails: [],
  };
}

function historicalMapSpec(assets: HistoricalAssets, mapId: string): MapSpec {
  const catalog = MAP_CATALOG[mapId as MapSpec["id"]] ?? activeMap;
  return {
    ...catalog,
    id: mapId as MapSpec["id"],
    version: assets.mapRevision ? `rev ${assets.mapRevision}` : catalog.version,
    width: Number(assets.width),
    height: Number(assets.height),
    pixelCm: Number(assets.pixelCm),
    map: assets.mapUrl,
    occupancy: assets.occupancyUrl ?? "",
    inflated: assets.inflatedUrl ?? "",
  };
}

function assertCopiedHistoricalAssets(assets: HistoricalAssets): void {
  const urls = [assets.mapUrl, assets.occupancyUrl, assets.inflatedUrl].filter((url): url is string => Boolean(url));
  if (!assets.mapUrl || urls.some(url => !url.startsWith("/api/blackbox/assets/"))) {
    throw new Error("복사된 블랙박스 자산 URL만 사용할 수 있습니다.");
  }
}

async function applyHistoricalAssets(assets: HistoricalAssets, generation: number): Promise<void> {
  const key = JSON.stringify(assets);
  if (key === replayAssetKey && replaySceneReady) return;
  if (key === replayAssetLoadingKey && generation === replayAssetLoadingGeneration) return;
  replaySceneReady = false;
  replaceReplayMapImage(new Image());
  blueprint = null; occGrid = null; inflatedGrid = null; occOverlay = null;
  replayAssetLoadingKey = key;
  replayAssetLoadingGeneration = generation;
  const assetGeneration = ++replayAssetGeneration;
  try {
    assertCopiedHistoricalAssets(assets);
    if (!Number.isFinite(assets.width) || assets.width <= 0 || !Number.isFinite(assets.height) || assets.height <= 0) {
      throw new Error("블랙박스 맵 자산 크기가 올바르지 않습니다.");
    }
    const nextMap = historicalMapSpec(assets, blackboxChannel.snapshot?.mapId ?? activeMap.id);
    // The historical PNG is the first usable replay surface. Large Lab grids
    // are two 100 MB downloads and are unnecessary for read-only playback.
    const mapImage = await loadHistoricalMapImage(assets.mapUrl, nextMap.width, nextMap.height);
    if (viewSource !== ViewSources.code.blackbox || generation !== blackboxChannel.generation || assetGeneration !== replayAssetGeneration) {
      if (typeof ImageBitmap !== "undefined" && mapImage instanceof ImageBitmap) mapImage.close();
      return;
    }
    activeMap = nextMap;
    replaceReplayMapImage(mapImage);
    occGrid = null;
    inflatedGrid = null;
    blueprint = null;
    occOverlay = null;
    replayAssetKey = key;
    replayAssetLoadingKey = "";
    replayAssetLoadingGeneration = -1;
    replaySceneReady = true;
    updateMapChrome();
    fit();
    applyCurrentSource();
    updateBlackboxUi({ source: ViewSources.code.blackbox, generation: blackboxChannel.generation, status: blackboxChannel.playing ? ReplayStatuses.code.playing : ReplayStatuses.code.paused });
  } catch (error) {
    // A slower, superseded raster request can fail after a newer map asset has
    // already loaded for this replay generation. Ignore that obsolete failure
    // just as we ignore an obsolete successful response above.
    if (viewSource === ViewSources.code.blackbox && generation === blackboxChannel.generation && assetGeneration === replayAssetGeneration) {
      replayAssetLoadingKey = "";
      replayAssetLoadingGeneration = -1;
      blackboxChannel.fail(`블랙박스 맵 자산을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function handleLiveUpdate(update: BlackboxUpdate): void {
  if (viewSource !== ViewSources.code.live || update.source !== ViewSources.code.live || update.generation !== liveChannel.generation) return;
  applyCurrentSource();
}

function handleBlackboxUpdate(update: BlackboxUpdate): void {
  if (viewSource !== ViewSources.code.blackbox || update.source !== ViewSources.code.blackbox || update.generation !== blackboxChannel.generation) return;
  if (update.assets) void applyHistoricalAssets(update.assets, update.generation);
  if (update.error) status(`블랙박스 오류: ${update.error}`);
  if (blackboxChannel.gaps.length) status(`블랙박스 기록 공백 ${blackboxChannel.gaps.length}건 · 해당 구간은 불완전합니다.`);
  if (update.event) renderBlackboxEvent(update.event);
  updateBlackboxUi(update);
  if (update.snapshot && !replaySceneReady) return;
  applyCurrentSource();
}

liveChannel.subscribe(handleLiveUpdate);
blackboxChannel.subscribe(handleBlackboxUpdate);
function status(msg: string): void {
  $("status-msg").textContent = msg;
}
function setConn(state: string, label: string): void {
  $("conn").dataset.state = state;
  $("conn-label").textContent = label;
}

let blackboxAsOf = 0;
let blackboxGenerationPollTimer: ReturnType<typeof setInterval> | null = null;
let blackboxServerGeneration = "";
let blackboxClearPending = false;

function stopBlackboxGenerationPolling(): void {
  if (blackboxGenerationPollTimer) clearInterval(blackboxGenerationPollTimer);
  blackboxGenerationPollTimer = null;
}

async function pollBlackboxGeneration(): Promise<void> {
  if (!isReplayView()) return;
  try {
    const generation = await blackboxChannel.loadGeneration();
    if (!generation || !blackboxServerGeneration) { blackboxServerGeneration = generation; return; }
    if (generation === blackboxServerGeneration) return;
    blackboxServerGeneration = generation;
    blackboxChannel.invalidate();
    replayAssetKey = ""; replayAssetLoadingKey = ""; replayAssetLoadingGeneration = -1; replaySceneReady = false;
    updateBlackboxUi({ source: ViewSources.code.blackbox, generation: blackboxChannel.generation, status: ReplayStatuses.code.loading });
    status("블랙박스 기록이 초기화되었습니다. 새 기록을 기다리는 중입니다.");
    applyCurrentSource();
  } catch { /* generation polling is advisory; replay remains read-only */ }
}

function startBlackboxGenerationPolling(): void {
  stopBlackboxGenerationPolling();
  blackboxGenerationPollTimer = setInterval(() => void pollBlackboxGeneration(), 5000);
}

async function clearBlackboxRecords(): Promise<void> {
  if (isReplayView() || blackboxClearPending) return;
  if (!(await runtimeConfirm("모든 맵·로봇의 블랙박스 이벤트, checkpoint, trace 자산을 영구 삭제합니다. 운용 상태·로봇 위치·점유·명령은 변경하지 않습니다."))) return;
  blackboxClearPending = true;
  const button = document.getElementById("blackbox-clear") as HTMLButtonElement | null;
  const note = document.getElementById("blackbox-clear-status");
  if (button) { button.disabled = true; button.textContent = "기록 삭제 중…"; }
  if (note) note.textContent = "서버에서 전체 기록 세대를 초기화하는 중…";
  try {
    const result = await blackboxChannel.clearAll();
    blackboxServerGeneration = result.generation ?? await blackboxChannel.loadGeneration().catch(() => blackboxServerGeneration);
    resetRobotEvents();
    const cleanupMessage = result.errors?.map(error => String(error)).join(" · ") || "이전 보관 자료 정리 결과를 확인하세요.";
    if (note) note.textContent = result.partial ? `기록 세대는 초기화했지만 물리 정리가 완료되지 않았습니다. ${cleanupMessage}` : "전체 블랙박스 기록을 삭제했습니다. 새 기록을 기다리는 중입니다.";
    status(result.partial ? `블랙박스 기록 부분 정리 · ${cleanupMessage}` : "블랙박스 전체 기록 삭제 완료");
  } catch (error) {
    if (note) note.textContent = `삭제 실패 · ${error instanceof Error ? error.message : String(error)}`;
    status(`블랙박스 기록 삭제 실패: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    blackboxClearPending = false;
    if (button) { button.disabled = isReplayView(); button.textContent = "전체 블랙박스 기록 삭제"; }
  }
}

function blackboxEventLabel(event: BlackboxEvent): string {
  return formatEventLabel(event, Number(event.timeMs));
}

function traceCompleteness(response: { gap?: boolean; truncated?: boolean; reason?: string; missingEvents?: number }): string {
  const details: string[] = [];
  if (response.gap) details.push("기록 공백");
  if (response.truncated) details.push(response.reason === "event_limit" ? "이벤트 상한으로 일부 잘림" : "조회 상한으로 일부 잘림");
  if (response.missingEvents) details.push(`누락 ${response.missingEvents}건`);
  return details.length ? ` · ${details.join(" · ")}` : "";
}

function renderBlackboxEvent(event: BlackboxEvent): void {
  const detail = document.getElementById("blackbox-event-detail");
  if (!detail) return;
  detail.replaceChildren();
  const text = document.createElement("span");
  text.textContent = blackboxEventLabel(event);
  detail.append(text);
  const jsonView = document.createElement("details");
  const jsonSummary = document.createElement("summary");
  jsonSummary.textContent = "JSON 원문 보기";
  const jsonBody = document.createElement("pre");
  jsonBody.className = "robot-events-detail";
  jsonBody.textContent = JSON.stringify(event, null, 2);
  jsonView.append(jsonSummary, jsonBody);
  if (event.operationId) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "운용 프로토콜·상태 기록";
    const traceBody = document.createElement("div");
    traceBody.className = "robot-events-related";
    details.append(summary, traceBody);
    const trace = document.createElement("button");
    trace.type = "button";
    let traceCursor: string | undefined;
    let traceCount = 0;
    let traceLoaded = false;
    const traceEvents: BlackboxEvent[] = [];
    trace.textContent = " 관련 기록";
    trace.title = "관련 운용 기록 조회";
    trace.addEventListener("click", async () => {
      trace.disabled = true;
      try {
        const response = await blackboxChannel.loadOperationTrace(event.operationId!, traceCursor, { mapId: event.mapId });
        traceLoaded = true;
        traceCursor = response.nextCursor;
        traceCount += response.events.length;
        const completeness = traceCompleteness(response);
        for (const item of response.events) {
          const row = document.createElement("p");
          row.textContent = blackboxEventLabel(item);
          traceBody.append(row);
        }
        traceEvents.push(...response.events);
        jsonBody.textContent = JSON.stringify({ event, trace: traceEvents, nextCursor: response.nextCursor, traceStatus: { gap: response.gap === true, truncated: response.truncated === true, reason: response.reason, missingEvents: response.missingEvents } }, null, 2);
        details.open = true;
        text.textContent = `${blackboxEventLabel(event)} · 관련 기록 ${traceCount}건${traceCursor ? " · 계속 있음" : ""}${completeness}`;
        trace.textContent = traceCursor ? " 관련 기록 더 보기" : " 조회 완료";
        trace.disabled = !traceCursor;
      } catch (error) {
        text.textContent = `${blackboxEventLabel(event)} · 관련 기록 오류: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        trace.disabled = traceLoaded && !traceCursor;
      }
    });
    detail.append(trace);
    detail.append(details);
  }
  detail.append(jsonView);
}

function updateBlackboxCandidates(): void {
  const events = blackboxChannel.candidates;
  const start = document.getElementById("blackbox-start-event") as HTMLSelectElement | null;
  const end = document.getElementById("blackbox-end-event") as HTMLSelectElement | null;
  const startRange = document.getElementById("blackbox-start-range") as HTMLInputElement | null;
  const endRange = document.getElementById("blackbox-end-range") as HTMLInputElement | null;
  const markers = document.getElementById("blackbox-markers");
  const more = document.getElementById("blackbox-more") as HTMLButtonElement | null;
  if (!start || !end || !startRange || !endRange || !markers) return;
  if (more) more.disabled = !blackboxChannel.hasMoreCandidates;
  const previousStart = start.value;
  const previousEnd = end.value;
  const options = events.map(event => `<option value="${runtimeEsc(event.eventId)}">${runtimeEsc(blackboxEventLabel(event))}</option>`).join("");
  start.innerHTML = options || '<option value="">이벤트 없음</option>';
  end.innerHTML = options || '<option value="">이벤트 없음</option>';
  const startIndex = previousStart ? Math.max(0, events.findIndex(event => event.eventId === previousStart)) : 0;
  const endIndex = previousEnd ? Math.max(startIndex, events.findIndex(event => event.eventId === previousEnd)) : events.length - 1;
  if (events.length) {
    start.value = events[startIndex]?.eventId ?? events[0].eventId;
    end.value = events[endIndex >= startIndex ? endIndex : events.length - 1]?.eventId ?? events.at(-1)!.eventId;
  }
  const firstTime = events[0]?.timeMs ?? 0;
  const lastTime = events.at(-1)?.timeMs ?? firstTime;
  for (const range of [startRange, endRange]) { range.min = String(firstTime); range.max = String(lastTime); range.step = "1"; }
  startRange.value = String(events.find(event => event.eventId === start.value)?.timeMs ?? firstTime);
  endRange.value = String(events.find(event => event.eventId === end.value)?.timeMs ?? lastTime);
  const timeSpan = Math.max(1, lastTime - firstTime);
  markers.innerHTML = events.map(event => {
    const left = (Number(event.timeMs ?? 0) - firstTime) / timeSpan * 100;
    return `<i class="blackbox-marker" style="left:${left}%" title="${runtimeEsc(blackboxEventLabel(event))}"></i>`;
  }).join("");
}

function selectedBlackboxBoundary(id: string): BlackboxEvent | undefined {
  return blackboxChannel.candidates.find(event => event.eventId === id);
}

function syncBlackboxRange(source: TimeRangeBound): void {
  const events = blackboxChannel.candidates;
  if (!events.length) return;
  const start = document.getElementById("blackbox-start-event") as HTMLSelectElement;
  const end = document.getElementById("blackbox-end-event") as HTMLSelectElement;
  const startRange = document.getElementById("blackbox-start-range") as HTMLInputElement;
  const endRange = document.getElementById("blackbox-end-range") as HTMLInputElement;
  const time = Number((source === "start" ? startRange : endRange).value);
  const nearest = events.reduce((best, event, index) => Math.abs(event.timeMs - time) < Math.abs(events[best].timeMs - time) ? index : best, 0);
  const startIndex = Math.max(0, events.findIndex(event => event.eventId === start.value));
  const endIndex = Math.max(startIndex, events.findIndex(event => event.eventId === end.value));
  if (source === "start") {
    const chosen = events[Math.min(nearest, endIndex)];
    start.value = chosen.eventId;
    startRange.value = String(chosen.timeMs);
  } else {
    const chosen = events[Math.max(nearest, startIndex)];
    end.value = chosen.eventId;
    endRange.value = String(chosen.timeMs);
  }
  const event = selectedBlackboxBoundary(source === "start" ? start.value : end.value);
  if (event) renderBlackboxEvent(event);
}

function localDateTimeValue(timeMs: number): string {
  const date = new Date(timeMs - dateTimezoneOffsetMs(timeMs));
  return date.toISOString().slice(0, 19);
}

function dateTimezoneOffsetMs(timeMs: number): number {
  const date = new Date(timeMs);
  return date.getTimezoneOffset() * 60_000;
}

function blackboxWindowTimes(): { fromMs: number; toMs: number } | null {
  const from = document.getElementById("blackbox-time-from") as HTMLInputElement | null;
  const to = document.getElementById("blackbox-time-to") as HTMLInputElement | null;
  if (!from?.value || !to?.value) return null;
  const fromMs = Date.parse(from.value), toMs = Date.parse(to.value);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return null;
  return { fromMs, toMs };
}

function mountBlackboxV2Ui(): void {
  const panel = document.getElementById("blackbox-panel");
  if (!panel || document.getElementById("blackbox-loading")) return;
  const viewport = document.getElementById("viewport");
  const loading = document.createElement("div"); loading.id = "blackbox-loading"; loading.className = "blackbox-loading"; loading.dataset.state = "loading"; loading.hidden = true;
  const loadingTitle = document.createElement("strong"); loadingTitle.id = "blackbox-loading-title"; loadingTitle.textContent = "기록 당시 지도를 준비하는 중";
  const loadingText = document.createElement("span"); loadingText.id = "blackbox-loading-text"; loadingText.textContent = "현재 운용 상태를 대신 표시하지 않습니다.";
  loading.append(loadingTitle, loadingText); viewport?.append(loading);
  const controls = document.createElement("div"); controls.id = "blackbox-window-controls"; controls.className = "blackbox-window-controls";
  controls.innerHTML = '<label>시작 시각 <input id="blackbox-time-from" type="datetime-local" step="1" aria-label="블랙박스 시작 시각" /></label><label>끝 시각 <input id="blackbox-time-to" type="datetime-local" step="1" aria-label="블랙박스 끝 시각" /></label><button type="button" id="blackbox-window-load">시간 구간 조회</button>';
  panel.querySelector(".blackbox-controls")?.before(controls);
  const play = document.getElementById("blackbox-play");
  if (play && !document.getElementById("blackbox-pause")) {
    const pause = document.createElement("button");
    pause.type = "button"; pause.id = "blackbox-pause"; pause.textContent = "일시정지";
    pause.addEventListener("click", () => { if (isReplayView()) blackboxChannel.pause(); });
    play.insertAdjacentElement("afterend", pause);
  }
  document.getElementById("blackbox-window-load")?.addEventListener("click", () => {
    const times = blackboxWindowTimes();
    if (!times) { status("블랙박스 시작·끝 시각을 확인하세요."); return; }
    void loadBlackboxWindow(times.fromMs, times.toMs, true);
  });
}

function setBlackboxWindowInputs(fromMs: number, toMs: number): void {
  const from = document.getElementById("blackbox-time-from") as HTMLInputElement | null;
  const to = document.getElementById("blackbox-time-to") as HTMLInputElement | null;
  if (from) from.value = localDateTimeValue(fromMs);
  if (to) to.value = localDateTimeValue(toMs);
}

function updateBlackboxUi(update?: BlackboxUpdate): void {
  const panel = document.getElementById("blackbox-panel");
  const button = document.getElementById("blackbox-toggle");
  if (!panel || !button) return;
  panel.hidden = !isReplayView();
  button.setAttribute("aria-pressed", String(isReplayView()));
  document.body.dataset.source = viewSource;
  document.body.dataset.replayReady = String(replaySceneReady);
  const loading = document.getElementById("blackbox-loading");
  if (loading) {
    loading.hidden = !isReplayView() || (replaySceneReady && !blackboxChannel.error);
    loading.dataset.state = blackboxChannel.error ? ReplayStatuses.code.error : replaySceneReady ? ReplayStatuses.code.ready : ReplayStatuses.code.loading;
    const title = document.getElementById("blackbox-loading-title");
    const text = document.getElementById("blackbox-loading-text");
    if (title) title.textContent = blackboxChannel.error ? "블랙박스 리플레이를 표시할 수 없습니다" : replaySceneReady ? "" : "기록 당시 지도를 준비하는 중";
    if (text) text.textContent = blackboxChannel.error || (replaySceneReady ? "" : "현재 운용 상태를 대신 표시하지 않습니다.");
  }
  const canvasElement = document.getElementById("map");
  canvasElement?.setAttribute("data-replay-ready", String(replaySceneReady));
  canvasElement?.setAttribute("data-replay-time", String(blackboxChannel.clockMs || 0));
  canvasElement?.setAttribute("data-replay-map-asset", replayAssetKey ? "historical" : "pending");
  const clock = document.getElementById("blackbox-clock");
  if (clock && isReplayView() && blackboxChannel.clockMs) clock.textContent = new Date(blackboxChannel.clockMs).toLocaleString("ko-KR", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (update?.status === ReplayStatuses.code.error) panel.querySelector<HTMLElement>("#blackbox-title")!.textContent = `오류 · ${update.error ?? blackboxChannel.error}`;
  else if (update?.status) panel.querySelector<HTMLElement>("#blackbox-title")!.textContent = `블랙박스 · 기록 당시 상태 · ${update.status}`;
  const modeTitle = document.getElementById("mode-title");
  const modeDescription = document.getElementById("mode-description");
  const hudMode = document.getElementById("hud-mode");
  if (isReplayView()) {
    if (modeTitle) modeTitle.textContent = "블랙박스 리플레이";
    if (modeDescription) modeDescription.textContent = "기록 당시 지도·로봇 상태를 읽기 전용으로 재생합니다.";
    if (hudMode) hudMode.textContent = `블랙박스 · ${replaySceneReady ? "읽기 전용" : "기록 자산 로딩"}`;
  } else if (modeTitle?.textContent === "블랙박스 리플레이") {
    modeTitle.textContent = "운용";
    if (modeDescription) modeDescription.textContent = "로봇 상태를 확인하고 이동·도킹 명령을 실행해.";
    if (hudMode) hudMode.textContent = "운용 · robot control";
  }
  const play = document.getElementById("blackbox-play") as HTMLButtonElement | null;
  if (play) play.textContent = blackboxChannel.playing ? "일시정지" : "재생";
  const pause = document.getElementById("blackbox-pause") as HTMLButtonElement | null;
  if (pause) pause.disabled = !isReplayView() || !blackboxChannel.replay || Boolean(blackboxChannel.error) || !blackboxChannel.playing;
  for (const id of ["blackbox-start-event", "blackbox-end-event", "blackbox-more", "blackbox-load"]) {
    const element = document.getElementById(id);
    const container = element?.closest("label") ?? element;
    if (container) container.hidden = isReplayView();
  }
  const recordedLabel = document.querySelector(".robot-section .section-heading span");
  if (recordedLabel) recordedLabel.textContent = isReplayView() ? "RECORDED" : "LIVE";
  const seek = document.getElementById("blackbox-seek") as HTMLInputElement | null;
  if (seek) {
    const replay = blackboxChannel.replay;
    seek.disabled = !replay || Boolean(blackboxChannel.error);
    if (replay) {
      seek.min = String(blackboxChannel.replayStartMs); seek.max = String(blackboxChannel.replayEndMs);
      seek.value = String(blackboxChannel.clockMs); seek.step = "1";
    }
  }
}

async function enterBlackbox(): Promise<void> {
  if (isReplayView()) return;
  if (mapLoading) { status("맵 로딩이 끝난 뒤 블랙박스를 열어주세요."); return; }
  invalidateLiveActions();
  viewSource = ViewSources.code.blackbox;
  liveViewGeneration += 1;
  blackboxChannel.invalidate();
  const generation = blackboxChannel.generation;
  selectedRobot = "";
  selected = null;
  clearEditSession();
  draftPoly = []; draftLine = []; poseDraft = null; poseOverride = null;
  replayAssetKey = "";
  replayAssetLoadingKey = "";
  replayAssetLoadingGeneration = -1;
  replaySceneReady = false;
  replaceReplayMapImage(new Image());
  blueprint = null; occGrid = null; inflatedGrid = null; occOverlay = null;
  mountBlackboxV2Ui();
  const now = Date.now();
  setBlackboxWindowInputs(now - 30_000, now);
  updateBlackboxUi({ source: ViewSources.code.blackbox, generation: blackboxChannel.generation, status: ReplayStatuses.code.loading });
  updateBlackboxCandidates();
  applyCurrentSource();
  try {
    const catalogResult = await blackboxChannel.loadCatalog(activeMap.id, Date.now());
    const catalogTo = Number(catalogResult.availableTo ?? catalogResult.asOf ?? catalogResult.maps?.find(item => (item.mapId ?? item.id) === activeMap.id)?.latestTimeMs ?? Date.now());
    blackboxAsOf = Number.isFinite(catalogTo) && catalogTo > 0 ? catalogTo : Date.now();
    setBlackboxWindowInputs(Math.max(0, blackboxAsOf - 30_000), blackboxAsOf);
    const [generationResult, windowResult] = await Promise.allSettled([
      blackboxChannel.loadGeneration(),
      blackboxChannel.loadWindow(activeMap.id, undefined, blackboxAsOf, blackboxAsOf, true),
    ]);
    if (viewSource !== ViewSources.code.blackbox || generation !== blackboxChannel.generation) return;
    if (generationResult.status === "fulfilled") blackboxServerGeneration = generationResult.value;
    else if (catalogResult.status === "fulfilled") {
      const value = catalogResult.value.generation;
      blackboxServerGeneration = typeof value === "string" ? value : value?.id ?? blackboxChannel.serverGenerationId;
    }
    if (windowResult.status === "rejected") throw windowResult.reason;
    blackboxAsOf = windowResult.value.asOf;
    if (windowResult.value.replayAvailable) setBlackboxWindowInputs(blackboxChannel.replayStartMs, blackboxChannel.replayEndMs);
    updateBlackboxCandidates();
    if (windowResult.value.replayAvailable) {
      status("최근 30초 기록을 불러왔습니다. 재생을 준비합니다.");
      applyCurrentSource();
    } else if (windowResult.value.events.length) {
      status("최근 30초 기록은 있지만 checkpoint 자산이 없습니다.");
    } else {
      status("최근 30초에 남아 있는 블랙박스 기록이 없습니다.");
    }
  } catch (error) {
    if (viewSource !== ViewSources.code.blackbox || generation !== blackboxChannel.generation) return;
    blackboxChannel.fail(`블랙박스 이벤트 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
    status(`블랙박스 이벤트 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
  }
  startBlackboxGenerationPolling();
  applyCurrentSource();
}

async function exitBlackbox(): Promise<void> {
  if (!isReplayView()) return;
  stopBlackboxGenerationPolling();
  invalidateLiveActions();
  blackboxChannel.invalidate();
  blackboxChannel.pause();
  viewSource = ViewSources.code["live-resync"];
  const generation = ++liveViewGeneration;
  document.body.dataset.source = viewSource;
  updateBlackboxUi();
  const mapId = (activeMap.id in MAP_CATALOG ? activeMap.id : RuntimeMapIds.code.yard) as MapSpec["id"];
  applyCurrentSource();
  try {
    const nextMap = MAP_CATALOG[mapId];
    const [mapImage, occ, inflated] = await Promise.all([loadImage(nextMap.map), loadBin(nextMap.occupancy, nextMap), loadBin(nextMap.inflated, nextMap)]);
    if (viewSource !== ViewSources.code["live-resync"] || generation !== liveViewGeneration) {
      if (typeof ImageBitmap !== "undefined" && mapImage instanceof ImageBitmap) mapImage.close();
      return;
    }
    activeMap = nextMap;
    replaceReplayMapImage(mapImage); occGrid = occ; inflatedGrid = inflated; blueprint = createBlueprint(occ, activeMap.width, activeMap.height); occOverlay = null;
    liveChannel.invalidate();
    if (room?.state) liveChannel.publish({ ...projectTransport(snapshotFromState(room.state as Record<string, unknown>), transportConnected), mapId: activeMap.id });
    viewSource = ViewSources.code.live;
    updateMapChrome();
    updateBlackboxUi();
    status("라이브 상태를 다시 동기화했습니다.");
    applyCurrentSource();
  } catch (error) {
    if (viewSource !== ViewSources.code["live-resync"] || generation !== liveViewGeneration) return;
    status(`라이브 복귀 실패 · 제어가 잠겨 있습니다: ${error instanceof Error ? error.message : String(error)}`);
    applyCurrentSource();
  }
}

async function loadSelectedBlackboxReplay(): Promise<void> {
  if (!isReplayView()) return;
  const start = (document.getElementById("blackbox-start-event") as HTMLSelectElement).value;
  const end = (document.getElementById("blackbox-end-event") as HTMLSelectElement).value;
  const startEvent = selectedBlackboxBoundary(start);
  const endEvent = selectedBlackboxBoundary(end);
  if (!startEvent || !endEvent) { status("리플레이 시작·끝 이벤트를 모두 선택하세요."); return; }
  const startMs = Number(startEvent.timeMs ?? 0);
  const endMs = Number(endEvent.timeMs ?? 0);
  if (startMs > endMs || (startMs === endMs && Number(startEvent.sequence ?? 0) > Number(endEvent.sequence ?? 0))) { status("끝 이벤트는 시작 이벤트 이후여야 합니다."); return; }
  await blackboxChannel.loadReplay(activeMap.id, startEvent.eventId, endEvent.eventId, blackboxAsOf || Date.now());
  applyCurrentSource();
}

async function loadBlackboxWindow(fromMs: number, toMs: number, autoReplay = false): Promise<void> {
  if (!isReplayView()) return;
  const generation = blackboxChannel.generation;
  setBlackboxWindowInputs(fromMs, toMs);
  replaySceneReady = false;
  updateBlackboxUi({ source: ViewSources.code.blackbox, generation, status: ReplayStatuses.code.loading });
  try {
    const result = await blackboxChannel.loadWindow(activeMap.id, fromMs, toMs, toMs, true);
    if (viewSource !== ViewSources.code.blackbox || generation !== blackboxChannel.generation) return;
    blackboxAsOf = result.asOf;
    if (result.replayAvailable) setBlackboxWindowInputs(blackboxChannel.replayStartMs, blackboxChannel.replayEndMs);
    updateBlackboxCandidates();
    if (result.replayAvailable) {
      status(`${result.events.length}건의 기록을 불러왔습니다.${autoReplay ? " 재생을 준비합니다." : ""}`);
      applyCurrentSource();
      return;
    }
    if (!result.events.length) {
      status("선택한 시간 구간에 남아 있는 블랙박스 기록이 없습니다.");
      updateBlackboxUi({ source: ViewSources.code.blackbox, generation, status: ReplayStatuses.code.ready });
      return;
    }
    status(blackboxChannel.gaps.length
      ? "기록 구간은 조회했지만 공백 또는 잘린 응답 때문에 재생할 수 없습니다."
      : "기록 구간은 조회했지만 checkpoint 자산이 없어 재생할 수 없습니다.");
  } catch (error) {
    if (viewSource !== ViewSources.code.blackbox || generation !== blackboxChannel.generation) return;
    blackboxChannel.fail(`블랙박스 시간 구간 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
    status(`블랙박스 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trafficCopy(status: string): { label: string; detail: string } {
  return {
    label: (TrafficStatuses.labels[status as keyof typeof TrafficStatuses.labels] ?? status) || "알 수 없음",
    detail: TrafficStatusDetails.labels[status as keyof typeof TrafficStatusDetails.labels] ?? "교통 상태 확인 중",
  };
}

const COMMAND_STATE = CommandStates.labels;
const runtimePending = new Set<string>();
const runtimeRequests = new Map<string, string>();
const runtimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pauseSelection = new Set<string>();
const pauseResults = new Map<string, { ok: boolean; pending: boolean; reasonCode: string }>();
type RobotEventRecord = BlackboxEvent & { level?: string };
let robotEventsVisible = false;
let robotEventsGeneration = 0;
let robotEventsTimer: ReturnType<typeof setInterval> | null = null;
let robotEventsRequestTimer: ReturnType<typeof setTimeout> | null = null;
let robotEventsCursor = "";
let robotEventsAsOf = 0;
let robotEventsHistoryFromMs = 0;
let robotEventsHistoryToMs = 0;
let robotEventsFromMs = 0;
let robotEventsLoading = false;
let robotEventsFollow = true;
let robotEvents: RobotEventRecord[] = [];
let selectedRobotEventId = "";
let robotEventTrace: { eventId: string; response: Awaited<ReturnType<typeof blackboxChannel.loadOperationTrace>> } | undefined;
let robotEventsGap = false;
let robotEventsTruncated = false;
let robotEventsStatus = "대기 중";
let robotEventsQuery = new Map<string, { generation: number; history: boolean }>();
function runtimeTimeout(requestId: string, key: string, actionGeneration = liveActionGeneration): void {
  runtimeTimers.set(requestId, setTimeout(() => {
    runtimeTimers.delete(requestId); runtimeRequests.delete(requestId); runtimePending.delete(key);
    if (!canWriteToLive() || actionGeneration !== liveActionGeneration) return;
    if (key.startsWith('pose:')) { poseOverrideRequests.delete(requestId); if (poseOverride?.requestId === requestId) poseOverride = { ...poseOverride, status: EditSessionStatuses.code.draft, error: '서버 응답 시간 초과 · 확인 후 다시 보낼 수 있습니다.' }; }
    if (key.startsWith('pause:')) pauseResults.set(key.slice('pause:'.length), { ok: false, pending: false, reasonCode: 'timeout' });
    status('런타임 변경 응답 시간 초과'); renderRuntime(snap());
  }, 6000));
}
function runtimeRequestId(prefix: string): string {
  const uuid = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `${prefix}-${uuid}`;
}
function runtimeEsc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
}
function runtimeTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function runtimeElapsed(ms: number): string {
  if (!ms) return '—';
  const now = isReplayView() ? blackboxChannel.clockMs : Date.now();
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}
function runtimeConfirm(message: string): Promise<boolean> {
  const old = document.getElementById('runtime-dialog'); old?.remove();
  const dialog = document.createElement('dialog'); dialog.id = 'runtime-dialog'; dialog.className = 'confirm-dialog';
  dialog.innerHTML = `<div class="dialog-eyebrow">런타임 확인</div><h2>변경을 적용할까요?</h2><p class="dialog-note"></p><div class="dialog-actions"><button type="button" id="runtime-dialog-cancel" class="confirm-secondary">취소</button><button type="button" id="runtime-dialog-confirm" class="confirm-danger">확인</button></div>`;
  (dialog.querySelector('.dialog-note') as HTMLElement).textContent = message;
  document.body.append(dialog);
  return new Promise(resolve => {
    const settle = (value: boolean) => { if (dialog.open) dialog.close(); dialog.remove(); resolve(value); };
    dialog.querySelector('#runtime-dialog-cancel')!.addEventListener('click', () => settle(false));
    dialog.querySelector('#runtime-dialog-confirm')!.addEventListener('click', () => settle(true));
    dialog.addEventListener('cancel', e => { e.preventDefault(); settle(false); }, { once: true });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else settle(false);
  });
}
function runtimeLabel(value: string): string {
  const catalogs = [WorkStates, DriveStates, FmsControlStates, ConnectionStates, OccupancyStates, NavigationModes, PathPlanningAuthorities, CommandStates, TrafficStatuses, StationKinds, DirectedLimitations, ZoneReleaseLossBehaviors];
  const catalogLabel = catalogs.find(catalog => catalog.is(value));
  return (catalogLabel ? catalogLabel.labels[value as keyof typeof catalogLabel.labels] : REASON_CODES.is(value) ? REASON_CODES.labels[value] : value) || '—';
}
function isVirtualRobot(robot: Snapshot["robots"][number]): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS.robots, canonicalRobotId(robot.id));
}
function poseOverrideIssues(candidate: PoseCandidate): string[] {
  return poseConflicts(candidate, snap(), activeMap.width, activeMap.height, isFree);
}
function beginPoseOverride(robot: Snapshot["robots"][number]): void {
  if (!isVirtualRobot(robot) || !transportConnected || !robot.connected || (robot.fmsControlState === "enabled" && !robot.controlReady)) {
    status("연결된 가상 로봇만 테스트 위치를 지정할 수 있습니다. 운영 제외 중인 로봇도 지정할 수 있습니다.");
    return;
  }
  poseOverride = { robotId: robot.id, x: robot.x, y: robot.y, theta: robot.theta, status: EditSessionStatuses.code.draft };
  setTool("select");
  status("테스트 위치 지정 중 · 지도에서 새 위치를 클릭하세요.");
  renderRuntime(snap()); draw();
}
function clearPoseOverride(message?: string): void {
  poseOverride = null;
  if (message) status(message);
  renderRuntime(snap()); draw();
}

function selectedPauseRobots(s: Snapshot): Snapshot["robots"] {
  const chosen = s.robots.filter(robot => pauseSelection.has(robot.id));
  if (chosen.length) return chosen;
  const selected = s.robots.find(robot => robot.id === selectedRobot);
  return selected ? [selected] : [];
}

function renderMotionPauseControls(s: Snapshot): void {
  const list = document.getElementById('robot-pause-selection');
  const pauseButton = document.getElementById('robot-motion-pause') as HTMLButtonElement | null;
  const resumeButton = document.getElementById('robot-motion-resume') as HTMLButtonElement | null;
  const result = document.getElementById('robot-motion-result');
  if (!list || !pauseButton || !resumeButton || !result) return;
  const existing = new Map(Array.from(list.querySelectorAll<HTMLInputElement>('input[data-robot-id]'), input => [input.dataset.robotId!, input]));
  for (const input of existing.values()) if (!s.robots.some(robot => robot.id === input.dataset.robotId)) input.closest('.robot-pause-row')?.remove();
  for (const robot of s.robots) {
    let input = existing.get(robot.id);
    let row = input?.closest<HTMLElement>('.robot-pause-row') ?? null;
    if (!row) {
      row = document.createElement('label'); row.className = 'robot-pause-row';
      input = document.createElement('input'); input.type = 'checkbox'; input.dataset.robotId = robot.id;
      input.addEventListener('change', () => { if (input!.checked) pauseSelection.add(robot.id); else pauseSelection.delete(robot.id); renderMotionPauseControls(snap()); });
      const name = document.createElement('span'); name.className = 'robot-pause-name';
      const state = document.createElement('small'); state.className = 'robot-pause-state';
      row.append(input, name, state); list.append(row);
    }
    input.checked = pauseSelection.has(robot.id);
    row.dataset.paused = String(robot.operatorPaused);
    const name = row.querySelector('.robot-pause-name');
    const state = row.querySelector('.robot-pause-state');
    if (name) name.textContent = robot.id;
    if (state) state.textContent = robot.operatorPausePending ? '처리 중…' : robot.operatorPaused ? '일시정지' : robot.operatorPauseReason || runtimeLabel(robot.driveState);
  }
  const targets = selectedPauseRobots(s);
  const pendingTarget = targets.some(robot => runtimePending.has(`pause:${robot.id}`));
  const eligible = targets.filter(robot => canDispatchRobot(robot));
  const blocked = !eligible.length || pendingTarget || !transportConnected || !canWriteToLive();
  pauseButton.disabled = blocked || !eligible.some(robot => !robot.operatorPaused);
  resumeButton.disabled = blocked || !eligible.some(robot => robot.operatorPaused);
  const replies = targets.map(robot => pauseResults.get(robot.id)).filter(Boolean) as { ok: boolean; pending: boolean; reasonCode: string }[];
  const complete = replies.length === targets.length && replies.every(reply => !reply.pending);
  if (replies.length && replies.some(reply => !reply.ok && !reply.pending)) {
    result.textContent = `부분 실패 · ${replies.find(reply => !reply.ok && !reply.pending)?.reasonCode || '적용되지 않음'}`;
  } else if (targets.some(robot => robot.operatorPausePending) || replies.some(reply => reply.pending)) {
    result.textContent = '로봇 적용 ACK 대기 중…';
  } else if (complete && targets.length && targets.every(robot => robot.operatorPaused)) {
    result.textContent = `${targets.length}개 로봇 일시정지 적용됨`;
  } else if (complete && targets.length && targets.every(robot => !robot.operatorPaused)) {
    result.textContent = `${targets.length}개 로봇 재개됨`;
  }
}

function syncRobotEventRobotFilter(s: Snapshot): void {
  const select = document.getElementById('robot-events-robot') as HTMLSelectElement | null;
  if (!select) return;
  const selected = select.value || selectedRobot;
  const ids = s.robots.map(robot => robot.id);
  const known = new Set(Array.from(select.options, option => option.value));
  for (const id of ids) {
    if (known.has(id)) continue;
    const option = document.createElement('option'); option.value = id; option.textContent = id; select.append(option);
  }
  for (const option of Array.from(select.options).slice(1)) if (!ids.includes(option.value)) option.remove();
  if (ids.includes(selected)) select.value = selected;
  else if (selectedRobot && ids.includes(selectedRobot)) select.value = selectedRobot;
  else select.value = '';
}

function requestMotionPause(paused: boolean): void {
  if (!canWriteToLive() || !transportConnected) return;
  const targets = selectedPauseRobots(snap());
  if (!targets.length) return;
  for (const robot of targets) {
    const requestId = runtimeRequestId(paused ? 'pause' : 'resume');
    const key = `pause:${robot.id}`;
    if (!canDispatchRobot(robot)) {
      pauseResults.set(robot.id, { ok: false, pending: false, reasonCode: robot.connected ? 'control_unavailable' : 'offline' });
      continue;
    }
    if (runtimePending.has(key)) continue;
    runtimePending.add(key); runtimeRequests.set(requestId, key);
    pauseResults.set(robot.id, { ok: false, pending: true, reasonCode: 'awaiting_ack' });
    runtimeTimeout(requestId, key, liveActionGeneration);
    if (!send('robot_motion_pause', { robotId: robot.id, requestId, paused, expectedEpoch: robot.controlEpoch })) {
      const timer = runtimeTimers.get(requestId); if (timer) clearTimeout(timer);
      runtimeTimers.delete(requestId); runtimeRequests.delete(requestId); runtimePending.delete(key);
      pauseResults.set(robot.id, { ok: false, pending: false, reasonCode: 'send_failed' });
    }
  }
  renderMotionPauseControls(snap());
}

function handleMotionPauseResult(msg: { requestId?: string; robotId?: string; desired?: boolean; applied?: boolean; pending?: boolean; ok?: boolean; reasonCode?: string }): void {
  const requestId = msg.requestId ?? '';
  const robotId = msg.robotId ?? '';
  const key = runtimeRequests.get(requestId);
  if (!requestId || !robotId || !key || !key.startsWith('pause:')) return;
  const pending = msg.pending === true;
  if (!pending) {
    runtimePending.delete(key); runtimeRequests.delete(requestId);
    const timer = runtimeTimers.get(requestId); if (timer) clearTimeout(timer);
    runtimeTimers.delete(requestId);
  }
  pauseResults.set(robotId, { ok: msg.ok === true && msg.applied === true, pending, reasonCode: String(msg.reasonCode ?? (msg.ok ? 'applied' : 'rejected')) });
  const targets = selectedPauseRobots(snap());
  const finalResults = targets.map(robot => pauseResults.get(robot.id)).filter(reply => reply && !reply.pending) as { ok: boolean; reasonCode: string }[];
  if (!pending && finalResults.length === targets.length) {
    status(finalResults.every(reply => reply.ok) ? '주행 일시정지·재개 요청이 적용되었습니다.' : finalResults.every(reply => !reply.ok) ? '주행 일시정지·재개 요청이 적용되지 않았습니다.' : '일부 로봇에만 주행 일시정지·재개 요청이 적용되었습니다.');
  }
  renderMotionPauseControls(snap());
}

function eventLevel(event: RobotEventRecord): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  return String(event.level ?? payload.level ?? (event.category === 'error' ? 'error' : 'info'));
}

function eventLevelLabel(event: RobotEventRecord): string {
  const value = eventLevel(event);
  return EVENT_LEVELS.labels[value as keyof typeof EVENT_LEVELS.labels] ?? value;
}

function selectedRobotEvent(): RobotEventRecord | undefined { return robotEvents.find(event => event.eventId === selectedRobotEventId); }

function renderRobotEventDetail(): void {
  const detail = document.getElementById('robot-events-detail') as HTMLPreElement | null;
  const copy = document.getElementById('robot-events-copy') as HTMLButtonElement | null;
  const trace = document.getElementById('robot-events-trace') as HTMLButtonElement | null;
  const jsonView = document.getElementById('robot-events-json') as HTMLDetailsElement | null;
  const description = document.getElementById('robot-events-description');
  const related = document.getElementById('robot-events-related');
  const event = selectedRobotEvent();
  if (!detail || !copy || !trace || !jsonView || !description || !related) return;
  if (jsonView.dataset.eventId !== event?.eventId) jsonView.open = false;
  jsonView.dataset.eventId = event?.eventId ?? '';
  jsonView.hidden = !event;
  copy.disabled = !event; trace.disabled = !event?.operationId;
  description.hidden = !event;
  description.textContent = event ? blackboxEventLabel(event) : '';
  if (robotEventTrace?.eventId !== event?.eventId) robotEventTrace = undefined;
  const response = robotEventTrace?.response;
  related.hidden = !response;
  related.replaceChildren();
  if (response) {
    const heading = document.createElement('strong');
    heading.textContent = `관련 기록 ${response.events.length}건${response.nextCursor ? ' · 일부 기록 표시' : ''}${traceCompleteness(response)}`;
    related.append(heading);
    for (const item of response.events) {
      const row = document.createElement('p');
      row.textContent = blackboxEventLabel(item);
      related.append(row);
    }
  }
  detail.textContent = event ? JSON.stringify(response ? { event, trace: response.events, nextCursor: response.nextCursor, traceStatus: { gap: response.gap === true, truncated: response.truncated === true, reason: response.reason, missingEvents: response.missingEvents } } : event, null, 2) : '';
}

function renderRobotEvents(): void {
  const list = document.getElementById('robot-events-list');
  const statusEl = document.getElementById('robot-events-status');
  const more = document.getElementById('robot-events-more') as HTMLButtonElement | null;
  if (!list || !statusEl) return;
  const robotId = (document.getElementById('robot-events-robot') as HTMLSelectElement | null)?.value || selectedRobot;
  const level = (document.getElementById('robot-events-level') as HTMLSelectElement | null)?.value || '';
  const category = (document.getElementById('robot-events-category') as HTMLSelectElement | null)?.value || '';
  const filtered = robotEvents.filter(event => (!robotId || event.robotId === robotId) && (!level || eventLevel(event) === level) && (!category || event.category === category)).slice(-500);
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('span'); empty.className = 'runtime-empty'; empty.textContent = '표시할 이벤트가 없습니다.'; list.append(empty);
  } else for (const event of filtered) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'robot-event-row'; row.dataset.eventId = event.eventId; row.dataset.level = eventLevel(event); row.dataset.selected = String(event.eventId === selectedRobotEventId);
    const time = document.createElement('span'); time.className = 'robot-event-time'; time.textContent = formatEventTime(Number(event.timeMs));
    const copy = document.createElement('span'); copy.className = 'robot-event-copy';
    const title = document.createElement('b'); title.textContent = formatEventMessage(event);
    const categoryLabel = EVENT_CATEGORIES.labels[event.category as keyof typeof EVENT_CATEGORIES.labels] ?? event.category;
    const meta = document.createElement('small'); meta.textContent = [categoryLabel, eventLevelLabel(event)].filter(Boolean).join(' · ');
    copy.append(title, meta); row.append(time, copy); row.addEventListener('click', () => { selectedRobotEventId = event.eventId; renderRobotEvents(); renderRobotEventDetail(); }); list.append(row);
  }
  statusEl.textContent = `${robotEventsStatus}${robotEventsGap ? ' · 기록 공백' : ''}${robotEventsTruncated ? ' · 일부 잘림' : ''}`;
  if (more) more.disabled = !robotEventsCursor || robotEventsLoading || isReplayView();
  renderRobotEventDetail();
}

function stopRobotEventsPolling(): void { if (robotEventsTimer) clearInterval(robotEventsTimer); robotEventsTimer = null; }

function resetRobotEvents(): void {
  robotEventsGeneration += 1; stopRobotEventsPolling(); if (robotEventsRequestTimer) clearTimeout(robotEventsRequestTimer); robotEventsRequestTimer = null; robotEventsQuery.clear(); robotEventsLoading = false; robotEventsCursor = ''; robotEventsAsOf = 0; robotEventsHistoryFromMs = 0; robotEventsHistoryToMs = 0; robotEventsFromMs = 0; robotEvents = []; selectedRobotEventId = ''; robotEventsGap = false; robotEventsTruncated = false; robotEventsStatus = '대기 중';
  const panel = document.getElementById('robot-events-panel'); if (panel) panel.hidden = true; robotEventsVisible = false; renderRobotEvents();
}

function queryRobotEvents(history = false): void {
  if (!robotEventsVisible || isReplayView() || !room || !transportConnected || robotEventsLoading || (!robotEventsFollow && !history)) return;
  const robotId = (document.getElementById('robot-events-robot') as HTMLSelectElement | null)?.value || selectedRobot;
  if (!robotId) { robotEventsStatus = '로봇을 선택하세요'; renderRobotEvents(); return; }
  const requestId = runtimeRequestId('events'); const generation = robotEventsGeneration;
  robotEventsQuery.set(requestId, { generation, history }); robotEventsLoading = true; robotEventsStatus = '조회 중…'; renderRobotEvents();
  const level = (document.getElementById('robot-events-level') as HTMLSelectElement | null)?.value || '';
  const category = (document.getElementById('robot-events-category') as HTMLSelectElement | null)?.value || '';
  const now = Date.now();
  if (history && !robotEventsHistoryToMs) {
    robotEventsHistoryToMs = robotEventsAsOf || now;
    const range = Number((document.getElementById('robot-events-range') as HTMLSelectElement | null)?.value || 24 * 60 * 60 * 1000);
    robotEventsHistoryFromMs = robotEventsHistoryToMs - (Number.isFinite(range) && range > 0 ? range : 24 * 60 * 60 * 1000);
  }
  const fromMs = history ? robotEventsHistoryFromMs : Math.max(0, robotEventsFromMs - 1000, now - 60 * 1000);
  const payload: Record<string, unknown> = { requestId, robotId, fromMs, toMs: history ? robotEventsHistoryToMs : now, limit: 100, includePose: false };
  if (history) { payload.asOf = robotEventsAsOf || Date.now(); if (robotEventsCursor) payload.cursor = robotEventsCursor; }
  if (level) payload.levels = [level]; if (category) payload.categories = [category];
  if (robotEventsRequestTimer) clearTimeout(robotEventsRequestTimer);
  robotEventsRequestTimer = setTimeout(() => {
    if (robotEventsQuery.delete(requestId)) { robotEventsLoading = false; robotEventsRequestTimer = null; robotEventsStatus = '이벤트 조회 시간 초과'; renderRobotEvents(); }
  }, 6000);
  room.send('robot_events_query', payload);
}

function handleRobotEventsResult(msg: { requestId?: string; robotId?: string; ok?: boolean; events?: RobotEventRecord[]; nextCursor?: string; asOf?: number; gap?: boolean; truncated?: boolean; error?: unknown }): void {
  const requestId = String(msg.requestId ?? '');
  const query = robotEventsQuery.get(requestId);
  if (!query || query.generation !== robotEventsGeneration) return;
  robotEventsQuery.delete(requestId);
  if (robotEventsRequestTimer) clearTimeout(robotEventsRequestTimer);
  robotEventsRequestTimer = null;
  robotEventsLoading = false;
  if (msg.ok !== true) {
    robotEventsStatus = typeof msg.error === 'object' && msg.error && 'message' in msg.error ? String((msg.error as Record<string, unknown>).message) : '이벤트 조회 실패';
    robotEventsGap = true;
    renderRobotEvents();
    return;
  }
  const incoming = Array.isArray(msg.events) ? msg.events : [];
  const byId = new Map(robotEvents.map(event => [event.eventId, event]));
  for (const event of incoming) if (event?.eventId) byId.set(event.eventId, event);
  robotEvents = [...byId.values()].sort((a, b) => Number(a.timeMs) - Number(b.timeMs) || Number(a.sequence) - Number(b.sequence));
  if (query.history) {
    robotEventsCursor = String(msg.nextCursor ?? '');
    if (msg.asOf != null) robotEventsAsOf = Number(msg.asOf);
    robotEvents = robotEvents.slice(0, 500);
    robotEventsFromMs = Math.max(robotEventsFromMs, Date.now() - 60 * 1000);
    robotEventsStatus = '기록 연결됨';
  } else {
    robotEvents = robotEvents.slice(-500);
    robotEventsStatus = '실시간 연결됨';
    const newest = incoming.reduce((max, event) => Math.max(max, Number(event.timeMs) || 0), 0);
    robotEventsFromMs = newest ? Math.max(Date.now() - 60 * 1000, newest - 1000) : Date.now() - 60 * 1000;
  }
  robotEventsGap ||= msg.gap === true;
  robotEventsTruncated ||= msg.truncated === true;
  renderRobotEvents();
}

function openRobotEvents(): void {
  if (isReplayView()) { status('블랙박스 리플레이에서는 로봇 이벤트 콘솔을 열 수 없습니다.'); return; }
  const panel = document.getElementById('robot-events-panel'); if (!panel) return;
  robotEventsVisible = true; panel.hidden = false; robotEventsGeneration += 1; stopRobotEventsPolling(); robotEvents = []; robotEventsCursor = ''; robotEventsAsOf = Date.now(); robotEventsHistoryToMs = robotEventsAsOf;
  const range = Number((document.getElementById('robot-events-range') as HTMLSelectElement | null)?.value || 24 * 60 * 60 * 1000);
  robotEventsHistoryFromMs = robotEventsHistoryToMs - (Number.isFinite(range) && range > 0 ? range : 24 * 60 * 60 * 1000);
  robotEventsFromMs = Date.now() - 60 * 1000; robotEventsStatus = '연결 중…';
  syncRobotEventRobotFilter(snap());
  const robotSelect = document.getElementById('robot-events-robot') as HTMLSelectElement | null;
  if (robotSelect) robotSelect.value = selectedRobot;
  renderRobotEvents(); queryRobotEvents(true);
  robotEventsTimer = setInterval(() => queryRobotEvents(false), 1000);
}

function closeRobotEvents(): void { robotEventsVisible = false; resetRobotEvents(); }
function sendPoseOverride(): void {
  if (!canWriteToLive()) { status("블랙박스 리플레이에서는 테스트 위치를 지정할 수 없습니다."); return; }
  if (!poseOverride || poseOverride.status !== EditSessionStatuses.code.draft) return;
  const robot = snap().robots.find(item => item.id === poseOverride!.robotId);
  if (!robot || !transportConnected) { status("로봇 연결이 끊겨 테스트 위치를 보내지 않았습니다."); return; }
  const actionGeneration = liveActionGeneration;
  const issues = poseOverrideIssues(poseOverride);
  if (issues.length) { poseOverride.error = `충돌 예상: ${issues.join(", ")}`; renderRuntime(snap()); draw(); return; }
  const requestId = runtimeRequestId("pose");
  poseOverride = { ...poseOverride, status: EditSessionStatuses.code.pending, requestId, error: undefined };
  poseOverrideRequests.add(requestId);
  runtimeRequests.set(requestId, `pose:${robot.id}`);
  renderRuntime(snap()); draw();
  runtimeTimeout(requestId, `pose:${robot.id}`, actionGeneration);
  send("setVirtualRobotPose", { testOnly: true, robotId: robot.id, mapId: activeMap.id, x: poseOverride.x, y: poseOverride.y, theta: poseOverride.theta, requestId, expectedEpoch: robot.controlEpoch });
}
function renderRuntime(s: Snapshot): void {
  const blackboxClear = document.getElementById('blackbox-clear') as HTMLButtonElement | null;
  if (blackboxClear) blackboxClear.disabled = isReplayView() || blackboxClearPending;
  const focused = document.activeElement instanceof HTMLElement ? {
    action: focusedRuntimeAction(document.activeElement),
    robotId: (document.activeElement as HTMLElement).dataset.robotId,
    resourceId: (document.activeElement as HTMLElement).dataset.resourceId,
  } : null;
  const detail = $('runtime-robot-detail');
  const r = s.robots.find(robot => robot.id === selectedRobot);
  const records = s.runtimeOccupancies.filter(o => o.resourceRef.mapId === activeMap.id && o.resourceRef.kind === 'zone');
  const detailKey = r ? JSON.stringify([r.id,r.workState,r.fmsControlState,r.connectionState,r.connectionReason,r.driveState,r.driveContexts,r.controlEpoch,r.controlReady,r.sessionId,r.navigationMode,r.pathPlanningAuthority,r.operatorPaused,r.operatorPauseReason,transportConnected,[...runtimePending],poseOverride,s.zones.map(z=>[z.id,z.name])]) : 'empty';
  const occupancyKey = JSON.stringify([records, transportConnected, [...runtimePending], s.zones.map(z=>[z.id,z.name])]);
  syncRobotEventRobotFilter(s);
  renderMotionPauseControls(s);
  if (!canWriteToLive()) detail.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(element => { element.disabled = true; });
  if (detail.dataset.runtimeKey === detailKey && $('runtime-occupancies').dataset.runtimeKey === occupancyKey) {
    detail.querySelectorAll<HTMLElement>('[data-runtime-since]').forEach(el => el.textContent = runtimeElapsed(Number(el.dataset.runtimeSince)));
    const lastReport = detail.querySelector<HTMLElement>('[data-runtime-report]');
    if (lastReport && r) lastReport.textContent = runtimeTime(r.reportedAt || r.lastSeenAt);
    return;
  }
  if (!r) detail.innerHTML = '<span class="runtime-empty">로봇을 선택하면 런타임 상태와 제어를 표시합니다.</span>';
  else {
    const contexts = r.driveContexts.length ? r.driveContexts.map(c => `<li><b>${runtimeEsc(runtimeLabel(c.reasonCode))}</b> · <span data-runtime-since="${c.since}" data-runtime-elapsed>${runtimeElapsed(c.since)}</span>${c.target ? ` · ${runtimeEsc(resourceLabels[c.target.kind] ?? c.target.kind)} ${runtimeEsc(s.zones.find(z => z.id === c.target!.id)?.name ?? c.target.id)}` : ''}${c.blockingRobotIds?.length ? ` · 차단 ${c.blockingRobotIds.map(runtimeEsc).join(', ')}` : ''}</li>`).join('') : '<li>추가 원인 없음</li>';
    const disabled = r.fmsControlState === 'disabled';
    const action = disabled ? 'enable' : 'disable';
    detail.innerHTML = `<div class="runtime-robot-title"><span class="runtime-state-glyph ${disabled ? 'is-disabled' : r.connectionState}">${disabled ? '⊘' : r.connectionState === 'online' ? '●' : '○'}</span><div><b>${runtimeEsc(r.id)}</b><small>${runtimeLabel(r.fmsControlState)} · ${runtimeLabel(r.connectionState)}${r.connectionReason ? ` · ${runtimeEsc(runtimeLabel(r.connectionReason))}` : ''}</small></div></div>
      <div class="runtime-badges"><span>${runtimeLabel(r.workState)}</span><span>${runtimeLabel(r.driveState)}</span><span>${runtimeLabel(r.navigationMode)}</span>${r.operatorPaused ? '<span>운영자 일시정지</span>' : ''}</div>
      <dl class="runtime-facts"><dt>주행 방식</dt><dd>${runtimeLabel(r.pathPlanningAuthority)}</dd><dt>제어 준비</dt><dd>${r.controlReady ? '준비됨' : '사용 불가'}</dd><dt>대기 시간</dt><dd data-runtime-since="${r.driveContexts[0]?.since ?? 0}">${runtimeElapsed(r.driveContexts[0]?.since ?? 0)}</dd><dt>마지막 보고</dt><dd data-runtime-report>${runtimeTime(r.reportedAt || r.lastSeenAt)}</dd></dl>
      <div class="runtime-context"><b>원인·대상</b><ul>${contexts}</ul></div>
      <div class="runtime-actions"><button type="button" class="${disabled ? 'primary' : 'danger'}" data-runtime-action="${action}" data-robot-id="${runtimeEsc(r.id)}" ${runtimePending.has(`control:${r.id}`) || !transportConnected ? 'disabled' : ''}>${runtimePending.has(`control:${r.id}`) ? '처리 중…' : disabled ? '운영 재개' : '운영 제외'}</button>${isVirtualRobot(r) ? `<button type="button" class="secondary" data-runtime-action="pose" data-robot-id="${runtimeEsc(r.id)}" ${poseOverrideRequests.size || !r.connected || !transportConnected ? 'disabled' : ''}>테스트 위치 지정</button>` : ''}<small class="runtime-control-note">${disabled ? '재개 시 현재 위치·상태를 다시 동기화합니다.' : '논리 점유·예약·대기열과 작업을 해제합니다. 물리 본체와 위치·상태 보고는 유지됩니다.'}</small></div>${poseOverride?.robotId === r.id ? `<div class="pose-override-panel"><b>가상 로봇 테스트 위치</b><small>${poseOverride.status === EditSessionStatuses.code.pending ? '서버 ACK 대기 중…' : poseOverride.error ?? '지도에서 위치를 선택하고 방향을 조정하세요.'}</small><label class="field"><span>헤딩 · °</span><input id="pose-override-heading" type="range" min="-180" max="180" step="1" value="${poseOverride.theta * 180 / Math.PI}"></label><div class="pose-override-actions"><button type="button" class="primary" data-runtime-action="pose-confirm" ${poseOverride.status === EditSessionStatuses.code.pending || !!poseOverrideIssues(poseOverride).length ? 'disabled' : ''}>확인</button><button type="button" class="secondary" data-runtime-action="pose-cancel" ${poseOverride.status === EditSessionStatuses.code.pending ? 'disabled' : ''}>취소</button></div></div>` : ''}`;
    detail.querySelector<HTMLButtonElement>('[data-runtime-action="pose"]')?.addEventListener('click', () => beginPoseOverride(r));
    detail.querySelector<HTMLButtonElement>('[data-runtime-action="pose-confirm"]')?.addEventListener('click', sendPoseOverride);
    detail.querySelector<HTMLButtonElement>('[data-runtime-action="pose-cancel"]')?.addEventListener('click', () => clearPoseOverride('테스트 위치 지정 취소'));
    detail.querySelector<HTMLInputElement>('#pose-override-heading')?.addEventListener('input', event => {
      if (!poseOverride || poseOverride.status !== EditSessionStatuses.code.draft) return;
      poseOverride.theta = Number((event.target as HTMLInputElement).value) * Math.PI / 180;
      poseOverride.error = undefined; renderRuntime(snap()); draw();
    });
    detail.querySelector<HTMLButtonElement>(`[data-runtime-action="${action}"]`)?.addEventListener('click', async () => {
      const enabled = action === 'enable';
      const warning = enabled ? `${r.id}을(를) 운영에 다시 참여시킬까요? 현재 위치·상태를 다시 동기화한 뒤 운영을 재개합니다.` : `${r.id}을(를) 운영에서 제외할까요? 모든 논리 점유·예약·대기열(텔레포터 포함)을 해제하고 진행 중 작업을 무효화합니다. 실제 로봇 본체는 물리 장애물로 남고 위치·상태 보고는 계속되며, 명시적인 운영 재개와 재동기화 전에는 다시 운영에 참여하지 않습니다.`;
      const actionGeneration = liveActionGeneration;
      if (!(await runtimeConfirm(warning)) || !canWriteToLive() || actionGeneration !== liveActionGeneration) return;
      const liveRobot = snap().robots.find(robot => robot.id === r.id);
      if (!liveRobot || !transportConnected) return;
      const requestId = runtimeRequestId('control'); runtimePending.add(`control:${r.id}`); runtimeRequests.set(requestId, `control:${r.id}`); renderRuntime(snap());
      runtimeTimeout(requestId, `control:${r.id}`, actionGeneration);
      send('setRobotControl', { robotId: r.id, enabled, requestId, expectedEpoch: liveRobot.controlEpoch });
    });
  }
  const occupancy = $('runtime-occupancies');
  occupancy.innerHTML = records.length ? records.map(o => `<div class="occupancy-row"><div><b>${runtimeEsc(s.zones.find(z=>z.id===o.resourceRef.id)?.name || o.resourceRef.id)}</b><small>${runtimeLabel(o.state)} · ${runtimeEsc(o.robotId)}${o.queuePosition != null ? ` · #${o.queuePosition}` : ''}</small></div><button type="button" class="danger" data-runtime-action="release" data-resource-id="${runtimeEsc(o.resourceRef.id)}" data-robot-id="${runtimeEsc(o.robotId)}" ${runtimePending.has(`release:${o.resourceRef.id}:${o.robotId}`) || !transportConnected ? 'disabled' : ''}>${runtimePending.has(`release:${o.resourceRef.id}:${o.robotId}`) ? '처리 중…' : '선택 해제'}</button></div>`).join('') : '<span class="runtime-empty">런타임 점유 정보가 없습니다.</span>';
  detail.dataset.runtimeKey = detailKey;
  occupancy.dataset.runtimeKey = occupancyKey;
  if (!canWriteToLive()) {
    detail.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(element => { element.disabled = true; });
  }
  occupancy.querySelectorAll<HTMLButtonElement>('[data-runtime-action="release"]').forEach(button => button.addEventListener('click', async () => {
    const resourceId = button.dataset.resourceId!, robotId = button.dataset.robotId!;
    const actionGeneration = liveActionGeneration;
    if (!(await runtimeConfirm(`${robotId}의 ${resourceId} 점유를 해제할까요? 이 작업은 해당 로봇을 반드시 운영 제외 상태로 전환하고, 선택한 점유만 해제합니다.`)) || !canWriteToLive() || actionGeneration !== liveActionGeneration) return;
    const record = records.find(o => o.resourceRef.id === resourceId && o.robotId === robotId); if (!record) return;
    const liveRobot = snap().robots.find(robot => robot.id === robotId); if (!liveRobot) return;
    const requestId = runtimeRequestId('release'); runtimePending.add(`release:${resourceId}:${robotId}`); runtimeRequests.set(requestId, `release:${resourceId}:${robotId}`); renderRuntime(snap());
    runtimeTimeout(requestId, `release:${resourceId}:${robotId}`, actionGeneration);
    send('releaseResourceOccupancy', { resourceKind: 'zone', resourceId, robotId, requestId, expectedEpoch: liveRobot.controlEpoch });
  }));
  if (focused?.action) {
    const next = document.querySelector<HTMLElement>(`[data-runtime-action="${focused.action}"][data-robot-id="${CSS.escape(focused.robotId ?? '')}"][data-resource-id="${CSS.escape(focused.resourceId ?? '')}"], [data-runtime-action="${focused.action}"][data-robot-id="${CSS.escape(focused.robotId ?? '')}"]`);
    next?.focus();
  }
}
function focusedRuntimeAction(el: HTMLElement): string | undefined { return el.dataset.runtimeAction; }

function selectedRobotView(): Snapshot["robots"][number] | undefined {
  return snap().robots.find((robot) => robot.id === selectedRobot);
}

function updateMapChrome(): void {
  const id = $("map-context-id");
  const version = $("map-context-version");
  const hud = document.querySelector<HTMLElement>(".hud-breadcrumb");
  const select = document.querySelector<HTMLSelectElement>("#map-select");
  const chip = document.querySelector<HTMLElement>(".dock-map-chip");
  if (id) id.textContent = activeMap.id;
  if (version) version.textContent = `${activeMap.version} · ${activeMap.width * activeMap.pixelCm / 100} × ${activeMap.height * activeMap.pixelCm / 100} m`;
  if (select) select.value = activeMap.id;
  if (chip) chip.textContent = `${activeMap.id} · ${activeMap.version}`;
  if (hud) hud.innerHTML = `<span>MAP</span><b>${activeMap.id}</b><i>·</i><span>${activeMap.editable ? "editor view" : "preview · read only"}</span>`;
  if ($('canvas-map-name')) $('canvas-map-name').textContent = activeMap.label;
  if ($('canvas-map-meta')) $('canvas-map-meta').textContent = `${activeMap.width * activeMap.pixelCm / 100} × ${activeMap.height * activeMap.pixelCm / 100} m · ${activeMap.pixelCm} cm / px`;
  if ($('library-map-name')) $('library-map-name').textContent = activeMap.label;
  if ($('library-map-size')) $('library-map-size').textContent = `${activeMap.width * activeMap.pixelCm / 100} × ${activeMap.height * activeMap.pixelCm / 100} m · ${activeMap.editable ? '편집 가능' : '미리보기'}`;
  if ($('project-map-image')) ($('project-map-image') as HTMLImageElement).src = activeMap.map;
  canvas.setAttribute("aria-label", `${activeMap.label} map`);
  document.body.dataset.map = activeMap.id;
  for (const card of document.querySelectorAll<HTMLButtonElement>('[data-map-target]')) {
    card.setAttribute('aria-pressed', String(card.dataset.mapTarget === activeMap.id));
  }
}

async function loadActiveMap(next: MapSpec["id"]): Promise<void> {
  if (isReplayView() || viewSource === ViewSources.code["live-resync"]) {
    status("블랙박스 리플레이 중에는 맵을 전환할 수 없습니다. 먼저 라이브로 돌아가세요.");
    const select = document.querySelector<HTMLSelectElement>("#map-select");
    if (select) select.value = activeMap.id;
    return;
  }
  if (mapLoading || next === activeMap.id) return;
  if ((editSession || (resourceDraft && resourceDraft.data.kind !== "teleporter") || draftPoly.length || draftLine.length) && !window.confirm('저장하지 않은 편집을 취소하고 맵을 전환할까요?')) {
    updateMapChrome();
    return;
  }
  mapLoading = true;
  const teleporterDraft = resourceDraft?.data.kind === "teleporter" ? resourceDraft : null;
  const teleporterStepBeforeMapChange = teleporterStep;
  const teleporterSelection = teleporterDraft ? { kind: "teleporter", id: teleporterDraft.data.id } as const : null;
  clearMulti();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-map-target]')) button.disabled = true;
  (document.querySelector('#map-select') as HTMLSelectElement).disabled = true;
    clearEditSession();
    if (teleporterDraft) { resourceDraft = teleporterDraft; teleporterStep = teleporterStepBeforeMapChange; }
  draftPoly = [];
  draftCursor = null;
  draftLine = [];
  selected = teleporterSelection;
  selectedVertex = null;
    setTool(teleporterDraft ? "teleporter" : "select");
  const nextMap = MAP_CATALOG[next];
  try {
    const [mapImage, occ, inflated] = await Promise.all([
      loadImage(nextMap.map),
      loadBin(nextMap.occupancy, nextMap),
      loadBin(nextMap.inflated, nextMap),
    ]);
    connectionGeneration++;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const oldRoom = room; room = null; transportConnected = false; savePending = false;
    if (oldRoom?.connection.isOpen) void oldRoom.leave().catch(() => {});
    runtimePending.clear(); runtimeRequests.clear();
    poseOverrideRequests.clear(); poseOverride = null;
    for (const timer of runtimeTimers.values()) clearTimeout(timer);
    runtimeTimers.clear();
    resetRobotEvents();
    activeMap = nextMap;
    const url = new URL(location.href); url.searchParams.set('map', activeMap.id); history.replaceState(null, '', url);
    setConn('offline', 'offline');
    selectedRobot = "";
    $("sel-robot-id").textContent = "—";
    ($("btn-cancel") as HTMLButtonElement).disabled = true;
    replaceReplayMapImage(mapImage);
    occGrid = occ;
    blueprint = createBlueprint(occ, activeMap.width, activeMap.height);
    inflatedGrid = inflated;
    occLayer = OccupancyLayers.code.off;
    occOverlay = null;
    $("occ-legend").hidden = true;
    updateMapChrome();
    fit();
    status(activeMap.editable ? `${activeMap.label} 맵 편집 준비됨` : `${activeMap.label} 미리보기 · 읽기 전용 맵`);
    renderOutliner(snap());
    renderRobots(snap());
    fillInspector(snap());
    draw();
  } catch (err) {
    status(`맵 로딩 실패: ${err instanceof Error ? err.message : String(err)}`);
    const select = document.querySelector<HTMLSelectElement>("#map-select");
    if (select) select.value = activeMap.id;
  } finally {
    mapLoading = false;
    if (!transportConnected && activeMap.serverPort) void connect().catch(() => scheduleReconnect());
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-map-target]')) button.disabled = false;
    (document.querySelector('#map-select') as HTMLSelectElement).disabled = false;
  }
}

function deg(rad: number): string {
  return `${((rad * 180) / Math.PI).toFixed(0)}°`;
}

function syncEditChrome(): void {
  const chrome = $("edit-chrome");
  const editing = Boolean(editSession || resourceDraft) || (ZONE_TOOLS[tool] && draftPoly.length > 0);
  document.body.dataset.editing = editing ? "true" : "false";
  chrome.hidden = !editing;
  fillInspector(snap());
  if (editing) showProperties();
  if (!editing) return;

  if (editSession?.kind === "pose") {
    const verb = editSession.mode === EditModes.code.create ? "배치" : "수정";
    $("edit-badge").textContent = verb;
    $("edit-title").textContent = `${editSession.asset} ${verb}`;
    $("edit-meta").textContent =
      `x ${editSession.x.toFixed(1)}  y ${editSession.y.toFixed(1)}  θ ${deg(editSession.theta)}` +
      (editSession.size != null ? `  sz ${editSession.size.toFixed(0)}` : "");
    $("edit-keys").textContent = "드래그 이동 · 노란 점 회전 · Q/E · Esc/Enter";
  } else if (editSession?.kind === "zone") {
    const verb = editSession.mode === EditModes.code.create ? "배치" : "수정";
    $("edit-badge").textContent = verb;
    $("edit-title").textContent = `${editSession.zoneKind} ${verb}`;
    $("edit-meta").textContent = `꼭짓점 ${editSession.polygon.length}`;
    $("edit-keys").textContent = "라벨·정점으로 조정 · Esc/Enter";
  } else if (resourceDraft) {
    $("edit-badge").textContent = resourceDraft.mode === EditModes.code.create ? '배치' : '수정';
    $("edit-title").textContent = resourceDraft.data.name;
    $("edit-meta").textContent = resourceDraft.data.kind;
    $("edit-keys").textContent = '오른쪽 속성에서 이름·설정 수정 후 저장';
  } else {
    $("edit-badge").textContent = "그리기";
    $("edit-title").textContent = `${tool} 폴리곤`;
    $("edit-meta").textContent = `꼭짓점 ${draftPoly.length}${draftPoly.length >= 3 ? " · Enter로 닫기" : ""}`;
    $("edit-keys").textContent = "Backspace 한 점 · Esc 취소 · Enter 닫기";
  }
}

function clearEditSession(): void {
  editSession = null;
  resourceDraft = null;
  teleporterPointMode = null;
  teleporterPolyDrag = null;
  teleporterEndpointDrag = null;
  inspectorKey = "";
  editDrag = null;
  editGrab = null;
  zonePreview = null;
  if (!resourceDraft) teleporterStep = null;
  syncEditChrome();
}

function beginPoseCreate(asset: PoseAsset, x: number, y: number, theta = 0, size?: number): void {
  editSession = {
    kind: "pose",
    mode: EditModes.code.create,
    asset,
    id: newResourceId(asset),
    name: asset,
    source: asset === "obstacle" ? { obstacleKind: obstacleShape } : {},
    x,
    y,
    theta,
    size: asset === "obstacle" ? (size ?? 16) : undefined,
  };
  editDrag = asset === "obstacle" ? EditHandles.code.size : EditHandles.code.rotate;
  selected = null;
  syncEditChrome();
  status(`${asset} 편집 중 · 확인을 눌러 저장`);
  draw();
}

function beginPoseModify(asset: PoseAsset, id: string, x: number, y: number, theta: number, size?: number): void {
  const original = resourceOf(snap(), asset, id);
  editSession = { kind: "pose", mode: EditModes.code.modify, asset, id, name: original?.name || id, source: { ...original }, x, y, theta, size };
  if (asset === 'obstacle') obstacleShape = original?.kind ?? 'square';
  selected = { kind: asset, id };
  syncEditChrome();
  status(`${asset} 수정 중 · 확인을 눌러 저장`);
  draw();
}

function beginZoneModify(z: Snapshot["zones"][number], polygon: Point[]): void {
  editSession = {
    kind: "zone",
    mode: EditModes.code.modify,
    id: z.id,
    family: z.family === ResourceFamilies.code.vda ? ResourceFamilies.code.vda : ResourceFamilies.code.scene,
    zoneKind: z.kind as ZoneKind,
    name: z.name,
    source: { ...z },
    polygon: polygon.map((p) => ({ ...p })),
    factor: z.factor,
    maximumSpeed: z.maximumSpeed,
    capacity: z.capacity,
    theta: z.theta,
  };
  zonePreview = { id: z.id, polygon: editSession.polygon };
  selected = { kind: "zone", id: z.id };
  syncEditChrome();
  status(`${z.kind} 수정 중 · 확인을 눌러 저장`);
  draw();
}

function cancelEdit(): void {
  if (savePending) return;
  if (document.activeElement?.closest("#inspect-panel")) (document.activeElement as HTMLElement).blur();
  if (ZONE_TOOLS[tool] && draftPoly.length && !editSession) {
    draftPoly = [];
    draftCursor = null;
    status("그리기 취소");
    syncEditChrome();
    draw();
    return;
  }
  if (!editSession && !resourceDraft) return;
  clearEditSession();
  draftPoly = [];
  draftCursor = null;
  status("편집 취소");
  fillInspector(snap());
  draw();
}

function confirmEdit(): void {
  if (!canWriteToLive()) { status("블랙박스 리플레이에서는 편집을 저장할 수 없습니다."); return; }
  if (!activeMap.editable || !transportConnected || savePending) return;
  if (!editSession && !resourceDraft) {
    if (ZONE_TOOLS[tool] && draftPoly.length >= 3) closePolygon();
    return;
  }
  const invalid = [...document.querySelectorAll<HTMLInputElement>('#inspect-panel input')].find(el => !el.closest('[hidden]') && !el.checkValidity());
  if (invalid) { invalid.reportValidity(); return; }
  let payload: Record<string, any>;
  if (editSession?.kind === 'pose') {
    const e = editSession;
    payload = { ...e.source, kind: e.asset, id: e.id, name: e.name.trim() || e.asset, x: e.x, y: e.y, theta: e.theta };
    if (e.asset === 'station') payload.stationKind = e.source?.kind ?? 'other';
    if (e.asset === 'obstacle') { payload.obstacleKind = e.source?.obstacleKind ?? e.source?.kind ?? obstacleShape; payload.size = e.size ?? 16; }
  } else if (editSession?.kind === 'zone') {
    const e = editSession;
    if (!isSimplePolygon(e.polygon) || Math.abs(signedArea(e.polygon)) < 0.01) { status('면적이 있는 단순 폴리곤만 저장할 수 있습니다.'); return; }
    payload = { ...e.source, kind: 'zone', id: e.id, family: e.family, zoneKind: e.zoneKind, name: e.name.trim() || e.zoneKind, polygon: e.polygon, theta: e.theta, factor: e.factor, maximumSpeed: e.maximumSpeed, capacity: e.capacity };
  } else {
    if (resourceDraft!.data.kind === "teleporter") {
      const d = resourceDraft!.data;
      if (!d.endpoints || d.endpoints.length !== 2) { status("두 층의 입출구를 모두 배치하세요."); return; }
      for (const ep of d.endpoints) {
        const poly = (ep.occupancyPolygon ?? []).map((p: Point) => ({ x: p.x + ep.position.x, y: p.y + ep.position.y }));
        if (poly.length < 3 || teleporterPolygonContains(poly, ep.clearingPoint)) { status(`${ep.mapId} clearing point는 점유 영역 밖이어야 합니다.`); return; }
      }
      payload = { kind: "teleporter", id: d.id, name: String(d.name || "teleporter").trim(), enabled: d.enabled !== false, revision: d.revision ?? 0, expectedRevision: resourceDraft!.mode === EditModes.code.modify ? Number(d.revision ?? 0) : undefined, endpoints: d.endpoints.map((ep: any) => ({ id: ep.id, mapId: ep.mapId, position: { ...ep.position }, entryTheta: Number(ep.entryTheta), exitTheta: Number(ep.exitTheta), occupancyPolygon: ep.occupancyPolygon.map((p: Point) => ({...p})), clearingPoint: { ...ep.clearingPoint } })) };
    } else payload = { ...resourceDraft!.data };
  }
  savePending = true;
  $('property-state').textContent = '서버에 저장 중…';
  if (payload.kind === 'teleporter') { const copy = JSON.parse(JSON.stringify(payload)); const expectedRevision = copy.expectedRevision; delete copy.expectedRevision; send('teleporterUpsert', { requestId: runtimeRequestId('teleporter-save'), teleporter: copy, expectedRevision }); }
  else send('editorUpsert', JSON.parse(JSON.stringify(payload)));
  fillInspector(snap());
}

function rotateEdit(delta: number): void {
  if (!editSession || editSession.kind !== "pose") return;
  editSession.theta = Math.atan2(Math.sin(editSession.theta + delta), Math.cos(editSession.theta + delta));
  syncEditChrome();
  draw();
}

function isFree(x: number, y: number): boolean {
  if (!occGrid) return false;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= activeMap.width || iy >= activeMap.height) return false;
  return occGrid[iy * activeMap.width + ix] === 1;
}

function eventPos(e: PointerEvent): { sx: number; sy: number; x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const w = screenToWorld(cam, sx, sy);
  return { sx, sy, x: w.x, y: w.y };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

async function loadBin(url: string, map: MapSpec): Promise<Uint8Array> {
  const res = await fetch(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== map.width * map.height) throw new Error(`${url} size`);
  return buf;
}

function buildOccOverlay(): HTMLCanvasElement | null {
  if (occLayer === OccupancyLayers.code.off || !occGrid) return null;
  const c = document.createElement("canvas");
  const step = Math.max(1, Math.ceil(Math.max(activeMap.width, activeMap.height) / 2048));
  c.width = Math.ceil(activeMap.width / step); c.height = Math.ceil(activeMap.height / step);
  const octx = c.getContext("2d")!;
  const img = octx.createImageData(c.width, c.height);
  for (let y=0; y<c.height; y++) for (let x=0; x<c.width; x++) {
    const i = y*step*activeMap.width+x*step, o = (y*c.width+x)*4;
    const free = occGrid[i] === 1, safe = inflatedGrid ? inflatedGrid[i] === 1 : free;
    const color = occLayer === OccupancyLayers.code.occupancy ? (free ? [45,212,191,88] : [15,23,42,150])
      : safe ? [45,212,191,88] : free ? [251,191,36,120] : [15,23,42,150];
    img.data.set(color,o);
  }
  octx.putImageData(img, 0, 0);
  return c;
}

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  draw();
}

function draw(): void {
  updateCanvasCursor();
  const overview = $('overview-map') as HTMLCanvasElement | null;
  const overviewSource = blueprintEnabled && blueprint ? blueprint : images.map;
  const overviewReady = overviewSource && (overviewSource instanceof HTMLCanvasElement
    || (typeof ImageBitmap !== "undefined" && overviewSource instanceof ImageBitmap)
    || ("complete" in overviewSource && overviewSource.complete && "naturalWidth" in overviewSource && overviewSource.naturalWidth > 0));
  if (overview && overviewReady && performance.now() - lastOverviewFrame > 100) {
    lastOverviewFrame = performance.now();
    drawOverview(overview, overviewSource, snap(), cam, activeMap.width, activeMap.height, viewport.clientWidth, viewport.clientHeight);
  } else if (overview && isReplayView() && !replaySceneReady) {
    overview.getContext("2d")?.clearRect(0, 0, overview.width, overview.height);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyCamera(ctx, cam, dpr);
  const px = 1 / Math.max(cam.scale, 0.005);
  const dim = Boolean(editSession || resourceDraft) || (ZONE_TOOLS[tool] && draftPoly.length > 0);
  const hideId = editSession?.kind === "pose" && editSession.mode === EditModes.code.modify
    ? editSession.id
    : undefined;
  const zonePrev = editSession?.kind === "zone"
    ? { id: editSession.id ?? `__draft_${editSession.zoneKind}`, polygon: editSession.polygon }
    : zonePreview ?? undefined;
  const renderSnapshot = snap();
  if (resourceDraft) {
    const key = ({ edge: 'edges', portal: 'portals', rail: 'rails', teleporter: 'teleporters' } as const)[resourceDraft.data.kind as 'edge' | 'portal' | 'rail' | 'teleporter'];
    if (key) (renderSnapshot[key] as any[]) = [...renderSnapshot[key].filter(r => r.id !== resourceDraft!.data.id), resourceDraft.data];
  }
  if (editSession?.kind === 'zone') {
    const e = editSession;
    renderSnapshot.zones = [...renderSnapshot.zones.filter(z => z.id !== e.id), { ...e.source, id: e.id!, family: e.family, kind: e.zoneKind, name: e.name, polygon: e.polygon, theta: e.theta }];
  }
  drawWorld(ctx, renderSnapshot, { ...images, map: blueprintEnabled && blueprint ? blueprint : images.map, occ: occOverlay }, {
    mapWidth: activeMap.width,
    mapHeight: activeMap.height,
    layers,
    selectedId: selected?.id ?? editSession?.id ?? resourceDraft?.data.id,
    selectedVertex: selectedVertex ?? undefined,
    draftPoly: draftPoly.length ? draftPoly : undefined,
    draftCursor: ZONE_TOOLS[tool] && draftPoly.length ? draftCursor ?? undefined : undefined,
    draftInvalid: Boolean(draftCursor && draftPoly.length >= 2 && !canAppendVertex(draftPoly, draftCursor)),
    draftLine: draftLine.length ? draftLine : undefined,
    px,
    zonePreview: zonePrev,
    dimOthers: dim,
    hideId,
  });
  if (poseOverride) {
    const issues = poseOverrideIssues(poseOverride);
    ctx.save();
    ctx.translate(poseOverride.x, poseOverride.y);
    ctx.rotate(poseOverride.theta);
    ctx.strokeStyle = issues.length ? "#fb7185" : "#2dd4bf";
    ctx.fillStyle = issues.length ? "rgba(251,113,133,.18)" : "rgba(45,212,191,.16)";
    ctx.lineWidth = 2 * px;
    ctx.setLineDash(poseOverride.status === EditSessionStatuses.code.pending ? [5 * px, 4 * px] : []);
    ctx.beginPath(); ctx.rect(-8, -5, 16, 10); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(18, 0); ctx.stroke();
    ctx.restore();
  }
  if (editSession?.kind === "pose") {
    drawPoseEditor(ctx, editSession, px, {
      obstacle: editSession.asset === "obstacle",
      shape: obstacleShape,
    });
  } else if (poseDraft) {
    ctx.strokeStyle = "#f8fafc";
    ctx.beginPath();
    ctx.arc(poseDraft.x, poseDraft.y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(poseDraft.x, poseDraft.y);
    ctx.lineTo(poseDraft.x + Math.cos(poseDraft.theta) * 24, poseDraft.y + Math.sin(poseDraft.theta) * 24);
    ctx.stroke();
  }
  if (performance.now() < flashUntil) {
    ctx.fillStyle = "rgba(248,113,113,0.18)";
    ctx.fillRect(0, 0, activeMap.width, activeMap.height);
  }
  ctx.save();
  ctx.strokeStyle = '#1684df';
  ctx.lineWidth = 2 * px;
  for (const { bounds: b } of selectedItems()) {
    ctx.strokeRect(b.x - 6 * px, b.y - 6 * px, b.right - b.x + 12 * px, b.bottom - b.y + 12 * px);
  }
  if (marquee) {
    const b = rectangle(marquee.start, marquee.end);
    ctx.fillStyle = 'rgba(22,132,223,0.12)';
    ctx.fillRect(b.x, b.y, b.right - b.x, b.bottom - b.y);
    ctx.setLineDash([5 * px, 3 * px]);
    ctx.strokeRect(b.x, b.y, b.right - b.x, b.bottom - b.y);
  }
  ctx.restore();
  $("zoom-label").textContent = `${Math.round(cam.scale * 100)}%`;
  syncEditChrome();
}

function fit(): void {
  const panel = document.getElementById("blackbox-panel");
  const panelHeight = isReplayView() && panel && !panel.hidden ? Math.min(panel.offsetHeight + 24, Math.floor(viewport.clientHeight * 0.45)) : 0;
  const availableHeight = Math.max(1, viewport.clientHeight - panelHeight);
  cam = fitCamera(viewport.clientWidth, availableHeight, activeMap.width, activeMap.height);
  draw();
}

function addTool(parent: HTMLElement, id: string, label: string, key = ""): void {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.tool = id;
  const names = ToolKinds.labels;
  b.title = `${label}${key ? ` (${key})` : ''}`;
  b.innerHTML = `${icon(id)}<span>${names[id as keyof typeof names] ?? label}</span>${key ? `<kbd>${key}</kbd>` : ""}`;
  b.addEventListener("click", () => setTool(id));
  parent.append(b);
}

function setTool(next: Tool): void {
  clearMulti();
  if (isReplayView() && !["select", "grid", "marquee"].includes(next)) {
    status("블랙박스 리플레이는 읽기 전용입니다.");
    next = "select";
  }
  if ((next === "move" || next === "dock") && selectedRobotView() && !canDispatchRobot(selectedRobotView())) {
    status(selectedRobot + " 연결 끊김 · 명령을 보낼 수 없어");
    next = "select";
  }
  if (!activeMap.editable && next !== "select" && next !== "grid" && next !== "marquee") {
    status(`${activeMap.label}는 미리보기 맵이야. 편집 가능한 맵을 선택하세요`);
    next = "select";
  }
  if (next === "grid") {
    occLayer = occLayer === OccupancyLayers.code.off ? OccupancyLayers.code.occupancy : occLayer === OccupancyLayers.code.occupancy ? OccupancyLayers.code.inflated : OccupancyLayers.code.off;
    occOverlay = buildOccOverlay();
    $("occ-legend").hidden = occLayer === OccupancyLayers.code.off;
    $("occ-legend-clearance").hidden = occLayer !== OccupancyLayers.code.inflated;
    next = "select";
  }
  if (savePending) return;
  if (editSession || (resourceDraft && !(resourceDraft.data.kind === "teleporter" && next === "teleporter"))) cancelEdit();
  tool = next;
  draftPoly = [];
  draftCursor = null;
  draftLine = [];
  edgeStart = null;
  poseDraft = null;
  selectedVertex = null;
  zonePreview = null;
  zoneDrag = null;
  editDrag = null;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tools button[data-tool]")) {
    b.setAttribute("aria-pressed", b.dataset.tool === tool ? "true" : "false");
  }
  $("shape-section").hidden = !(mode === AppModes.code.scene && tool === ToolKinds.code.obstacle);
  const hints: Record<string, string> = {
    marquee: "드래그로 영역 선택 · Shift로 추가 · Esc 해제 · 점은 중심, 구역·선은 전체 포함",
    select: "리소스 클릭 = 편집 모드. 라벨·정점·노란 점으로 조정 후 확인.",
    move: "로봇을 고른 뒤 바닥이나 웨이포인트를 찍어.",
    dock: "로봇을 고른 뒤 충전소를 찍어.",
    waypoint: "바닥 클릭 → 편집 모드. 확인으로 저장.",
    charger: "바닥 클릭 → 편집 모드. 확인으로 저장.",
    obstacle: "클릭 → 크기/헤딩 조정 → 확인.",
    node: "바닥 클릭 → 편집 모드. 확인으로 저장.",
    edge: "시작 노드 → 끝 노드.",
    station: "클릭 → 편집 모드. 확인으로 저장.",
    portal: "두 점으로 입구 선분.",
    teleporter: "현재 층에서 A를 클릭한 뒤 연결 층에서 B를 배치하세요.",
    rail: "클릭으로 점, Enter로 확정.",
    grid: "occupancy 오버레이.",
  };
  $("tool-hint").textContent = hints[tool] ?? (ZONE_TOOLS[tool]
    ? "꼭짓점 클릭. 닫으면 편집 확인. Backspace 한 점 취소."
    : "스페이스+드래그 팬, 휠 줌.");
  syncEditChrome();
  if ($('multi-panel')) fillInspector(snap());
  draw();
}

function setMode(next: Mode): void {
  if (savePending) return;
  mode = next;
  document.body.dataset.mode = next;
  const modeCopy: Record<Mode, { title: string; description: string; hud: string }> = {
    operate: { title: "운용", description: "로봇 상태를 확인하고 이동·도킹 명령을 실행해.", hud: "운용 · robot control" },
    scene: { title: "현장 배치", description: "운영에 필요한 위치·장애물·현장 존을 편집해.", hud: "현장 배치 · scene authoring" },
    vda: { title: "VDA 배치", description: "지원 교통 의미와 메타데이터를 편집해. 그래프·레일은 편집 전용이야.", hud: "VDA 배치 · supported traffic semantics + metadata" },
  };
  const copy = modeCopy[next];
  $("mode-title").textContent = copy.title;
  $("mode-description").textContent = copy.description;
  $("hud-mode").textContent = copy.hud;
  for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
    b.setAttribute("aria-pressed", b.dataset.mode === next ? "true" : "false");
  }
  setTool("select");
  resize();
  if (next === 'operate') document.querySelector<HTMLButtonElement>('[data-detail="fleet"]')?.click();
  else document.querySelector<HTMLButtonElement>('[data-detail="properties"]')?.click();
}

function renderRobots(s: Snapshot): void {
  if ($('canvas-online-count')) $('canvas-online-count').textContent = `${s.robots.filter(r => r.connected).length} / ${s.robots.length} ROBOTS ONLINE`;
  const box = $("robot-cards");
  // Keep focused/clicked buttons alive across the 50 ms telemetry patches.
  const cards = new Map(Array.from(box.querySelectorAll<HTMLButtonElement>(".card"), el => [el.dataset.robotId!, el]));
  for (const [id, el] of cards) {
    if (!s.robots.some(r => r.id === id)) el.remove();
  }
  const selected = s.robots.find((r) => r.id === selectedRobot);
  const cancel = $("btn-cancel") as HTMLButtonElement;
  cancel.disabled = !canWriteToLive() || !selected || !canDispatchRobot(selected) || selected.status !== "move";
  const guide = $("traffic-selected");
  if (!selected) {
    guide.textContent = "로봇을 선택하면 이동·도킹 대상을 맵에서 지정할 수 있어요.";
  } else if (!selected.connected) {
    guide.textContent = selected.id + ": 연결 끊김 · 명령을 보낼 수 없어. 로봇 연결 후 다시 선택하세요.";
  } else if (selected.fmsControlState === "disabled") {
    guide.textContent = `${selected.id}: 운영 제외 · 상태 보고는 계속 표시합니다. 운영 재개 후 이동·도킹 명령을 사용할 수 있습니다.`;
  } else if (!selected.controlReady) {
    guide.textContent = `${selected.id}: 상태 동기화 중 · 제어 준비가 끝나면 명령을 사용할 수 있습니다.`;
  } else {
    const traffic = trafficCopy(selected.trafficStatus);
    const commandLabel = COMMAND_STATE[selected.commandState] ?? selected.commandState;
    guide.title = selected.commandReason ? commandLabel + " · " + selected.commandReason : commandLabel;
    guide.textContent = `${selected.id}: ${commandLabel}${selected.commandReason ? ` · ${selected.commandReason}` : ""} · ${traffic.label}. M 이동 명령, D 도킹, 선택 로봇 주행 취소로 운용하세요.`;
  }
  for (const r of s.robots) {
    const existing = cards.get(r.id);
    const el = existing ?? document.createElement("button");
    el.type = "button";
    el.className = "card";
    el.dataset.robotId = r.id;
    el.dataset.x = String(r.x);
    el.dataset.y = String(r.y);
    el.dataset.theta = String(r.theta);
    el.dataset.commandState = r.commandState;
    el.dataset.driveState = r.driveState;
    el.dataset.active = r.id === selectedRobot ? "true" : "false";
    const traffic = trafficCopy(r.trafficStatus);
    const motion = r.driveState !== 'unknown' ? runtimeLabel(r.driveState) : (!r.connected ? "연결 끊김" : r.motion || (r.status === "move" ? "주행 중" : "대기"));
    const commandLabel = COMMAND_STATE[r.commandState] ?? r.commandState;
    const controlGlyph = r.fmsControlState === 'disabled' ? '⊘' : r.connectionState === 'offline' ? '○' : '●';
    el.innerHTML = `<div class="robot-card-head"><span class="robot-card-identity"><i class="runtime-state-glyph ${r.fmsControlState === 'disabled' ? 'is-disabled' : r.connectionState}">${controlGlyph}</i><span class="id">${r.id}</span></span><span class="robot-card-state"><i class="traffic-dot" data-traffic="${r.trafficStatus}"></i>${traffic.label}</span></div><div class="robot-card-meta"><span>${runtimeLabel(r.workState)} · ${motion}</span><span>${r.operatorPaused ? '운영자 일시정지' : r.fmsControlState === 'disabled' ? '운영 제외' : traffic.detail}</span></div>`;
    const commandReason = r.commandReason ? " · " + r.commandReason : "";
    el.title = commandLabel + commandReason;
    el.setAttribute("aria-label", r.id + " · " + commandLabel + commandReason);
    const commandState = document.createElement("span");
    commandState.textContent = COMMAND_STATE[r.commandState] ?? r.commandState;
    if (r.commandReason) commandState.textContent += " · " + r.commandReason;
    el.querySelector(".robot-card-meta")?.append(commandState);
    if (!existing) el.addEventListener("click", () => {
      selectedRobot = r.id;
      $("sel-robot-id").textContent = r.id;
      renderRobots(snap());
    });
    if (!existing) box.append(el);
  }
  renderRuntime(s);
}

function renderOutliner(s: Snapshot): void {
  const box = $("outliner");
  const rows: { kind: string; id: string; label: string }[] = [
    ...s.waypoints.map((w) => ({ kind: "waypoint", id: w.id, label: `${w.name || w.id} · wp` })),
    ...s.chargers.map((w) => ({ kind: "charger", id: w.id, label: `${w.name || w.id} · cs` })),
    ...s.obstacles.map((w) => ({ kind: "obstacle", id: w.id, label: `${w.name || w.id} · obs` })),
    ...s.zones.map((w) => ({ kind: "zone", id: w.id, label: `${w.name || w.id} · ${w.kind}` })),
    ...s.nodes.map((w) => ({ kind: "node", id: w.id, label: `${w.name || w.id} · n` })),
    ...s.edges.map((w) => ({ kind: "edge", id: w.id, label: `${w.name || w.id} · e` })),
    ...s.stations.map((w) => ({ kind: "station", id: w.id, label: `${w.name || w.id} · st` })),
    ...s.portals.map((w) => ({ kind: "portal", id: w.id, label: `${w.name || w.id} · portal` })),
    ...s.rails.map((w) => ({ kind: "rail", id: w.id, label: `${w.name || w.id} · rail` })),
    ...s.teleporters.map((w) => ({ kind: "teleporter", id: w.id, label: `${w.name || w.id} · teleporter` })),
  ];
  $("resource-count").textContent = String(rows.length).padStart(2,"0");
  const signature = JSON.stringify([rows, selected, [...multiSelection]]);
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.replaceChildren();
  for (const row of rows) {
    const b = document.createElement("button");
    b.type = "button";
    const resource = resourceOf(s, row.kind, row.id)!;
    const type = row.kind === 'zone' ? resource.kind : row.kind;
    b.innerHTML = icon(type, 'resource-glyph');
    const copy = document.createElement('span'); copy.className = 'resource-copy';
    const name = document.createElement('b'); name.textContent = resource.name || row.id;
    const description = document.createElement('small'); description.textContent = `${resourceLabels[type] ?? type} · ${row.id.length > 15 ? row.id.slice(0,12)+'…' : row.id}`;
    copy.append(name,description); const dot = document.createElement('i'); dot.className = 'resource-dot';
    b.append(copy,dot); b.dataset.search = `${resource.name} ${row.id} ${type} ${resourceLabels[type] ?? ''}`;
    b.dataset.kind = row.kind; b.dataset.id = row.id; b.title = `${row.label} · ${row.id}`;
    b.dataset.active = selected?.id === row.id || multiSelection.has(selectionKey(row)) ? "true" : "false";
    b.addEventListener("click", () => {
      if (savePending) return;
      clearEditSession();
      setTool("select");
      clearMulti();
      selected = { kind: row.kind, id: row.id };
      fillInspector(snap());
      document.querySelector<HTMLButtonElement>('[data-detail="properties"]')?.click();
      renderOutliner(snap());
      draw();
    });
    box.append(b);
  }
}

function renderPropertyArt(kind: string, r: Record<string, any>): void {
  const art = $('property-art');
  const points = (kind === 'zone' ? r.polygon : kind === 'rail' ? r.points : kind === 'edge' ? r.trajectory : []) as Point[];
  if (points?.length > 1) {
    const minX=Math.min(...points.map(p=>p.x)), minY=Math.min(...points.map(p=>p.y));
    const scale=48/Math.max(1,Math.max(...points.map(p=>p.x))-minX,Math.max(...points.map(p=>p.y))-minY);
    const coords = points.map(p=>`${12+(p.x-minX)*scale},${12+(p.y-minY)*scale}`).join(' ');
    const signature = `${kind}:${coords}`;
    if (art.dataset.shape === signature) return;
    art.dataset.shape = signature;
    art.innerHTML = `<path d="M0 18h72M0 36h72M0 54h72M18 0v72M36 0v72M54 0v72" stroke="currentColor" opacity=".12"/><${kind === 'zone' ? 'polygon' : 'polyline'} points="${coords}" fill="${kind === 'zone' ? 'currentColor' : 'none'}" fill-opacity=".12" stroke="currentColor" stroke-width="1.5"/>`;
  } else {
    const type=kind === 'obstacle' ? 'obstacle' : kind;
    if (art.dataset.shape === type) return;
    art.dataset.shape=type; art.innerHTML = icon(type).replace('<svg ', '<svg x="15" y="15" width="42" height="42" ');
  }
}

function inspectorResource(s: Snapshot): { kind: string; data: Record<string, any>; draft: boolean } | null {
  if (editSession?.kind === 'pose') return { kind: editSession.asset, data: { ...editSession.source, ...editSession, kind: editSession.source?.obstacleKind ?? editSession.source?.kind }, draft: true };
  if (editSession?.kind === 'zone') return { kind: 'zone', data: { ...editSession.source, ...editSession, kind: editSession.zoneKind }, draft: true };
  if (resourceDraft) return { kind: resourceDraft.data.kind, data: resourceDraft.data, draft: true };
  const data = selected && resourceOf(s, selected.kind, selected.id);
  return data ? { kind: selected!.kind, data, draft: false } : null;
}
function propertyValue(id: string, value: unknown): void {
  const el = $(id) as HTMLInputElement;
  if (document.activeElement !== el) el.value = value == null ? '' : String(value);
}
function fillInspector(s: Snapshot): void {
  if (!$('inspect-panel')) return;
  const current = inspectorResource(s);
  const items = selectedItems();
  const batch = $('multi-panel');
  if (batch) {
    batch.hidden = !items.length;
    if (items.length) {
      $('multi-count').textContent = `${items.length}개 선택됨`;
      const counts: Record<string, number> = {};
      for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      $('multi-summary').textContent = Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' · ');
    }
  }
  $('inspect-empty').hidden = Boolean(current) || !!items.length;
  $('inspect-panel').hidden = !current || !!items.length;
  for (const id of ['btn-edit-confirm','btn-edit-cancel']) ($(id) as HTMLButtonElement).disabled = savePending || !transportConnected;
  if (!current || items.length) { inspectorKey = ''; $('property-title').textContent = items.length ? '다중 선택' : '공간의 규칙'; $('property-subtitle').textContent = 'RESOURCE INSPECTOR'; $('property-art').replaceChildren(); delete $('property-art').dataset.shape; return; }
  const { kind, data: r, draft } = current;
  $('property-title').textContent = r.name || resourceLabels[kind] || kind;
  $('property-subtitle').textContent = `${draft ? 'EDITING' : 'RESOURCE'} / ${(kind === 'zone' ? r.kind : kind).toUpperCase()}`;
  renderPropertyArt(kind, r);
  const readOnly = kind === 'robot' || !activeMap.editable || !canWriteToLive();
  const key = `${kind}:${r.id}`;
  const changed = inspectorKey !== key;
  inspectorKey = key;
  $('insp-kind').textContent = kind === 'zone' ? r.kind : kind;
  $('insp-id').textContent = r.id;
  $('insp-id').title = `고유 ID · 변경되지 않음: ${r.id}`;
  $('btn-delete').hidden = readOnly || editSession?.mode === EditModes.code.create || resourceDraft?.mode === EditModes.code.create;
  $('insp-name-wrap').hidden = readOnly;
  const pose = ['waypoint', 'charger', 'obstacle', 'node', 'station', 'robot'].includes(kind);
  const center = kind === 'zone' ? centroid(r.polygon) : pose ? r : null;
  $('insp-x-wrap').hidden = !center;
  $('insp-y-wrap').hidden = !center;
  const angle = kind !== 'portal' && kind !== 'teleporter';
  $('insp-theta-wrap').hidden = !angle;
  $('insp-theta-slider-wrap').hidden = !angle || readOnly;
  $('rotation-module').hidden = !angle;
  $('insp-size-wrap').hidden = kind !== 'obstacle';
  const cost = kind === 'zone' && ['prefer', 'avoid', 'priority', 'penalty'].includes(r.kind);
  const capacity = kind === 'zone' && ['corridor', 'complex'].includes(r.kind);
  const speed = kind === 'edge' || (kind === 'zone' && r.kind === 'speed_limit');
  $('insp-factor-wrap').hidden = !cost;
  $('insp-capacity-wrap').hidden = !capacity;
  $('insp-speed-wrap').hidden = !speed;
  $('insp-lw-wrap').hidden = kind !== 'edge';
  $('insp-rw-wrap').hidden = kind !== 'edge';
  const guidancePanel = $('zone-guidance');
  const guidance = kind === 'zone' ? zoneGuidance(r.kind) : null;
  if (!guidance) guidancePanel.hidden = true;
  else {
    const validation = validateZoneForGuidance(r.kind, r.polygon ?? []);
    guidancePanel.hidden = false;
    guidancePanel.className = `zone-guidance ${validation.some(item => item.level === 'error') ? 'is-error' : validation.length ? 'is-warning' : ''}`;
    guidancePanel.innerHTML = `<b>${guidance.title}</b><p>${guidance.detail}</p>${validation.map(item => `<p class="zone-guidance-${item.level}">${item.level === 'error' ? '확인 필요' : '주의'} · ${item.message}</p>`).join('')}`;
  }
  propertyValue('insp-name', r.name || '');
  propertyValue('insp-x', center?.x?.toFixed(2)); propertyValue('insp-y', center?.y?.toFixed(2));
  const degrees = (r.theta ?? 0) * 180 / Math.PI;
  propertyValue('insp-theta-num', Number(degrees.toFixed(2)));
  propertyValue('insp-theta', degrees);
  $('insp-theta-label').textContent = `${(r.theta ?? 0).toFixed(3)} rad · 드래그 회전`;
  $('rotation-needle').style.transform = `rotate(${degrees}deg)`;
  $('theta-value').textContent = `${degrees.toFixed(0)}°`;
  $('insp-theta').style.setProperty('--angle-percent', `${(degrees + 180) / 3.6}%`);
  $('insp-size-label').textContent = r.kind === 'circle' ? '반지름 · px' : r.kind === 'square' ? '반폭 · px' : '외접 반경 · px';
  propertyValue('insp-size', r.size);
  propertyValue('insp-factor', r.factor ?? (['prefer', 'priority'].includes(r.kind) ? 0.4 : 3));
  propertyValue('insp-capacity', r.capacity ?? 1);
  propertyValue('insp-speed', r.maximumSpeed ?? (kind === 'edge' ? 0 : 0.6));
  propertyValue('insp-left', r.corridor?.leftWidth ?? 0.6); propertyValue('insp-right', r.corridor?.rightWidth ?? 0.6);
  const extra = $('resource-fields');
  if (changed) {
    extra.replaceChildren();
    const add = (prop: string, label: string, options?: readonly { value: string; label: string }[], min?: number) => {
      const wrap = document.createElement('label'); wrap.className = 'field property-field';
      const title = document.createElement('span'); title.textContent = label;
      const input = document.createElement(options ? 'select' : 'input');
      input.id = `prop-${prop}`; input.dataset.prop = prop;
      if (options) for (const option of options) { const el = document.createElement('option'); el.value = option.value; el.textContent = option.label; input.append(el); }
      else { const el = input as HTMLInputElement; el.type = 'number'; el.required = true; el.step = 'any'; if (min != null) el.min = String(min); }
      input.addEventListener('input', () => applyInspector(input.id));
      wrap.append(title, input); extra.append(wrap);
    };
    if (kind === 'node') { add('allowedDeviationXY', '위치 허용오차 · m', undefined, 0); add('allowedDeviationTheta', '각도 허용오차 · rad', undefined, 0); }
    if (kind === 'station') add('stationKind', '스테이션 용도', StationKinds.options);
    if (kind === 'zone' && ['directed', 'bidirected'].includes(r.kind)) {
      add('direction', '통행 방향 · rad');
      add('directedLimitation', '방향 제한', [{ value: '', label: '기본값' }, ...DirectedLimitations.options]);
    }
    if (kind === 'zone' && r.kind === 'release') add('releaseLossBehavior', '권한 해제 시', [{ value: '', label: '기본값' }, ...ZoneReleaseLossBehaviors.options]);
    if (kind === 'portal' || kind === 'rail') add('zoneId', '연결 구역', s.zones.map(z => ({ value: z.id, label: z.name || z.id })));
    if (kind === 'teleporter') {
      const endpoint = (r.endpoints ?? [])[0];
      const endpoints = r.endpoints ?? [];
      const sourceMapId = endpoints[0]?.mapId ?? activeMap.id;
      const targetMapId = r.targetMapId ?? endpoints[1]?.mapId;
      const target = Object.values(MAP_CATALOG).find(m => m.id === targetMapId) ?? Object.values(MAP_CATALOG).find(m => m.id !== sourceMapId && m.editable);
      const wrap = document.createElement('div'); wrap.className = 'teleporter-flow';
      const flowLabel = teleporterStep === TeleporterEndpointSteps.code.B ? 'B 출구 배치 중' : resourceDraft ? 'A 끝점 배치됨 · 저장 전' : '저장된 양 끝점';
      wrap.innerHTML = `<p class="property-state">${flowLabel} · 초안은 맵을 전환해도 유지됩니다.</p><label class="field"><span>연결할 층</span><select id="teleporter-target-map">${Object.values(MAP_CATALOG).filter(m=>m.id!==sourceMapId&&m.editable).map(m=>`<option value="${m.id}" ${m.id===target?.id ? 'selected':''}>${m.label}</option>`).join('')}</select></label><button type="button" class="primary" id="teleporter-place-target">${teleporterStep === TeleporterEndpointSteps.code.B ? '현재 맵에서 B 위치를 클릭하세요' : `B 배치 · ${target?.label ?? '연결 층'}`}</button>`;
      extra.append(wrap);
      wrap.querySelector<HTMLSelectElement>('#teleporter-target-map')!.addEventListener('change', ev => {
        const id = (ev.target as HTMLSelectElement).value;
        ensurePropertyDraft();
        const draft = resourceDraft?.data.kind === 'teleporter' ? resourceDraft.data : r;
        draft.targetMapId = id;
        teleporterStep = TeleporterEndpointSteps.code.B;
        selected = { kind: 'teleporter', id: draft.id };
        if (id === activeMap.id) {
          setTool('teleporter'); inspectorKey = ''; syncEditChrome(); fillInspector(snap()); draw();
        } else void loadActiveMap(id as MapSpec['id']);
      });
      wrap.querySelector<HTMLButtonElement>('#teleporter-place-target')!.addEventListener('click', () => {
        ensurePropertyDraft();
        const id = (wrap.querySelector('#teleporter-target-map') as HTMLSelectElement).value;
        const draft = resourceDraft?.data.kind === 'teleporter' ? resourceDraft.data : r;
        draft.targetMapId = id; teleporterStep = TeleporterEndpointSteps.code.B;
        if (id === activeMap.id) { setTool('teleporter'); inspectorKey = ''; syncEditChrome(); fillInspector(snap()); draw(); }
        else void loadActiveMap(id as MapSpec['id']);
      });
      if (endpoint) {
        const editableEndpoint = (id: string) => { ensurePropertyDraft(); return resourceDraft?.data.kind === 'teleporter' ? resourceDraft.data.endpoints.find((item: any) => item.id === id) ?? endpoint : endpoint; };
        const fields = document.createElement('div'); fields.className = 'teleporter-endpoint-fields';
        const clearing = endpoint.clearingPoint ?? { x: endpoint.position.x + 40, y: endpoint.position.y };
        fields.innerHTML = `<span class="panel-kicker">A ENTRY / EXIT</span><label class="field"><span>진입 방향 · °</span><input id="teleporter-a-entry" type="number" step="1" value="${endpoint.entryTheta * 180 / Math.PI}"></label><label class="field"><span>출구 방향 · °</span><input id="teleporter-a-exit" type="number" step="1" value="${endpoint.exitTheta * 180 / Math.PI}"></label><span class="panel-kicker">A CLEARING POINT · px</span><label class="field"><span>X</span><input id="teleporter-a-clear-x" type="number" step="any" value="${clearing.x}"></label><label class="field"><span>Y</span><input id="teleporter-a-clear-y" type="number" step="any" value="${clearing.y}"></label><button type="button" id="teleporter-a-clear-place" data-teleporter-clear-map="${endpoint.mapId}">지도에서 A clearing 지정</button><span class="panel-kicker">A OCCUPANCY VERTICES · local px</span>${endpoint.occupancyPolygon.map((p: Point, i: number) => `<label class="field"><span>정점 ${i+1}</span><input data-teleporter-a-vertex="${i}" data-axis="x" type="number" step="any" value="${p.x}"><input data-teleporter-a-vertex="${i}" data-axis="y" type="number" step="any" value="${p.y}"></label>`).join('')}`;
        extra.append(fields);
        for (const [id, key] of [['teleporter-a-entry','entryTheta'],['teleporter-a-exit','exitTheta']] as const) fields.querySelector<HTMLInputElement>('#'+id)!.addEventListener('input', e => { const target = editableEndpoint(endpoint.id); target[key] = Number((e.target as HTMLInputElement).value) * Math.PI / 180; });
        fields.querySelector<HTMLInputElement>('#teleporter-a-clear-x')!.addEventListener('input', e => { const target = editableEndpoint(endpoint.id); target.clearingPoint = { ...(target.clearingPoint ?? clearing), x: Number((e.target as HTMLInputElement).value) }; });
        fields.querySelector<HTMLInputElement>('#teleporter-a-clear-y')!.addEventListener('input', e => { const target = editableEndpoint(endpoint.id); target.clearingPoint = { ...(target.clearingPoint ?? clearing), y: Number((e.target as HTMLInputElement).value) }; });
        fields.querySelector<HTMLButtonElement>('#teleporter-a-clear-place')!.addEventListener('click', () => { const target = editableEndpoint(endpoint.id); if (target.mapId !== activeMap.id) { status(`${target.mapId} 맵으로 전환한 뒤 A clearing을 지정하세요.`); return; } teleporterPointMode = { endpointId: target.id }; status('A clearing 지점을 지도에서 클릭하세요.'); });
        fields.querySelectorAll<HTMLInputElement>('[data-teleporter-a-vertex]').forEach(input => input.addEventListener('input', () => { const target = editableEndpoint(endpoint.id); const i = Number(input.dataset.teleporterAVertex), axis = input.dataset.axis as 'x'|'y'; target.occupancyPolygon[i][axis] = Number(input.value); draw(); }));
        const b = (r.endpoints ?? [])[1];
        if (b) {
          const bc = b.clearingPoint ?? { x: b.position.x + 40, y: b.position.y };
          const bfields = document.createElement('div'); bfields.className = 'teleporter-endpoint-fields';
          bfields.innerHTML = `<span class="panel-kicker">B ENTRY / EXIT · ${b.mapId}</span><label class="field"><span>진입 방향 · °</span><input id="teleporter-b-entry" type="number" step="1" value="${b.entryTheta * 180 / Math.PI}"></label><label class="field"><span>출구 방향 · °</span><input id="teleporter-b-exit" type="number" step="1" value="${b.exitTheta * 180 / Math.PI}"></label><span class="panel-kicker">B CLEARING POINT · px</span><label class="field"><span>X</span><input id="teleporter-b-clear-x" type="number" step="any" value="${bc.x}"></label><label class="field"><span>Y</span><input id="teleporter-b-clear-y" type="number" step="any" value="${bc.y}"></label><button type="button" id="teleporter-b-clear-place" data-teleporter-clear-map="${b.mapId}">지도에서 B clearing 지정</button><span class="panel-kicker">B OCCUPANCY VERTICES · local px</span>${b.occupancyPolygon.map((p: Point, i: number) => `<label class="field"><span>정점 ${i+1}</span><input data-teleporter-b-vertex="${i}" data-axis="x" type="number" step="any" value="${p.x}"><input data-teleporter-b-vertex="${i}" data-axis="y" type="number" step="any" value="${p.y}"></label>`).join('')}`;
          extra.append(bfields);
          for (const [id, key] of [['teleporter-b-entry','entryTheta'],['teleporter-b-exit','exitTheta']] as const) bfields.querySelector<HTMLInputElement>('#'+id)!.addEventListener('input', e => { const target = editableEndpoint(b.id); target[key] = Number((e.target as HTMLInputElement).value) * Math.PI / 180; });
          bfields.querySelector<HTMLInputElement>('#teleporter-b-clear-x')!.addEventListener('input', e => { const target = editableEndpoint(b.id); target.clearingPoint = { ...(target.clearingPoint ?? bc), x: Number((e.target as HTMLInputElement).value) }; });
          bfields.querySelector<HTMLInputElement>('#teleporter-b-clear-y')!.addEventListener('input', e => { const target = editableEndpoint(b.id); target.clearingPoint = { ...(target.clearingPoint ?? bc), y: Number((e.target as HTMLInputElement).value) }; });
          bfields.querySelector<HTMLButtonElement>('#teleporter-b-clear-place')!.addEventListener('click', () => { const target = editableEndpoint(b.id); if (target.mapId !== activeMap.id) { status(`${target.mapId} 맵으로 전환한 뒤 B clearing을 지정하세요.`); return; } teleporterPointMode = { endpointId: target.id }; status('B clearing 지점을 지도에서 클릭하세요.'); });
          bfields.querySelectorAll<HTMLInputElement>('[data-teleporter-b-vertex]').forEach(input => input.addEventListener('input', () => { const target = editableEndpoint(b.id); const i = Number(input.dataset.teleporterBVertex), axis = input.dataset.axis as 'x'|'y'; target.occupancyPolygon[i][axis] = Number(input.value); draw(); }));
        }
      }
    }
  }
  if (kind === 'teleporter') {
    for (const [index, endpoint] of (r.endpoints ?? []).entries()) {
      const prefix = index === 0 ? 'a' : 'b';
      const clearing = endpoint.clearingPoint ?? { x: endpoint.position.x + 40, y: endpoint.position.y };
      const values: Record<string, unknown> = {
        [`teleporter-${prefix}-entry`]: endpoint.entryTheta * 180 / Math.PI,
        [`teleporter-${prefix}-exit`]: endpoint.exitTheta * 180 / Math.PI,
        [`teleporter-${prefix}-clear-x`]: clearing.x,
        [`teleporter-${prefix}-clear-y`]: clearing.y,
      };
      endpoint.occupancyPolygon?.forEach((point: Point, vertex: number) => {
        values[`teleporter-${prefix}-vertex-${vertex}-x`] = point.x;
        values[`teleporter-${prefix}-vertex-${vertex}-y`] = point.y;
      });
      for (const [id, value] of Object.entries(values)) {
        const input = extra.querySelector<HTMLInputElement>(`#${id}`);
        if (input && document.activeElement !== input) input.value = String(value);
      }
      endpoint.occupancyPolygon?.forEach((point: Point, vertex: number) => {
        for (const axis of ['x', 'y'] as const) {
          const input = extra.querySelector<HTMLInputElement>(`[data-teleporter-${prefix}-vertex="${vertex}"][data-axis="${axis}"]`);
          if (input && document.activeElement !== input) input.value = String(point[axis]);
        }
      });
    }
  }
  for (const el of extra.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-prop]')) {
    if (document.activeElement !== el) el.value = String(el.dataset.prop === 'stationKind' ? (r.stationKind ?? r.kind ?? 'other') : r[el.dataset.prop!] ?? (el.tagName === 'SELECT' ? '' : 0));
  }
  const geometry = $('geometry-content');
  const rows: [string, string][] = [['맵', activeMap.label], ['고유 ID', r.id]];
  if (kind === 'teleporter') {
    for (const [index, endpoint] of (r.endpoints ?? []).entries()) rows.push([`${index === 0 ? 'A' : 'B'} 엔드포인트`, `${endpoint.id} · ${endpoint.mapId} · (${endpoint.position?.x?.toFixed?.(2) ?? endpoint.x?.toFixed?.(2)}, ${endpoint.position?.y?.toFixed?.(2) ?? endpoint.y?.toFixed?.(2)})`]);
  }
  if (center) rows.push([kind === 'zone' ? '면적 중심 · px' : '위치 · px', `${center.x.toFixed(2)}, ${center.y.toFixed(2)}`]);
  let pts: Point[] = [];
  if (kind === 'zone') {
    pts = r.polygon;
    rows.push(['면적', `${Math.abs(signedArea(pts)).toFixed(2)} px² · ${(Math.abs(signedArea(pts)) * (activeMap.pixelCm / 100) ** 2).toFixed(2)} m²`]);
  } else if (kind === 'rail') pts = r.points;
  else if (kind === 'portal') pts = [{ x: r.ax, y: r.ay }, { x: r.bx, y: r.by }];
  else if (kind === 'edge') {
    pts = r.trajectory?.length ? r.trajectory : [s.nodes.find(n => n.id === r.startNodeId), s.nodes.find(n => n.id === r.endNodeId)].filter(Boolean) as Point[];
    rows.push(['시작 노드', r.startNodeId], ['종료 노드', r.endNodeId], ['회전', '헤딩 속성 · 연결 노드 위치는 유지']);
  }
  if (pts.length) {
    rows.push(['정점 수', String(pts.length)]);
    if (kind !== 'zone') {
      const mid = { x: pts.reduce((n,p) => n+p.x,0)/pts.length, y: pts.reduce((n,p) => n+p.y,0)/pts.length };
      rows.push(['정점 평균 · px', `${mid.x.toFixed(2)}, ${mid.y.toFixed(2)}`]);
    }
    rows.push(['좌표 · px', pts.map((p, i) => `${i+1}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).join('\n')]);
  }
  if (kind === 'obstacle') rows.push(['도형', r.kind], ['크기', `${r.size} px · ${(r.size * activeMap.pixelCm / 100).toFixed(2)} m`]);
  if (r.zoneId) rows.push(['연결 구역', r.zoneId]);
  if (r.waitPose) rows.push(['대기 위치', `${r.waitPose.x}, ${r.waitPose.y} · θ ${r.waitPose.theta} rad`]);
  if (r.mapId) rows.push(['Map ID', r.mapId]);
  if (r.interactionNodeIds?.length) rows.push(['상호작용 노드', r.interactionNodeIds.join(', ')]);
  if (r.actions?.length) rows.push(['노드 액션', JSON.stringify(r.actions, null, 2)]);
  const signature = JSON.stringify(rows);
  if (geometry.dataset.signature !== signature) {
    geometry.dataset.signature = signature; geometry.replaceChildren();
    for (const [label, value] of rows) { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value; geometry.append(dt, dd); }
  }
  $('property-state').textContent = savePending ? '서버에 저장 중…' : draft ? '저장 전 초안 · 지도와 속성에서 조정할 수 있습니다' : readOnly ? '읽기 전용' : '저장된 리소스 · ID는 고정됩니다';
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('#inspect-panel input, #inspect-panel select, #inspect-panel button')) el.disabled = readOnly || !transportConnected || savePending;
  ($('btn-properties-save') as HTMLButtonElement).disabled ||= !draft;
  ($('btn-properties-cancel') as HTMLButtonElement).disabled ||= !draft;
}
function ensurePropertyDraft(): void {
  if (editSession || resourceDraft || !selected) return;
  const r = resourceOf(snap(), selected.kind, selected.id);
  if (!r) return;
  if (['waypoint','charger','obstacle','node','station'].includes(selected.kind)) beginPoseModify(selected.kind as PoseAsset, r.id, r.x, r.y, r.theta, r.size);
  else if (selected.kind === 'zone') beginZoneModify(r as Snapshot['zones'][number], r.polygon);
  else if (selected.kind === 'teleporter') resourceDraft = { mode: EditModes.code.modify, data: { ...r, kind: selected.kind, endpoints: (r.endpoints ?? []).map(teleporterEndpointDraft) } };
  else resourceDraft = { mode: EditModes.code.modify, data: { ...r, kind: selected.kind } };
}
function applyInspector(id: string): void {
  if (!canWriteToLive() || !activeMap.editable || !transportConnected || savePending || selected?.kind === 'robot') return;
  const input = $(id) as HTMLInputElement;
  if (!input.checkValidity() || (input.type === 'number' && input.value === '')) return;
  const value: any = input.type === 'number' || input.type === 'range' ? Number(input.value) : input.value;
  ensurePropertyDraft();
  if (!editSession && !resourceDraft) return;
  const r: any = editSession ?? resourceDraft!.data;
  if (id === 'insp-name') r.name = value;
  else if (id === 'insp-theta-num' || id === 'insp-theta') {
    const theta = Math.atan2(Math.sin(value * Math.PI / 180), Math.cos(value * Math.PI / 180));
    if (editSession?.kind === 'zone') {
      const c = centroid(editSession.polygon), delta = theta - editSession.theta;
      editSession.polygon = editSession.polygon.map(p => ({ x: c.x + (p.x-c.x)*Math.cos(delta) - (p.y-c.y)*Math.sin(delta), y: c.y + (p.x-c.x)*Math.sin(delta) + (p.y-c.y)*Math.cos(delta) }));
      zonePreview = { id: editSession.id!, polygon: editSession.polygon };
    } else if (resourceDraft?.data.kind === 'rail') {
      const pts = resourceDraft.data.points as Point[], c = { x: pts.reduce((n,p)=>n+p.x,0)/pts.length, y: pts.reduce((n,p)=>n+p.y,0)/pts.length }, delta = theta - r.theta;
      r.points = pts.map(p => ({ x: c.x+(p.x-c.x)*Math.cos(delta)-(p.y-c.y)*Math.sin(delta), y: c.y+(p.x-c.x)*Math.sin(delta)+(p.y-c.y)*Math.cos(delta) }));
    }
    r.theta = theta;
  } else if (id === 'insp-x' || id === 'insp-y') {
    const axis = id === 'insp-x' ? 'x' : 'y';
    if (editSession?.kind === 'zone') { const c = centroid(editSession.polygon); editSession.polygon = translatePoly(editSession.polygon, axis === 'x' ? value-c.x : 0, axis === 'y' ? value-c.y : 0); zonePreview = { id: editSession.id!, polygon: editSession.polygon }; }
    else r[axis] = value;
  } else if (id === 'insp-left' || id === 'insp-right') r.corridor = { ...r.corridor, [id === 'insp-left' ? 'leftWidth' : 'rightWidth']: value };
  else {
    const prop = ({'insp-size':'size','insp-factor':'factor','insp-speed':'maximumSpeed','insp-capacity':'capacity'} as Record<string,string>)[id] ?? input.dataset.prop!;
    if (prop === 'stationKind' && editSession) editSession.source = { ...editSession.source, kind: value };
    else if (id.startsWith('prop-') && editSession) editSession.source = { ...editSession.source, [prop]: value };
    else r[prop] = value;
  }
  syncEditChrome(); fillInspector(snap()); draw();
}

async function deleteSelected(): Promise<void> {
  if (!canWriteToLive()) { status("블랙박스 리플레이에서는 삭제할 수 없습니다."); return; }
  if (!activeMap.editable || !transportConnected || savePending || deleteConfirmationPending) return;
  const snapshot = snap();
  const targets = multiSelection.size ? selectedItems().map(({kind,id}) => ({kind,id})) : selected && selected.kind !== 'robot' ? [{ ...selected }] : [];
  if (!targets.length) return;
  const mapId = activeMap.id;
  const draft = inspectorResource(snapshot);
  const items = targets.map(target => {
    const r = resourceOf(snapshot,target.kind,target.id);
    return { ...target, name: (draft?.data.id === target.id ? draft.data.name : r?.name) || target.id };
  });
  deleteConfirmationPending = true;
  let accepted = false;
  try { accepted = await confirmResourceDeletion(items); }
  finally { deleteConfirmationPending = false; }
  if (!accepted) { status('삭제 취소 · 리소스와 편집 내용이 유지됩니다'); return; }
  if (activeMap.id !== mapId || !activeMap.editable || !transportConnected || savePending) { status('연결 또는 맵이 변경되어 삭제를 실행하지 않았습니다'); return; }
  clearEditSession(); clearMulti();
  selectedVertex = null; zoneDrag = null; zonePreview = null;
  const current = snap();
  for (const target of targets) if (resourceOf(current,target.kind,target.id)) {
    if (target.kind === 'teleporter') send('teleporterDelete', { requestId: runtimeRequestId('teleporter-delete'), id: target.id, revision: Number((resourceOf(current, target.kind, target.id) as any)?.revision ?? 0) });
    else send('editorDelete', target);
  }
  selected = null;
  status(`${targets.length}개 리소스 삭제 요청`);
  fillInspector(snap()); renderOutliner(snap()); draw();
}

function closePolygon(): void {
  const spec = ZONE_TOOLS[tool];
  if (!spec || draftPoly.length < 3) {
    lastError = "꼭짓점 3개 이상";
    status(lastError);
    return;
  }
  if (!isSimplePolygon(draftPoly)) {
    lastError = "변이 겹쳤어. Backspace로 마지막 점을 지워";
    status(lastError);
    flashUntil = performance.now() + 280;
    draw();
    return;
  }
  editSession = {
    kind: "zone",
    mode: EditModes.code.create,
    id: newResourceId("zone"),
    family: spec.family,
    zoneKind: spec.zoneKind,
    name: spec.zoneKind,
    polygon: draftPoly.map((p) => ({ ...p })),
    factor: spec.zoneKind === "prefer" || spec.zoneKind === "priority" ? 0.4 : spec.zoneKind === "avoid" || spec.zoneKind === "penalty" ? 3 : undefined,
    maximumSpeed: spec.zoneKind === "speed_limit" ? 0.6 : undefined,
    capacity: spec.zoneKind === "corridor" || spec.zoneKind === "complex" ? 1 : undefined,
    theta: 0,
  };
  draftPoly = [];
  draftCursor = null;
  syncEditChrome();
  status("존 초안 준비됨 · 확인을 눌러 저장");
  draw();
}

function persistZonePoly(id: string, polygon: Point[]): void {
  const z = snap().zones.find((w) => w.id === id);
  if (!z) return;
  if (!isSimplePolygon(polygon)) {
    status("접힌 모양은 저장 안 해");
    flashUntil = performance.now() + 280;
    draw();
    return;
  }
  beginZoneModify(z, polygon);
}

function onPointerDown(e: PointerEvent): void {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* untrusted events and already-released pointers */
  }
  const p = eventPos(e);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    panning = { sx: p.sx, sy: p.sy, cam: { ...cam } };
    return;
  }
  if (savePending) return;
  if (poseOverride?.status === EditSessionStatuses.code.draft) {
    poseOverride.x = p.x;
    poseOverride.y = p.y;
    poseOverride.error = undefined;
    status("테스트 위치 선택됨 · 헤딩을 조정하고 충돌 미리보기를 확인하세요.");
    renderRuntime(snap()); draw();
    return;
  }
  // Teleporter drafts remain interactive on their current endpoint: operators
  // can place clearing points and drag occupancy vertices on the map. The B
  // placement click is handled below; other resource drafts stay guarded.
  if (resourceDraft && resourceDraft.data.kind !== "teleporter") { status("속성 패널에서 저장 또는 취소한 뒤 계속하세요."); return; }
  const s = snap();
  const px = 1 / Math.max(cam.scale, 0.005);

  if (resourceDraft?.data.kind === "teleporter" && teleporterPointMode) {
    const ep = resourceDraft.data.endpoints.find((item: any) => item.id === teleporterPointMode?.endpointId && item.mapId === activeMap.id);
    if (ep) { ep.clearingPoint = { x: p.x, y: p.y }; teleporterPointMode = null; status('clearing 지점이 변경되었습니다.'); fillInspector(snap()); draw(); }
    return;
  }
  if (resourceDraft?.data.kind === "teleporter") {
    const ep = resourceDraft.data.endpoints.find((item: any) => item.mapId === activeMap.id);
    if (ep) {
      const endpointRadius = 18 / Math.max(cam.scale, .01);
      if (Math.hypot(ep.position.x - p.x, ep.position.y - p.y) <= endpointRadius) {
        teleporterEndpointDrag = { endpoint: ep, dx: p.x - ep.position.x, dy: p.y - ep.position.y };
        return;
      }
      const idx = ep.occupancyPolygon.findIndex((q: Point) => Math.hypot(ep.position.x + q.x - p.x, ep.position.y + q.y - p.y) <= 12 / Math.max(cam.scale, .01));
      if (idx >= 0) { teleporterPolyDrag = { endpoint: ep, index: idx }; return; }
    }
  }

  if (tool === 'marquee' && !editSession) {
    if (!e.shiftKey) multiSelection.clear();
    selected = null;
    marquee = { start: p, end: p, additive: e.shiftKey };
    fillInspector(s);
    draw();
    return;
  }

  if (editSession?.kind === "pose") {
    const hit = hitPoseEditor(editSession, p.x, p.y, px);
    if (hit === "rotate") {
      editDrag = EditHandles.code.rotate;
      return;
    }
    if (hit === "body") {
      editDrag = EditHandles.code.body;
      editGrab = { dx: p.x - editSession.x, dy: p.y - editSession.y };
      return;
    }
    if (editSession.asset === "obstacle" && Math.hypot(p.x - editSession.x, p.y - editSession.y) > 12) {
      editDrag = EditHandles.code.size;
      return;
    }
    editDrag = EditHandles.code.body;
    editGrab = { dx: p.x - editSession.x, dy: p.y - editSession.y };
    return;
  }

  if (tool === "select") {
    if (isReplayView()) {
      const replayHit = hitTest(s, p.x, p.y, 24 / Math.max(cam.scale, .01));
      selected = replayHit;
      if (replayHit?.kind === "robot") {
        selectedRobot = replayHit.id;
        $("sel-robot-id").textContent = replayHit.id;
      }
      fillInspector(s); renderOutliner(s); draw();
      return;
    }
    const handle = hitZoneHandle(
      s,
      p.x,
      p.y,
      selected?.kind === "zone" ? selected.id : (editSession?.kind === "zone" ? editSession.id : undefined),
      px,
      editSession?.kind === "zone" ? { id: editSession.id ?? "__draft__", polygon: editSession.polygon } : zonePreview ?? undefined,
    );
    if (handle) {
      const z = s.zones.find((w) => w.id === handle.id);
      if (!z) return;
      const poly = editSession?.kind === "zone" && editSession.id === handle.id
        ? editSession.polygon
        : z.polygon;
      if (!editSession || editSession.kind !== "zone" || editSession.id !== handle.id) {
        beginZoneModify(z, poly);
      }
      selected = { kind: "zone", id: handle.id };
      if (handle.type === "vertex") {
        selectedVertex = handle.index;
        zoneDrag = { type: "vertex", id: handle.id, index: handle.index, poly: (editSession as Extract<EditSession, { kind: "zone" }>).polygon.map((q) => ({ ...q })) };
      } else if (handle.type === "mid") {
        const next = insertVertex((editSession as Extract<EditSession, { kind: "zone" }>).polygon, handle.index, p);
        selectedVertex = handle.index + 1;
        if (editSession?.kind === "zone") editSession.polygon = next;
        zoneDrag = { type: "vertex", id: handle.id, index: handle.index + 1, poly: next };
      } else {
        selectedVertex = null;
        zoneDrag = {
          type: "label",
          id: handle.id,
          origin: (editSession as Extract<EditSession, { kind: "zone" }>).polygon.map((q) => ({ ...q })),
          sx: p.x,
          sy: p.y,
        };
      }
      fillInspector(s);
      renderOutliner(s);
      syncEditChrome();
      draw();
      return;
    }

    const hit = hitTest(s, p.x, p.y, 24 / Math.max(cam.scale, .01));
    selectedVertex = null;
    if (hit?.kind === "robot") {
      selectedRobot = hit.id;
      $("sel-robot-id").textContent = hit.id;
      selected = hit;
      fillInspector(s);
      renderOutliner(s);
      draw();
      return;
    }
    if (hit && (hit.kind === "waypoint" || hit.kind === "charger" || hit.kind === "node" || hit.kind === "station" || hit.kind === "obstacle")) {
      const obj = poseOf(s, hit.kind, hit.id);
      if (obj) {
        const size = hit.kind === "obstacle" ? s.obstacles.find((o) => o.id === hit.id)?.size : undefined;
        beginPoseModify(hit.kind as PoseAsset, hit.id, obj.x, obj.y, obj.theta, size);
        editDrag = EditHandles.code.body;
        editGrab = { dx: p.x - obj.x, dy: p.y - obj.y };
        fillInspector(s);
        renderOutliner(s);
        return;
      }
    }
    if (hit?.kind === "zone") {
      const z = s.zones.find((w) => w.id === hit.id);
      if (z) {
        beginZoneModify(z, z.polygon);
        zoneDrag = { type: 'label', id: z.id, origin: z.polygon.map(q => ({ ...q })), sx: p.x, sy: p.y };
      }
      fillInspector(s);
      renderOutliner(s);
      return;
    }
    if (hit?.kind === "teleporter") {
      const teleporter = s.teleporters.find(item => item.id === hit.id);
      if (teleporter) {
        resourceDraft = { mode: EditModes.code.modify, data: { ...teleporter, kind: "teleporter", endpoints: (teleporter.endpoints ?? []).map(teleporterEndpointDraft) } };
        selected = hit;
        const endpoint = resourceDraft.data.endpoints.find((item: any) => item.mapId === activeMap.id);
        if (endpoint && Math.hypot(endpoint.position.x - p.x, endpoint.position.y - p.y) <= 18 / Math.max(cam.scale, .01)) {
          teleporterEndpointDrag = { endpoint, dx: p.x - endpoint.position.x, dy: p.y - endpoint.position.y };
        }
        setTool("teleporter");
        syncEditChrome();
        fillInspector(snap());
        renderOutliner(snap());
        draw();
        return;
      }
    }
    if (editSession) cancelEdit();
    selected = hit;
    if (hit && hit.kind !== "edge" && hit.kind !== "zone" && hit.kind !== "portal" && hit.kind !== "rail") {
      const obj = poseOf(s, hit.kind, hit.id);
      if (obj) dragging = { kind: hit.kind, id: hit.id, dx: p.x - obj.x, dy: p.y - obj.y };
    }
    fillInspector(s);
    renderOutliner(s);
    draw();
    return;
  }

  if (tool === "move") {
    if (!selectedRobot) {
      status("로봇을 먼저 선택해");
      return;
    }
    if (!canDispatchRobot(selectedRobotView())) {
      status(selectedRobot + " 운영 제어가 준비되지 않아 명령을 보낼 수 없어");
      return;
    }
    const wp = s.waypoints.find((w) => Math.hypot(w.x - p.x, w.y - p.y) < 14);
    const tp = s.teleporters.flatMap(t => t.endpoints.map(ep => ({ t, ep }))).find(({ ep }) => Math.hypot(ep.x - p.x, ep.y - p.y) < 16 && ep.mapId === s.mapId);
    if (tp) {
      send("commandRobot", { robotId: selectedRobot, kind: "teleporter", targetId: tp.t.id, endpointId: tp.ep.id });
      status(`${selectedRobot} 텔레포터 이동 명령 전송 · ${tp.t.name || tp.t.id}`);
      return;
    }
    if (wp) {
      send("commandRobot", { robotId: selectedRobot, kind: "move", targetId: wp.id });
      status(`${selectedRobot} 이동 명령 전송 · ${wp.id}`);
    }
    else {
      poseDraft = { x: p.x, y: p.y, theta: 0 };
    }
    return;
  }
  if (tool === "dock") {
    if (!selectedRobot) {
      status("로봇을 먼저 선택해");
      return;
    }
    if (!canDispatchRobot(selectedRobotView())) {
      status(selectedRobot + " 운영 제어가 준비되지 않아 명령을 보낼 수 없어");
      return;
    }
    const cs = s.chargers.find((w) => Math.hypot(w.x - p.x, w.y - p.y) < 14);
    if (cs) {
      send("commandRobot", { robotId: selectedRobot, kind: "dock", targetId: cs.id });
      status(`${selectedRobot} 도킹 명령 전송 · ${cs.id}`);
    }
    else status("충전소를 찍어");
    return;
  }

  if (tool === "waypoint" || tool === "charger" || tool === "node" || tool === "station") {
    if (!isFree(p.x, p.y) && tool !== "station") {
      flashUntil = performance.now() + 250;
      status("흰 바닥에만 놓을 수 있어");
      draw();
      return;
    }
    beginPoseCreate(tool, p.x, p.y, 0);
    return;
  }

  if (tool === "obstacle") {
    beginPoseCreate("obstacle", p.x, p.y, 0, 16);
    return;
  }

  if (tool === "teleporter" && resourceDraft?.data.kind === "teleporter" && teleporterStep === TeleporterEndpointSteps.code.B) {
    const d = resourceDraft.data;
    const a = d.endpoints[0];
    d.endpoints[1] = { id: newResourceId("teleporter-endpoint"), mapId: activeMap.id, position: { x: p.x, y: p.y }, entryTheta: 0, exitTheta: 0, occupancyPolygon: defaultTeleporterPolygon(p.x, p.y), clearingPoint: { x: p.x + 40, y: p.y } };
    teleporterStep = TeleporterEndpointSteps.code.A;
    status("B 출구 초안 준비됨 · 양 끝을 확인하고 저장하세요");
    inspectorKey = ""; syncEditChrome(); fillInspector(snap()); draw();
    return;
  }
  if (tool === "teleporter") {
    if (!resourceDraft) beginTeleporterCreate(p.x, p.y);
    return;
  }

  if (ZONE_TOOLS[tool]) {
    if (editSession?.kind === "zone" && editSession.mode === EditModes.code.create) {
      status("먼저 확인하거나 취소해");
      return;
    }
    if (draftPoly.length >= 3) {
      const first = draftPoly[0];
      const closeR = 10 / Math.max(cam.scale, 0.005);
      if (Math.hypot(p.x - first.x, p.y - first.y) <= closeR) {
        closePolygon();
        return;
      }
    }
    if (!canAppendVertex(draftPoly, p)) {
      status("변이 겹치려 해. Backspace로 마지막 점을 지워");
      flashUntil = performance.now() + 250;
      draw();
      return;
    }
    draftPoly.push({ x: p.x, y: p.y });
    draftCursor = { x: p.x, y: p.y };
    status(draftPoly.length < 3 ? `꼭짓점 ${draftPoly.length} · 3개 이상` : `꼭짓점 ${draftPoly.length} · 첫 점 클릭 또는 Enter`);
    syncEditChrome();
    draw();
    return;
  }
  if (tool === "rail") {
    draftLine.push({ x: p.x, y: p.y });
    draw();
    return;
  }
  if (tool === "portal") {
    if (draftLine.length === 0) draftLine = [{ x: p.x, y: p.y }];
    else {
      const a = draftLine[0];
      const zoneId = selected?.kind === "zone" ? selected.id : s.zones[0]?.id;
      if (!zoneId) status("존을 먼저 만들어");
      else beginResourceCreate({ kind: "portal", zoneId, ax: a.x, ay: a.y, bx: p.x, by: p.y });
      draftLine = [];
    }
    draw();
    return;
  }
  if (tool === "edge") {
    const n = s.nodes.find((nd) => Math.hypot(nd.x - p.x, nd.y - p.y) < 12);
    if (!n) {
      status("노드를 찍어");
      return;
    }
    if (!edgeStart) {
      edgeStart = n.id;
      status(`시작 ${n.id}`);
    } else if (edgeStart !== n.id) {
      beginResourceCreate({ kind: "edge", startNodeId: edgeStart, endNodeId: n.id, trajectory: [], corridor: { leftWidth: 0.6, rightWidth: 0.6, corridorReferencePoint: "KINEMATIC_CENTER", releaseRequired: false, releaseLossBehavior: "STOP" }, maximumSpeed: 0 });
      edgeStart = null;
    }
  }
}

function poseOf(s: Snapshot, kind: string, id: string): { x: number; y: number; theta: number } | null {
  const lists: Record<string, { id: string; x: number; y: number; theta: number }[]> = {
    waypoint: s.waypoints,
    charger: s.chargers,
    node: s.nodes,
    station: s.stations,
    obstacle: s.obstacles,
    robot: s.robots,
  };
  return lists[kind]?.find((w) => w.id === id) ?? null;
}

function onPointerMove(e: PointerEvent): void {
  const p = eventPos(e);
  $("cursor-pos").textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}`;
  if (teleporterPolyDrag && (e.buttons & 1)) { const ep = teleporterPolyDrag.endpoint; ep.occupancyPolygon[teleporterPolyDrag.index] = { x: p.x - ep.position.x, y: p.y - ep.position.y }; fillInspector(snap()); draw(); return; }
  if (teleporterEndpointDrag && (e.buttons & 1)) {
    const ep = teleporterEndpointDrag.endpoint;
    const old = { ...ep.position };
    ep.position = { x: p.x - teleporterEndpointDrag.dx, y: p.y - teleporterEndpointDrag.dy };
    const dx = ep.position.x - old.x, dy = ep.position.y - old.y;
    ep.clearingPoint = { x: (ep.clearingPoint?.x ?? old.x + 40) + dx, y: (ep.clearingPoint?.y ?? old.y) + dy };
    fillInspector(snap()); draw(); return;
  }
  if (ZONE_TOOLS[tool] && draftPoly.length) {
    draftCursor = { x: p.x, y: p.y };
    if (!(e.buttons & 1) && !panning && !dragging && !zoneDrag && !editDrag) {
      syncEditChrome();
      draw();
    }
  }
  if (panning) {
    cam = { ...panning.cam, x: panning.cam.x + (p.sx - panning.sx), y: panning.cam.y + (p.sy - panning.sy) };
    draw();
    return;
  }
  if (marquee) {
    marquee.end = p;
    draw();
    return;
  }
  if (editSession?.kind === "pose" && editDrag && (e.buttons & 1)) {
    if (editDrag === EditHandles.code.rotate) {
      editSession.theta = Math.atan2(p.y - editSession.y, p.x - editSession.x);
    } else if (editDrag === EditHandles.code.size) {
      editSession.size = clampObstacleSize(Math.hypot(p.x - editSession.x, p.y - editSession.y));
      editSession.theta = Math.atan2(p.y - editSession.y, p.x - editSession.x);
    } else if (editDrag === EditHandles.code.body) {
      editSession.x = p.x - (editGrab?.dx ?? 0);
      editSession.y = p.y - (editGrab?.dy ?? 0);
    }
    syncEditChrome();
    draw();
    return;
  }
  if (zoneDrag && (e.buttons & 1)) {
    if (zoneDrag.type === "vertex") {
      const next = replaceVertex(zoneDrag.poly, zoneDrag.index, p);
      if (editSession?.kind === "zone") editSession.polygon = next;
      zonePreview = { id: zoneDrag.id, polygon: next };
      canvas.style.cursor = "move";
    } else {
      const next = translatePoly(zoneDrag.origin, p.x - zoneDrag.sx, p.y - zoneDrag.sy);
      if (editSession?.kind === "zone") editSession.polygon = next;
      zonePreview = { id: zoneDrag.id, polygon: next };
      canvas.style.cursor = "grabbing";
    }
    syncEditChrome();
    draw();
    return;
  }
  if (dragging && (e.buttons & 1)) {
    const x = p.x - dragging.dx;
    const y = p.y - dragging.dy;
    if (dragging.kind === "waypoint" || dragging.kind === "charger") {
      send("moveAsset", { kind: dragging.kind, id: dragging.id, x, y });
    } else if (dragging.kind === "obstacle") {
      const o = snap().obstacles.find((w) => w.id === dragging!.id);
      send("moveObstacle", { id: dragging.id, x, y, size: o?.size, theta: o?.theta });
    } else if (dragging.kind === "node" || dragging.kind === "station") {
      const o = poseOf(snap(), dragging.kind, dragging.id);
      send("editorUpsert", { kind: dragging.kind, id: dragging.id, x, y, theta: o?.theta ?? 0 });
    }
    return;
  }
  if (poseDraft && (e.buttons & 1)) {
    poseDraft.theta = Math.atan2(p.y - poseDraft.y, p.x - poseDraft.x);
    draw();
    return;
  }
  if (tool === "select" && !(e.buttons & 1) && !editSession) {
    const px = 1 / Math.max(cam.scale, 0.005);
    const handle = hitZoneHandle(snap(), p.x, p.y, selected?.kind === "zone" ? selected.id : undefined, px, zonePreview ?? undefined);
    canvas.style.cursor = handle?.type === "label" ? "grab" : handle ? "move" : "";
  } else if (editSession?.kind === "pose") {
    const px = 1 / Math.max(cam.scale, 0.005);
    const hit = hitPoseEditor(editSession, p.x, p.y, px);
    canvas.style.cursor = hit === "rotate" ? "crosshair" : hit ? "move" : "";
  }
}

function onPointerUp(e: PointerEvent): void {
  const p = eventPos(e);
  if (teleporterEndpointDrag) { teleporterEndpointDrag = null; fillInspector(snap()); syncEditChrome(); draw(); return; }
  if (teleporterPolyDrag) { teleporterPolyDrag = null; fillInspector(snap()); draw(); return; }
  if (panning) {
    panning = null;
    return;
  }
  if (marquee) {
    const found = enclosed(selectionItems(snap(), layers), rectangle(marquee.start, p));
    for (const item of found) multiSelection.add(selectionKey(item));
    marquee = null;
    fillInspector(snap());
    renderOutliner(snap());
    document.querySelector<HTMLButtonElement>('[data-detail="properties"]')?.click();
    status(`${selectedItems().length}개 선택 · Shift 드래그로 추가 · Delete 삭제`);
    draw();
    return;
  }
  if (editDrag) {
    editDrag = null;
    editGrab = null;
    syncEditChrome();
    draw();
    return;
  }
  if (zoneDrag) {
    if (editSession?.kind === "zone") {
      /* keep session until Confirm */
    } else if (zonePreview) {
      persistZonePoly(zoneDrag.id, zonePreview.polygon);
    }
    zoneDrag = null;
    canvas.style.cursor = "";
    syncEditChrome();
    draw();
    return;
  }
  dragging = null;
  if (!poseDraft) return;
  const theta = poseDraft.theta;
  if (tool === "move" && selectedRobot) {
    send("commandRobot", { robotId: selectedRobot, kind: "move", x: poseDraft.x, y: poseDraft.y, theta });
    status(`${selectedRobot} 이동 명령 전송 · 지정 위치`);
  }
  poseDraft = null;
  draw();
}

function bindUi(): void {
  mountWorkspace();
  document.getElementById('blackbox-clear')?.addEventListener('click', () => void clearBlackboxRecords());
  document.getElementById('robot-motion-pause')?.addEventListener('click', () => requestMotionPause(true));
  document.getElementById('robot-motion-resume')?.addEventListener('click', () => requestMotionPause(false));
  document.getElementById('robot-events-open')?.addEventListener('click', openRobotEvents);
  document.getElementById('robot-events-close')?.addEventListener('click', closeRobotEvents);
  document.getElementById('robot-events-follow')?.addEventListener('change', event => {
    robotEventsFollow = (event.target as HTMLInputElement).checked;
    if (!robotEventsFollow) {
      let cancelledLive = false;
      for (const [requestId, query] of robotEventsQuery) if (!query.history) { robotEventsQuery.delete(requestId); cancelledLive = true; }
      if (cancelledLive) { if (robotEventsRequestTimer) clearTimeout(robotEventsRequestTimer); robotEventsRequestTimer = null; robotEventsLoading = false; }
    }
    if (robotEventsFollow && robotEventsVisible) queryRobotEvents(false);
    renderRobotEvents();
  });
  const restartRobotEventQuery = () => {
    if (!robotEventsVisible) return;
    if (robotEventsRequestTimer) clearTimeout(robotEventsRequestTimer);
    robotEventsRequestTimer = null;
    robotEventsGeneration += 1; robotEventsQuery.clear(); robotEventsLoading = false; robotEventsCursor = '';
    robotEventsAsOf = Date.now(); robotEventsHistoryToMs = robotEventsAsOf;
    const range = Number((document.getElementById('robot-events-range') as HTMLSelectElement | null)?.value || 24 * 60 * 60 * 1000);
    robotEventsHistoryFromMs = robotEventsHistoryToMs - (Number.isFinite(range) && range > 0 ? range : 24 * 60 * 60 * 1000); robotEventsFromMs = Date.now() - 60 * 1000; robotEvents = []; selectedRobotEventId = '';
    robotEventsGap = false; robotEventsTruncated = false; robotEventsStatus = '필터 적용 중…';
    renderRobotEvents(); queryRobotEvents(true);
  };
  document.getElementById('robot-events-robot')?.addEventListener('change', restartRobotEventQuery);
  document.getElementById('robot-events-range')?.addEventListener('change', restartRobotEventQuery);
  document.getElementById('robot-events-level')?.addEventListener('change', restartRobotEventQuery);
  document.getElementById('robot-events-category')?.addEventListener('change', restartRobotEventQuery);
  document.getElementById('robot-events-more')?.addEventListener('click', () => queryRobotEvents(true));
  document.getElementById('robot-events-copy')?.addEventListener('click', async () => {
    const detail = document.getElementById('robot-events-detail');
    if (!detail?.textContent) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(detail.textContent); copied = true; }
      else {
        const textarea = document.createElement('textarea'); textarea.value = detail.textContent; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0';
        document.body.append(textarea); textarea.select(); copied = document.execCommand('copy'); textarea.remove();
      }
    } catch { copied = false; }
    status(copied ? '이벤트 JSON을 복사했습니다.' : '이벤트 JSON을 복사하지 못했습니다. 내용을 직접 선택해 복사하세요.');
  });
  document.getElementById('robot-events-trace')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement;
    const selected = selectedRobotEvent();
    if (!selected?.operationId) return;
    const generation = robotEventsGeneration;
    button.disabled = true;
    try {
      const response = await blackboxChannel.loadOperationTrace(selected.operationId, undefined, { mapId: selected.mapId });
      if (!robotEventsVisible || generation !== robotEventsGeneration || selected.eventId !== selectedRobotEventId) return;
      robotEventTrace = { eventId: selected.eventId, response };
      renderRobotEventDetail();
    } catch (error) {
      status(`관련 trace 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
    } finally { if (robotEventsVisible && generation === robotEventsGeneration) button.disabled = !selectedRobotEvent()?.operationId; }
  });
  document.getElementById("blackbox-toggle")?.addEventListener("click", () => {
    if (isReplayView()) void exitBlackbox();
    else void enterBlackbox();
  });
  document.getElementById("blackbox-load")?.addEventListener("click", () => void loadSelectedBlackboxReplay());
  document.getElementById("blackbox-more")?.addEventListener("click", async () => {
    if (!isReplayView() || !blackboxChannel.hasMoreCandidates) return;
    const generation = blackboxChannel.generation;
    try {
      await blackboxChannel.loadCandidates(activeMap.id, blackboxAsOf, false);
      if (!isReplayView() || generation !== blackboxChannel.generation) return;
      updateBlackboxCandidates();
      status("블랙박스 이벤트를 더 불러왔습니다.");
    } catch (error) {
      if (!isReplayView() || generation !== blackboxChannel.generation) return;
      status(`블랙박스 추가 이벤트 조회 오류: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  document.getElementById("blackbox-start-event")?.addEventListener("change", () => {
    updateBlackboxCandidates();
    const event = selectedBlackboxBoundary((document.getElementById("blackbox-start-event") as HTMLSelectElement).value);
    if (event) renderBlackboxEvent(event);
  });
  document.getElementById("blackbox-end-event")?.addEventListener("change", () => {
    updateBlackboxCandidates();
    const event = selectedBlackboxBoundary((document.getElementById("blackbox-end-event") as HTMLSelectElement).value);
    if (event) renderBlackboxEvent(event);
  });
  document.getElementById("blackbox-start-range")?.addEventListener("input", () => syncBlackboxRange(TimeRangeBounds.code.start));
  document.getElementById("blackbox-end-range")?.addEventListener("input", () => syncBlackboxRange(TimeRangeBounds.code.end));
  document.getElementById("blackbox-play")?.addEventListener("click", () => {
    if (!isReplayView()) return;
    if (blackboxChannel.playing) blackboxChannel.pause(); else blackboxChannel.play();
  });
  document.getElementById("blackbox-step-back")?.addEventListener("click", () => { if (isReplayView()) blackboxChannel.step(-1); });
  document.getElementById("blackbox-step-forward")?.addEventListener("click", () => { if (isReplayView()) blackboxChannel.step(1); });
  document.getElementById("blackbox-seek")?.addEventListener("input", event => { if (isReplayView()) blackboxChannel.seek(Number((event.target as HTMLInputElement).value)); });
  document.getElementById("blackbox-speed")?.addEventListener("change", event => blackboxChannel.setSpeed(Number((event.target as HTMLSelectElement).value)));
  updateBlackboxUi();
  $('map-render-style').addEventListener('click', () => {
    blueprintEnabled = !blueprintEnabled;
    $('map-render-style').setAttribute('aria-pressed', String(blueprintEnabled));
    $('map-render-style').textContent = blueprintEnabled ? '청사진' : '원본 도면'; draw();
  });
  const overview = $('overview-map') as HTMLCanvasElement;
  overview.addEventListener('pointerdown', e => {
    const bounds = overview.getBoundingClientRect();
    const x = (e.clientX-bounds.left)/bounds.width*activeMap.width, y=(e.clientY-bounds.top)/bounds.height*activeMap.height;
    cam.x = viewport.clientWidth/2-x*cam.scale; cam.y=viewport.clientHeight/2-y*cam.scale; draw();
  });
  overview.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') { e.preventDefault(); fit(); } });
  const batch = document.createElement('section');
  batch.id = 'multi-panel';
  batch.hidden = true;
  batch.innerHTML = '<h3 id="multi-count"></h3><p id="multi-summary"></p><button type="button" id="multi-fit">선택 항목에 화면 맞춤</button><button type="button" id="multi-clear">선택 해제</button><button type="button" id="multi-delete" class="danger">선택 항목 삭제</button>';
  document.querySelector('.inspector-section')!.prepend(batch);
  $('multi-fit').addEventListener('click', fitSelection);
  $('multi-delete').addEventListener('click', deleteSelected);
  $('multi-clear').addEventListener('click', () => { clearMulti(); fillInspector(snap()); renderOutliner(snap()); draw(); });
  const releaseDrag = () => {
    marquee = null;
    panning = null;
    dragging = null;
    editDrag = null;
    editGrab = null;
    zoneDrag = null;
    spaceDown = false;
    updateCanvasCursor();
  };
  canvas.addEventListener('pointercancel', releaseDrag);
  window.addEventListener('blur', releaseDrag);
  $("view-fit").addEventListener('click', fit);
  for (const [id, factor] of [["view-in", 1.2], ["view-out", 1 / 1.2]] as const) {
    $(id).addEventListener('click', () => {
      cam = zoomAt(cam, viewport.clientWidth / 2, viewport.clientHeight / 2, factor);
      draw();
    });
  }
  document.body.dataset.mode = AppModes.code.operate;
  addTool($("tools-operate"), "select", "Select", "V");
  addTool($("tools-operate"), "move", "Move", "M");
  addTool($("tools-operate"), "dock", "Dock", "D");
  addTool($("tools-scene"), "select", "Select", "V");
  addTool($("tools-scene"), "waypoint", "Waypoint", "W");
  addTool($("tools-scene"), "charger", "Charger", "C");
  addTool($("tools-scene"), "obstacle", "Obstacle", "O");
  addTool($("tools-scene"), "teleporter", "Teleporter");
  for (const kind of SCENE_ZONE_KINDS) addTool($("tools-scene"), kind, kind);
  addTool($("tools-vda-graph"), "select", "Select", "V");
  addTool($("tools-vda-graph"), "node", "Node", "N");
  addTool($("tools-vda-graph"), "edge", "Edge", "E");
  addTool($("tools-vda-graph"), "station", "Station");
  addTool($("tools-vda-zone"), "blocked", "BLOCKED");
  addTool($("tools-vda-zone"), "release", "RELEASE");
  addTool($("tools-vda-zone"), "line_guided", "LINE_GUIDED");
  addTool($("tools-vda-zone"), "speed_limit", "SPEED_LIMIT");
  addTool($("tools-vda-zone"), "priority", "PRIORITY");
  addTool($("tools-vda-zone"), "penalty", "PENALTY");
  addTool($("tools-vda-zone"), "directed", "DIRECTED");
  addTool($("tools-vda-zone"), "bidirected", "BIDIRECTED");
  addTool($("tools-vda-zone"), "replanning", "REPLAN");
  addTool($("tools-vda-zone"), "action_zone", "ACTION");
  addTool($("tools-vda-aux"), "portal", "Portal");
  addTool($("tools-vda-aux"), "rail", "Rail");
  addTool($("tools-vda-aux"), "teleporter", "Teleporter");
  addTool($("tools-view"), "grid", "Grid", "G");
  addTool($("tools-view"), "marquee", "영역 선택", "B");

  for (const b of document.querySelectorAll<HTMLButtonElement>("#modes button")) {
    b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
  }
  document.querySelector<HTMLSelectElement>("#map-select")?.addEventListener("change", (ev) => {
    void loadActiveMap((ev.target as HTMLSelectElement).value as MapSpec["id"]);
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-shape]")) {
    b.addEventListener("click", () => {
      obstacleShape = parseObstacleKind(b.dataset.shape ?? "") ?? "square";
      for (const x of document.querySelectorAll<HTMLButtonElement>("[data-shape]")) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      }
    });
  }
  $("ly-zones").addEventListener("change", (ev) => {
    layers.zones = (ev.target as HTMLInputElement).checked;
    draw();
  });
  $("ly-graph").addEventListener("change", (ev) => {
    layers.graph = (ev.target as HTMLInputElement).checked;
    draw();
  });
  $("ly-corridor").addEventListener("change", (ev) => {
    layers.corridor = (ev.target as HTMLInputElement).checked;
    draw();
  });
  $("ly-scene").addEventListener("change", (ev) => {
    layers.scene = (ev.target as HTMLInputElement).checked;
    draw();
  });
  $("ly-robots").addEventListener("change", (ev) => {
    layers.robots = (ev.target as HTMLInputElement).checked;
    draw();
  });
  $("btn-delete").addEventListener("click", deleteSelected);
  $("btn-cancel").addEventListener("click", () => {
    if (selectedRobot) {
      send("cancelRobot", { robotId: selectedRobot });
      status(`${selectedRobot} 정지 명령 전송`);
    }
  });
  $("btn-edit-cancel").addEventListener("click", () => cancelEdit());
  $("btn-edit-confirm").addEventListener("click", () => confirmEdit());
  for (const id of ["insp-x", "insp-y", "insp-theta-num", "insp-size", "insp-name", "insp-factor", "insp-speed", "insp-capacity", "insp-left", "insp-right"]) {
    $(id).addEventListener("input", () => applyInspector(id));
  }
  $("insp-theta").addEventListener("input", () => applyInspector('insp-theta'));
  $('btn-properties-save').addEventListener('click', confirmEdit);
  $('btn-properties-cancel').addEventListener('click', cancelEdit);
  $('inspect-panel').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); (document.activeElement as HTMLElement)?.blur(); }
  });

  for (const [event, handler] of [['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp]] as const) {
    canvas.addEventListener(event, e => {
      const p = eventPos(e);
      cursorScreen = { x: p.sx, y: p.sy };
      handler(e);
      updateCanvasCursor();
    });
  }
  canvas.addEventListener('pointerleave', () => { cursorScreen = null; updateCanvasCursor(); });
  canvas.addEventListener("dblclick", (ev) => {
    if (!ZONE_TOOLS[tool]) return;
    ev.preventDefault();
    if (draftPoly.length >= 3) closePolygon();
  });
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    cam = zoomAt(cam, ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    draw();
  }, { passive: false });

  window.addEventListener("keydown", (ev) => {
    if (document.querySelector("dialog[open]")) return;
    if ((ev.target as HTMLElement).closest('input, select, textarea, [contenteditable="true"]')) return;
    if (ev.key === " " ) {
      spaceDown = true;
      ev.preventDefault();
    }
    if (ev.key.toLowerCase() === 'b' && !editSession) setTool('marquee');
    if (editSession?.kind === "pose") {
      if (ev.key === "q" || ev.key === "Q") {
        rotateEdit(-Math.PI / 12);
        ev.preventDefault();
        return;
      }
      if (ev.key === "e" || ev.key === "E") {
        rotateEdit(Math.PI / 12);
        ev.preventDefault();
        return;
      }
      if (ev.key === "[") {
        rotateEdit(-Math.PI / 36);
        ev.preventDefault();
        return;
      }
      if (ev.key === "]") {
        rotateEdit(Math.PI / 36);
        ev.preventDefault();
        return;
      }
    }
    if (ev.key === "v" || ev.key === "V") {
      if (!editSession) setTool("select");
    }
    if (ev.key === "m" || ev.key === "M") if (mode === AppModes.code.operate && !editSession) setTool("move");
    if (ev.key === "d" || ev.key === "D") if (mode === AppModes.code.operate && !editSession) setTool("dock");
    if (ev.key === "w" || ev.key === "W") if (mode === AppModes.code.scene && !editSession) setTool("waypoint");
    if (ev.key === "c" || ev.key === "C") if (mode === AppModes.code.scene && !editSession) setTool("charger");
    if (ev.key === "o" || ev.key === "O") if (mode === AppModes.code.scene && !editSession) setTool("obstacle");
    if (ev.key === "n" || ev.key === "N") if (mode === AppModes.code.vda && !editSession) setTool("node");
    if ((ev.key === "e" || ev.key === "E") && mode === AppModes.code.vda && !editSession) setTool("edge");
    if (ev.key === "g" || ev.key === "G") {
      if (editSession) return;
      occLayer = occLayer === OccupancyLayers.code.off ? OccupancyLayers.code.occupancy : occLayer === OccupancyLayers.code.occupancy ? OccupancyLayers.code.inflated : OccupancyLayers.code.off;
      occOverlay = buildOccOverlay();
      $("occ-legend").hidden = occLayer === OccupancyLayers.code.off;
      $("occ-legend-clearance").hidden = occLayer !== OccupancyLayers.code.inflated;
      draw();
    }
    if (ev.key === "Enter") {
      if (editSession || resourceDraft) {
        confirmEdit();
        ev.preventDefault();
        return;
      }
      if (ZONE_TOOLS[tool] && draftPoly.length >= 3) {
        closePolygon();
        ev.preventDefault();
        return;
      }
      if (tool === "rail" && draftLine.length >= 2) {
        const z = snap().zones.find(z => selected?.kind === "zone" && z.id === selected.id) ?? snap().zones[0];
        if (!z) { status("레일을 연결할 구역을 먼저 생성하세요."); return; }
        beginResourceCreate({ kind: "rail", zoneId: z.id, points: [...draftLine] });
        draftLine = [];
      }
    }
    if (ev.key === "Escape") {
      if (poseOverride?.status === EditSessionStatuses.code.draft) { clearPoseOverride("테스트 위치 지정 취소"); ev.preventDefault(); return; }
      clearMulti();
      fillInspector(snap());
      renderOutliner(snap());
      cancelEdit();
      draftLine = [];
      edgeStart = null;
      poseDraft = null;
      draw();
    }
    if ((ev.key === "Delete" || ev.key === "Backspace")) {
      if (ev.key === "Backspace" && draftPoly.length) {
        draftPoly.pop();
        status(draftPoly.length ? `꼭짓점 ${draftPoly.length}` : "점 전부 지웠어");
        ev.preventDefault();
        syncEditChrome();
        draw();
        return;
      }
      if (ev.key === "Backspace" && editSession?.kind === "zone" && selectedVertex != null) {
        const next = removeVertex(editSession.polygon, selectedVertex);
        if (!next) status("꼭짓점은 3개 이상 남겨");
        else {
          editSession.polygon = next;
          zonePreview = editSession.id ? { id: editSession.id, polygon: next } : null;
          selectedVertex = null;
          syncEditChrome();
          draw();
        }
        ev.preventDefault();
        return;
      }
      if (selected || multiSelection.size) { ev.preventDefault(); deleteSelected(); }
    }
    if (!editSession) {
      if (ev.key === "1") setMode(AppModes.code.operate);
      if (ev.key === "2") setMode(AppModes.code.scene);
      if (ev.key === "3") setMode(AppModes.code.vda);
    }
    if (ev.key === "0") fit();
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === " ") spaceDown = false;
  });
  window.addEventListener("resize", () => {
    resize();
  });
  new ResizeObserver(resize).observe(viewport);
}

async function connect(): Promise<void> {
  if (viewSource === ViewSources.code.live) setConn("connecting", "connecting");
  if (!activeMap.serverPort || mapLoading) return;
  const generation = ++connectionGeneration;
  const client = new Client(`ws://${location.hostname}:${activeMap.serverPort}`);
  let joinedRoom: Room;
  try { joinedRoom = await client.joinOrCreate(ROOM_NAME); }
  catch (err) { if (generation !== connectionGeneration) return; throw err; }
  if (generation !== connectionGeneration) { if (joinedRoom.connection.isOpen) void joinedRoom.leave().catch(() => {}); return; }
  room = joinedRoom;
  transportConnected = true;
  reconnectDelayMs = 1500;
  if (viewSource === ViewSources.code.live) { setConn("online", "online"); status("연결됨 · 1 운용 / 2 현장 / 3 VDA"); }
  const resetConnection = (reason: string) => {
    if (room !== joinedRoom) return;
    room = null;
    transportConnected = false;
    savePending = false;
    runtimePending.clear();
    runtimeRequests.clear();
    poseOverrideRequests.clear(); poseOverride = null;
    for (const timer of runtimeTimers.values()) clearTimeout(timer);
    runtimeTimers.clear();
    resetRobotEvents();
    if (joinedRoom.connection.isOpen) void joinedRoom.leave().catch(() => {});
    if (viewSource === ViewSources.code.live) {
      selectedRobot = "";
      $("sel-robot-id").textContent = "—";
      setConn("offline", "offline");
      status(reason);
      renderRobots(snap());
      fillInspector(snap());
      draw();
    }
    scheduleReconnect();
  };
  const refresh = () => {
    if (room !== joinedRoom) return;
    const state = snapshotFromState(joinedRoom.state as Record<string, unknown>);
    liveChannel.publish({ ...state, mapId: activeMap.id });
  };
  joinedRoom.onStateChange(refresh);
  joinedRoom.onMessage('editorAck', (msg: { kind: string; id: string; action: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    if (msg.action === 'upsert' && savePending) {
      savePending = false;
      selected = { kind: msg.kind, id: msg.id };
      clearEditSession(); draftPoly = []; draftLine = []; draftCursor = null;
      status('리소스 저장 완료'); fillInspector(snap()); renderOutliner(snap()); draw();
    } else if (msg.action === 'delete') status('리소스 삭제 완료');
  });
  joinedRoom.onMessage('teleporterAck', (msg: { requestId?: string; ok?: boolean; id?: string; message?: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    if (msg.ok === false) { savePending = false; status(msg.message ?? '텔레포터 저장 실패'); fillInspector(snap()); return; }
    savePending = false;
    selected = { kind: 'teleporter', id: msg.id ?? resourceDraft?.data.id ?? '' };
    clearEditSession(); draftPoly = []; draftLine = []; draftCursor = null;
    // Saving finishes placement. Keep the saved resource selected, but leave
    // the creation tool so a direct click on its endpoint starts modification
    // instead of silently beginning another teleporter draft.
    setTool('select');
    status('텔레포터 저장 완료'); fillInspector(snap()); renderOutliner(snap()); draw();
  });
  joinedRoom.onMessage("error", (msg: { message?: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    savePending = false;
    fillInspector(snap());
    lastError = msg.message ?? "error";
    status(lastError);
    flashUntil = performance.now() + 280;
    draw();
  });
  joinedRoom.onMessage("obstacleAck", () => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    lastAck = "obstacle ok";
    status(lastAck);
  });
  joinedRoom.onMessage("commandAck", (msg: { robotId?: string; commandId?: string; kind?: string; targetId?: string; state?: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    const robotId = msg.robotId ?? selectedRobot;
    const action = msg.kind === "dock" ? "도킹" : "이동";
    status(`${robotId} ${action} 명령 전송됨 · 로봇 응답 대기${msg.commandId ? ` · ${msg.commandId}` : ""}`);
  });
  const handlePoseAck = (msg: { requestId?: string; ok?: boolean; accepted?: boolean; reason?: string; message?: string }) => {
    if (room !== joinedRoom || !canWriteToLive() || !msg.requestId || !poseOverrideRequests.has(msg.requestId)) return;
    poseOverrideRequests.delete(msg.requestId);
    runtimeRequests.delete(msg.requestId);
    const timer = runtimeTimers.get(msg.requestId); if (timer) clearTimeout(timer);
    runtimeTimers.delete(msg.requestId);
    const accepted = msg.ok ?? msg.accepted === true;
    const message = msg.message ?? msg.reason;
    if (accepted) {
      poseOverride = null;
      status(message || '서버가 테스트 위치 요청을 승인했습니다.');
    } else if (poseOverride?.requestId === msg.requestId) {
      poseOverride = { ...poseOverride, status: EditSessionStatuses.code.draft, error: message || '테스트 위치를 적용하지 못했습니다.' };
      status(message || '테스트 위치를 적용하지 못했습니다.');
    }
    renderRuntime(snap()); draw();
  };
  joinedRoom.onMessage("virtualRobotPoseAck", handlePoseAck);
  joinedRoom.onMessage("robot_motion_pause_result", (msg: { requestId?: string; robotId?: string; desired?: boolean; applied?: boolean; pending?: boolean; ok?: boolean; reasonCode?: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    handleMotionPauseResult(msg);
  });
  joinedRoom.onMessage("robot_events_result", (msg: { requestId?: string; robotId?: string; ok?: boolean; events?: RobotEventRecord[]; nextCursor?: string; asOf?: number; gap?: boolean; truncated?: boolean; error?: unknown }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    handleRobotEventsResult(msg);
  });
  joinedRoom.onMessage("runtimeAck", (msg: { requestId?: string; ok?: boolean; message?: string }) => {
    if (room !== joinedRoom || !canWriteToLive()) return;
    if (msg.requestId && poseOverrideRequests.has(msg.requestId)) { handlePoseAck(msg); return; }
    const requestId = msg.requestId ?? '';
    const pendingKey = runtimeRequests.get(requestId);
    if (pendingKey) { runtimePending.delete(pendingKey); runtimeRequests.delete(requestId); const timer = runtimeTimers.get(requestId); if (timer) clearTimeout(timer); runtimeTimers.delete(requestId); }
    status(msg.ok ? (msg.message || '런타임 변경 완료') : (msg.message || '런타임 변경을 적용하지 못했습니다'));
    renderRuntime(snap());
  });
  joinedRoom.onLeave(() => resetConnection("서버 연결 끊김 · 로봇 명령을 잠갔어"));
  joinedRoom.onError(() => resetConnection("서버 연결 오류 · 로봇 명령을 잠갔어"));
  refresh();
}

async function main(): Promise<void> {
  if (!new URLSearchParams(location.search).has("portOffset")) {
    try { const config = await fetch('/runtime-config.json', { cache: 'no-store' }).then(r => r.json() as Promise<{portOffset?: number}>); applyBrowserPortOffset(Number(config.portOffset ?? 0)); } catch { /* default ports */ }
  }
  bindUi();
  setTool("select");
  images.map = await loadImage(activeMap.map);
  images.waypoint = await loadImage(ASSETS.waypoint);
  images.charger = await loadImage(ASSETS.charger);
  for (const id of Object.keys(ASSETS.robots) as (keyof typeof ASSETS.robots)[]) {
    images.robots[id] = await loadImage(ASSETS.robots[id]);
  }
  occGrid = await loadBin(activeMap.occupancy, activeMap);
  blueprint = createBlueprint(occGrid, activeMap.width, activeMap.height);
  inflatedGrid = await loadBin(activeMap.inflated, activeMap);
  updateMapChrome();
  setMode(AppModes.code.scene);
  resize();
  fit();
  const loop = () => {
    draw();
    requestAnimationFrame(loop);
  };
  loop();
  (document.getElementById("blackbox-toggle") as HTMLButtonElement).disabled = false;
  try {
    await connect();
  } catch (err) {
    setConn("offline", "offline");
    status(`서버 연결 실패: ${err instanceof Error ? err.message : String(err)}`);
    scheduleReconnect();
  }
}

void main();
