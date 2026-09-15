import { Client, type Room } from "colyseus.js";
import {
  COLYSEUS_PORT,
  MAP_HEIGHT as YARD_MAP_HEIGHT,
  MAP_WIDTH as YARD_MAP_WIDTH,
  ROBOT_SPRITES,
  ROOM_NAME,
} from "../../shared/constants.ts";
import { clampObstaclePos, clampObstacleSize, parseObstacleKind, type ObstacleKind } from "../../shared/obstacles.ts";
import { SCENE_ZONE_KINDS, type Point, type ZoneKind } from "../../shared/semantic.ts";
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

let multiSelection = new Set<string>();
let marquee: { start: Point; end: Point; additive: boolean } | null = null;
let cursorScreen: { x: number; y: number } | null = null;
function updateCanvasCursor(): void {
  let cursor = tool === 'select' ? 'default' : 'crosshair';
  if (panning) cursor = 'grabbing';
  else if (spaceDown) cursor = 'grab';
  else if (editDrag === 'rotate') cursor = 'crosshair';
  else if (editDrag === 'size') cursor = 'nwse-resize';
  else if (editDrag || zoneDrag || dragging) cursor = 'grabbing';
  else if (cursorScreen && !marquee) {
    const p = screenToWorld(cam, cursorScreen.x, cursorScreen.y);
    const px = 1 / Math.max(cam.scale, 0.08);
    if (editSession?.kind === 'pose') {
      const handle = hitPoseEditor(editSession, p.x, p.y, px);
      cursor = handle === 'rotate' ? 'crosshair' : handle === 'body' ? 'grab' : editSession.asset === 'obstacle' ? 'nwse-resize' : 'grab';
    } else if (tool === 'select') {
      const s = snap();
      const handle = hitZoneHandle(s, p.x, p.y, selected?.kind === 'zone' ? selected.id : undefined, px, zonePreview ?? undefined);
      const hit = hitTest(s, p.x, p.y);
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

type Mode = "operate" | "scene" | "vda";
type Tool = string;
type PoseAsset = "waypoint" | "charger" | "node" | "station" | "obstacle";

type EditSession = (
  | {
      kind: "pose";
      mode: "create" | "modify";
      asset: PoseAsset;
      id?: string;
      x: number;
      y: number;
      theta: number;
      size?: number;
    }
  | {
      kind: "zone";
      mode: "create" | "modify";
      id?: string;
      family: "scene" | "vda";
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
  id: "yard" | "1st_floor";
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
  yard: {
    id: "yard",
    label: "Yard",
    version: "v1",
    width: YARD_MAP_WIDTH,
    height: YARD_MAP_HEIGHT,
    pixelCm: 5,
    map: "/resources/maps/yard.png",
    occupancy: "/resources/maps/occupancy.bin",
    inflated: "/resources/maps/occupancy_inflated.bin",
    editable: true,
  },
  "1st_floor": {
    id: "1st_floor",
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

let activeMap: MapSpec = MAP_CATALOG.yard;
let mapLoading = false;

const WS_URL = `ws://${location.hostname}:${COLYSEUS_PORT}`;
const ASSETS = {
  waypoint: "/resources/images/waypoint/waypoint.png",
  charger: "/resources/images/charing-station/charging_station.png",
  robots: {
    "robot-1": `/resources/images/robots/${ROBOT_SPRITES["robot-1"]}`,
    "robot-2": `/resources/images/robots/${ROBOT_SPRITES["robot-2"]}`,
  },
} as const;

const ZONE_TOOLS: Record<string, { family: "scene" | "vda"; zoneKind: ZoneKind }> = {
  forbidden: { family: "scene", zoneKind: "forbidden" },
  prefer: { family: "scene", zoneKind: "prefer" },
  avoid: { family: "scene", zoneKind: "avoid" },
  corridor: { family: "scene", zoneKind: "corridor" },
  complex: { family: "scene", zoneKind: "complex" },
  blocked: { family: "vda", zoneKind: "blocked" },
  release: { family: "vda", zoneKind: "release" },
  line_guided: { family: "vda", zoneKind: "line_guided" },
  speed_limit: { family: "vda", zoneKind: "speed_limit" },
  priority: { family: "vda", zoneKind: "priority" },
  penalty: { family: "vda", zoneKind: "penalty" },
  directed: { family: "vda", zoneKind: "directed" },
  bidirected: { family: "vda", zoneKind: "bidirected" },
  replanning: { family: "vda", zoneKind: "replanning" },
  action_zone: { family: "vda", zoneKind: "action_zone" },
};

const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
const ctx = canvas.getContext("2d")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;

let room: Room | null = null;
let transportConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1500;

function scheduleReconnect(): void {
  if (reconnectTimer || transportConnected || room) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(10000, Math.round(reconnectDelayMs * 1.7));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect().catch(() => {
      scheduleReconnect();
    });
  }, delay);
}
let mode: Mode = "operate";
let tool: Tool = "select";
let cam: Camera = { x: 0, y: 0, scale: 1 };
let spaceDown = false;
let panning: { sx: number; sy: number; cam: Camera } | null = null;
let selected: { kind: string; id: string } | null = null;
let selectedRobot = "";
let obstacleShape: ObstacleKind = "square";
let occLayer: "off" | "occupancy" | "inflated" = "off";
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
let resourceDraft: { mode: "create" | "modify"; data: Record<string, any> } | null = null;
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
  const collections: Record<string, readonly any[]> = { waypoint: s.waypoints, charger: s.chargers, obstacle: s.obstacles, zone: s.zones, node: s.nodes, edge: s.edges, station: s.stations, portal: s.portals, rail: s.rails, robot: s.robots };
  return collections[kind]?.find(r => r.id === id);
}
function showProperties(): void {
  document.querySelector('.shell')?.classList.remove('hide-details', 'focus-mode');
  $('focus-workspace')?.setAttribute('aria-pressed', 'false');
  $('toggle-details')?.setAttribute('aria-pressed', 'true');
  document.querySelector<HTMLButtonElement>('button[data-detail="properties"]')?.click();
}
function beginResourceCreate(data: Record<string, any>): void {
  resourceDraft = { mode: 'create', data: { ...data, id: newResourceId(data.kind), name: data.kind, theta: data.theta ?? 0 } };
  selected = null;
  syncEditChrome(); showProperties(); fillInspector(snap()); draw();
}
let editDrag: "body" | "rotate" | "size" | null = null;
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
  map: new Image(),
  waypoint: new Image(),
  charger: new Image(),
  robots: {} as Record<string, HTMLImageElement>,
};

const layers = { zones: true, graph: true, corridor: true, scene: true, robots: true };

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}
function send(type: string, payload: Record<string, unknown>): void {
  room?.send(type, payload);
}
function snap(): Snapshot {
  const runtime = projectTransport(snapshotFromState(room?.state as Record<string, unknown> | undefined), transportConnected);
  if (activeMap.id === "yard") return runtime;
  // The current Room contract has one active yard map. Keep other map views
  // read-only so yard resources can never be accidentally written onto a
  // different background until map-scoped persistence is added server-side.
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
function status(msg: string): void {
  $("status-msg").textContent = msg;
}
function setConn(state: string, label: string): void {
  $("conn").dataset.state = state;
  $("conn-label").textContent = label;
}

const TRAFFIC_STATUS: Record<string, { label: string; detail: string }> = {
  clear: { label: "통행 가능", detail: "교통 제어상 제한 없음" },
  proceed: { label: "진행 허가", detail: "현재 경로로 진행 가능" },
  partial: { label: "부분 진행", detail: "앞쪽 정지선까지 진행" },
  hold: { label: "대기", detail: "교통 제어 신호를 기다리는 중" },
  stop: { label: "정지", detail: "안전을 위해 즉시 정지" },
  evade: { label: "회피 중", detail: "교착을 풀기 위해 우회 중" },
  lease_lost: { label: "제어 해제", detail: "교통 권한이 끊겨 정지 대기" },
};

function trafficCopy(status: string): { label: string; detail: string } {
  return TRAFFIC_STATUS[status] ?? { label: status || "알 수 없음", detail: "교통 상태 확인 중" };
}

const COMMAND_STATE: Record<string, string> = {
  idle: "대기", sent: "명령 전송됨", accepted: "명령 수락됨", running: "주행 중",
  completed: "완료", cancelled: "취소됨", rejected: "거부됨", failed: "실패", interrupted: "중단됨",
};
const runtimePending = new Set<string>();
const runtimeRequests = new Map<string, string>();
const runtimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
function runtimeTimeout(requestId: string, key: string): void {
  runtimeTimers.set(requestId, setTimeout(() => {
    runtimeTimers.delete(requestId); runtimeRequests.delete(requestId); runtimePending.delete(key);
    status('런타임 변경 응답 시간 초과'); renderRuntime(snap());
  }, 6000));
}
function runtimeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
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
  return (({ idle:'유휴', busy:'작업 중', unknown:'확인 불가', moving:'주행 중', stationary:'정지', waiting:'대기', paused:'일시정지', blocked:'주행 불가', enabled:'운영 중', disabled:'운영 제외', online:'온라인', offline:'오프라인', occupied:'점유', reserved:'예약', queued:'대기열', free_navigation:'자유 주행', graph_navigation:'노드·엣지 주행', robot:'로봇 자체 계획', fms:'FMS 계획', hybrid:'협력 계획', synchronizing:'동기화 중', session_lost:'통신 두절', monitor_disconnected:'모니터링 연결 끊김' } as Record<string,string>)[value] ?? value) || '—';
}
function renderRuntime(s: Snapshot): void {
  const focused = document.activeElement instanceof HTMLElement ? {
    action: focusedRuntimeAction(document.activeElement),
    robotId: (document.activeElement as HTMLElement).dataset.robotId,
    resourceId: (document.activeElement as HTMLElement).dataset.resourceId,
  } : null;
  const detail = $('runtime-robot-detail');
  const r = s.robots.find(robot => robot.id === selectedRobot);
  const records = s.runtimeOccupancies.filter(o => o.resourceRef.mapId === activeMap.id && o.resourceRef.kind === 'zone');
  const detailKey = r ? JSON.stringify([r.id,r.workState,r.fmsControlState,r.connectionState,r.connectionReason,r.driveState,r.driveContexts,r.controlEpoch,r.controlReady,r.sessionId,r.navigationMode,r.pathPlanningAuthority,transportConnected,[...runtimePending],s.zones.map(z=>[z.id,z.name])]) : 'empty';
  const occupancyKey = JSON.stringify([records, transportConnected, [...runtimePending], s.zones.map(z=>[z.id,z.name])]);
  if (detail.dataset.runtimeKey === detailKey && $('runtime-occupancies').dataset.runtimeKey === occupancyKey) {
    detail.querySelectorAll<HTMLElement>('[data-runtime-since]').forEach(el => el.textContent = runtimeElapsed(Number(el.dataset.runtimeSince)));
    const lastReport = detail.querySelector<HTMLElement>('[data-runtime-report]');
    if (lastReport && r) lastReport.textContent = runtimeTime(r.reportedAt || r.lastSeenAt);
    return;
  }
  if (!r) detail.innerHTML = '<span class="runtime-empty">로봇을 선택하면 런타임 상태와 제어를 표시합니다.</span>';
  else {
    const reasonLabels: Record<string,string> = { resource_occupied:'리소스 점유', permission_pending:'허가 대기', traffic_yield:'교통 양보', route_update_pending:'경로 갱신 대기', action_in_progress:'선행 작업', operator_pause:'운영자 일시정지', obstacle_detected:'장애물 감지', safety_stop:'안전 정지', localization_error:'위치 추정 오류', control_unavailable:'제어 불가' };
    const contexts = r.driveContexts.length ? r.driveContexts.map(c => `<li><b>${runtimeEsc(reasonLabels[c.reasonCode] ?? c.reasonCode)}</b> · <span data-runtime-since="${c.since}" data-runtime-elapsed>${runtimeElapsed(c.since)}</span>${c.target ? ` · ${runtimeEsc(c.target.kind)} ${runtimeEsc(s.zones.find(z => z.id === c.target!.id)?.name ?? c.target.id)}` : ''}${c.blockingRobotIds?.length ? ` · 차단 ${c.blockingRobotIds.map(runtimeEsc).join(', ')}` : ''}</li>`).join('') : '<li>추가 원인 없음</li>';
    const disabled = r.fmsControlState === 'disabled';
    const action = disabled ? 'enable' : 'disable';
    detail.innerHTML = `<div class="runtime-robot-title"><span class="runtime-state-glyph ${disabled ? 'is-disabled' : r.connectionState}">${disabled ? '⊘' : r.connectionState === 'online' ? '●' : '○'}</span><div><b>${runtimeEsc(r.id)}</b><small>${runtimeLabel(r.fmsControlState)} · ${runtimeLabel(r.connectionState)}${r.connectionReason ? ` · ${runtimeEsc(runtimeLabel(r.connectionReason))}` : ''}</small></div></div>
      <div class="runtime-badges"><span>${runtimeLabel(r.workState)}</span><span>${runtimeLabel(r.driveState)}</span><span>${runtimeLabel(r.navigationMode)}</span></div>
      <dl class="runtime-facts"><dt>주행 방식</dt><dd>${runtimeLabel(r.pathPlanningAuthority)}</dd><dt>제어 준비</dt><dd>${r.controlReady ? '준비됨' : '사용 불가'}</dd><dt>대기 시간</dt><dd data-runtime-since="${r.driveContexts[0]?.since ?? 0}">${runtimeElapsed(r.driveContexts[0]?.since ?? 0)}</dd><dt>마지막 보고</dt><dd data-runtime-report>${runtimeTime(r.reportedAt || r.lastSeenAt)}</dd></dl>
      <div class="runtime-context"><b>원인·대상</b><ul>${contexts}</ul></div>
      <div class="runtime-actions"><button type="button" class="${disabled ? 'primary' : 'danger'}" data-runtime-action="${action}" data-robot-id="${runtimeEsc(r.id)}" ${runtimePending.has(`control:${r.id}`) || !transportConnected ? 'disabled' : ''}>${runtimePending.has(`control:${r.id}`) ? '처리 중…' : disabled ? '운영 재개' : '운영 제외'}</button></div>`;
    detail.querySelector<HTMLButtonElement>('[data-runtime-action]')?.addEventListener('click', async () => {
      const enabled = action === 'enable';
      const warning = enabled ? `${r.id}을(를) 운영에 다시 참여시킬까요? 현재 위치·점유·작업 동기화가 확인되어야 활성화됩니다.` : `${r.id}을(를) 운영에서 제외할까요? 실제 로봇은 움직일 수 있으며, 통신 재접속만으로 다시 활성화되지 않습니다.`;
      if (!(await runtimeConfirm(warning))) return;
      const liveRobot = snap().robots.find(robot => robot.id === r.id);
      if (!liveRobot || !transportConnected) return;
      const requestId = runtimeRequestId('control'); runtimePending.add(`control:${r.id}`); runtimeRequests.set(requestId, `control:${r.id}`); renderRuntime(snap());
      runtimeTimeout(requestId, `control:${r.id}`);
      send('setRobotControl', { robotId: r.id, enabled, requestId, expectedEpoch: liveRobot.controlEpoch });
    });
  }
  const occupancy = $('runtime-occupancies');
  occupancy.innerHTML = records.length ? records.map(o => `<div class="occupancy-row"><div><b>${runtimeEsc(s.zones.find(z=>z.id===o.resourceRef.id)?.name || o.resourceRef.id)}</b><small>${runtimeLabel(o.state)} · ${runtimeEsc(o.robotId)}${o.queuePosition != null ? ` · #${o.queuePosition}` : ''}</small></div><button type="button" class="danger" data-runtime-action="release" data-resource-id="${runtimeEsc(o.resourceRef.id)}" data-robot-id="${runtimeEsc(o.robotId)}" ${runtimePending.has(`release:${o.resourceRef.id}:${o.robotId}`) || !transportConnected ? 'disabled' : ''}>${runtimePending.has(`release:${o.resourceRef.id}:${o.robotId}`) ? '처리 중…' : '선택 해제'}</button></div>`).join('') : '<span class="runtime-empty">런타임 점유 정보가 없습니다.</span>';
  detail.dataset.runtimeKey = detailKey;
  occupancy.dataset.runtimeKey = occupancyKey;
  occupancy.querySelectorAll<HTMLButtonElement>('[data-runtime-action="release"]').forEach(button => button.addEventListener('click', async () => {
    const resourceId = button.dataset.resourceId!, robotId = button.dataset.robotId!;
    if (!(await runtimeConfirm(`${robotId}의 ${resourceId} 점유를 해제할까요? 이 작업은 해당 로봇을 반드시 운영 제외 상태로 전환하고, 선택한 점유만 해제합니다.`))) return;
    const record = records.find(o => o.resourceRef.id === resourceId && o.robotId === robotId); if (!record) return;
    const liveRobot = snap().robots.find(robot => robot.id === robotId); if (!liveRobot) return;
    const requestId = runtimeRequestId('release'); runtimePending.add(`release:${resourceId}:${robotId}`); runtimeRequests.set(requestId, `release:${resourceId}:${robotId}`); renderRuntime(snap());
    runtimeTimeout(requestId, `release:${resourceId}:${robotId}`);
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
  if (mapLoading || next === activeMap.id) return;
  if ((editSession || resourceDraft || draftPoly.length || draftLine.length) && !window.confirm('저장하지 않은 편집을 취소하고 맵을 전환할까요?')) {
    updateMapChrome();
    return;
  }
  mapLoading = true;
  clearMulti();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-map-target]')) button.disabled = true;
  (document.querySelector('#map-select') as HTMLSelectElement).disabled = true;
  clearEditSession();
  draftPoly = [];
  draftCursor = null;
  draftLine = [];
  selected = null;
  selectedVertex = null;
  setTool("select");
  const nextMap = MAP_CATALOG[next];
  try {
    const [mapImage, occ, inflated] = await Promise.all([
      loadImage(nextMap.map),
      loadBin(nextMap.occupancy, nextMap),
      loadBin(nextMap.inflated, nextMap),
    ]);
    activeMap = nextMap;
    selectedRobot = "";
    $("sel-robot-id").textContent = "—";
    ($("btn-cancel") as HTMLButtonElement).disabled = true;
    images.map = mapImage;
    occGrid = occ;
    blueprint = createBlueprint(occ, activeMap.width, activeMap.height);
    inflatedGrid = inflated;
    occLayer = "off";
    occOverlay = null;
    $("occ-legend").hidden = true;
    updateMapChrome();
    fit();
    status(activeMap.editable ? `${activeMap.label} 맵 편집 준비됨` : `${activeMap.label} 미리보기 · 서버 편집은 yard에서만 가능해`);
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
    const verb = editSession.mode === "create" ? "배치" : "수정";
    $("edit-badge").textContent = verb;
    $("edit-title").textContent = `${editSession.asset} ${verb}`;
    $("edit-meta").textContent =
      `x ${editSession.x.toFixed(1)}  y ${editSession.y.toFixed(1)}  θ ${deg(editSession.theta)}` +
      (editSession.size != null ? `  sz ${editSession.size.toFixed(0)}` : "");
    $("edit-keys").textContent = "드래그 이동 · 노란 점 회전 · Q/E · Esc/Enter";
  } else if (editSession?.kind === "zone") {
    const verb = editSession.mode === "create" ? "배치" : "수정";
    $("edit-badge").textContent = verb;
    $("edit-title").textContent = `${editSession.zoneKind} ${verb}`;
    $("edit-meta").textContent = `꼭짓점 ${editSession.polygon.length}`;
    $("edit-keys").textContent = "라벨·정점으로 조정 · Esc/Enter";
  } else if (resourceDraft) {
    $("edit-badge").textContent = resourceDraft.mode === 'create' ? '배치' : '수정';
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
  inspectorKey = "";
  editDrag = null;
  editGrab = null;
  zonePreview = null;
  syncEditChrome();
}

function beginPoseCreate(asset: PoseAsset, x: number, y: number, theta = 0, size?: number): void {
  editSession = {
    kind: "pose",
    mode: "create",
    asset,
    id: newResourceId(asset),
    name: asset,
    source: asset === "obstacle" ? { obstacleKind: obstacleShape } : {},
    x,
    y,
    theta,
    size: asset === "obstacle" ? (size ?? 16) : undefined,
  };
  editDrag = asset === "obstacle" ? "size" : "rotate";
  selected = null;
  syncEditChrome();
  status(`${asset} 편집 중 · 확인을 눌러 저장`);
  draw();
}

function beginPoseModify(asset: PoseAsset, id: string, x: number, y: number, theta: number, size?: number): void {
  const original = resourceOf(snap(), asset, id);
  editSession = { kind: "pose", mode: "modify", asset, id, name: original?.name || id, source: { ...original }, x, y, theta, size };
  if (asset === 'obstacle') obstacleShape = original?.kind ?? 'square';
  selected = { kind: asset, id };
  syncEditChrome();
  status(`${asset} 수정 중 · 확인을 눌러 저장`);
  draw();
}

function beginZoneModify(z: Snapshot["zones"][number], polygon: Point[]): void {
  editSession = {
    kind: "zone",
    mode: "modify",
    id: z.id,
    family: z.family === "vda" ? "vda" : "scene",
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
  } else payload = { ...resourceDraft!.data };
  savePending = true;
  $('property-state').textContent = '서버에 저장 중…';
  send('editorUpsert', JSON.parse(JSON.stringify(payload)));
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
  if (occLayer === "off" || !occGrid) return null;
  const c = document.createElement("canvas");
  c.width = activeMap.width;
  c.height = activeMap.height;
  const octx = c.getContext("2d")!;
  const img = octx.createImageData(activeMap.width, activeMap.height);
  for (let i = 0; i < occGrid.length; i++) {
    const o = i * 4;
    const free = occGrid[i] === 1;
    const safe = inflatedGrid ? inflatedGrid[i] === 1 : free;
    if (occLayer === "occupancy") {
      img.data.set(free ? [45, 212, 191, 88] : [15, 23, 42, 150], o);
    } else if (safe) img.data.set([45, 212, 191, 88], o);
    else if (free) img.data.set([251, 191, 36, 120], o);
    else img.data.set([15, 23, 42, 150], o);
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
  if (overview && blueprint && performance.now() - lastOverviewFrame > 100) {
    lastOverviewFrame = performance.now();
    drawOverview(overview, blueprintEnabled ? blueprint : images.map, snap(), cam, activeMap.width, activeMap.height, viewport.clientWidth, viewport.clientHeight);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyCamera(ctx, cam, dpr);
  const px = 1 / Math.max(cam.scale, 0.08);
  const dim = Boolean(editSession || resourceDraft) || (ZONE_TOOLS[tool] && draftPoly.length > 0);
  const hideId = editSession?.kind === "pose" && editSession.mode === "modify"
    ? editSession.id
    : undefined;
  const zonePrev = editSession?.kind === "zone"
    ? { id: editSession.id ?? `__draft_${editSession.zoneKind}`, polygon: editSession.polygon }
    : zonePreview ?? undefined;
  const renderSnapshot = snap();
  if (resourceDraft) {
    const key = ({ edge: 'edges', portal: 'portals', rail: 'rails' } as const)[resourceDraft.data.kind as 'edge' | 'portal' | 'rail'];
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
  cam = fitCamera(viewport.clientWidth, viewport.clientHeight, activeMap.width, activeMap.height);
  draw();
}

function addTool(parent: HTMLElement, id: string, label: string, key = ""): void {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.tool = id;
  const names: Record<string, string> = { select: '선택', move: '이동 명령', dock: '도킹', waypoint: '이동 지점', charger: '충전소', obstacle: '장애물', forbidden: '금지 구역', prefer: '선호 구역', avoid: '회피 구역', node: '노드', edge: '연결', station: '스테이션', grid: '점유 격자', portal: '포털', rail: '레일', corridor: '회랑', complex: '교차 구역', marquee: '영역 선택', blocked: '차단', release: '권한', line_guided: '유도선', speed_limit: '속도', priority: '우선', penalty: '페널티', directed: '단방향', bidirected: '양방향', replanning: '재계획', action_zone: '액션' };
  b.title = `${label}${key ? ` (${key})` : ''}`;
  b.innerHTML = `${icon(id)}<span>${names[id] ?? label}</span>${key ? `<kbd>${key}</kbd>` : ""}`;
  b.addEventListener("click", () => setTool(id));
  parent.append(b);
}

function setTool(next: Tool): void {
  clearMulti();
  if ((next === "move" || next === "dock") && selectedRobotView() && !canDispatchRobot(selectedRobotView())) {
    status(selectedRobot + " 연결 끊김 · 명령을 보낼 수 없어");
    next = "select";
  }
  if (!activeMap.editable && next !== "select" && next !== "grid" && next !== "marquee") {
    status(`${activeMap.label}는 미리보기 맵이야. 리소스 편집은 yard에서 가능해`);
    next = "select";
  }
  if (next === "grid") {
    occLayer = occLayer === "off" ? "occupancy" : occLayer === "occupancy" ? "inflated" : "off";
    occOverlay = buildOccOverlay();
    $("occ-legend").hidden = occLayer === "off";
    $("occ-legend-clearance").hidden = occLayer !== "inflated";
    next = "select";
  }
  if (savePending) return;
  if (editSession || resourceDraft) cancelEdit();
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
  $("shape-section").hidden = !(mode === "scene" && tool === "obstacle");
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
  cancel.disabled = !selected || !canDispatchRobot(selected) || selected.status !== "move";
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
    el.dataset.active = r.id === selectedRobot ? "true" : "false";
    const traffic = trafficCopy(r.trafficStatus);
    const motion = r.driveState !== 'unknown' ? runtimeLabel(r.driveState) : (!r.connected ? "연결 끊김" : r.motion || (r.status === "move" ? "주행 중" : "대기"));
    const commandLabel = COMMAND_STATE[r.commandState] ?? r.commandState;
    const controlGlyph = r.fmsControlState === 'disabled' ? '⊘' : r.connectionState === 'offline' ? '○' : '●';
    el.innerHTML = `<div class="robot-card-head"><span class="robot-card-identity"><i class="runtime-state-glyph ${r.fmsControlState === 'disabled' ? 'is-disabled' : r.connectionState}">${controlGlyph}</i><span class="id">${r.id}</span></span><span class="robot-card-state"><i class="traffic-dot" data-traffic="${r.trafficStatus}"></i>${traffic.label}</span></div><div class="robot-card-meta"><span>${runtimeLabel(r.workState)} · ${motion}</span><span>${r.fmsControlState === 'disabled' ? '운영 제외' : traffic.detail}</span></div>`;
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
  const readOnly = kind === 'robot' || !activeMap.editable;
  const key = `${kind}:${r.id}`;
  const changed = inspectorKey !== key;
  inspectorKey = key;
  $('insp-kind').textContent = kind === 'zone' ? r.kind : kind;
  $('insp-id').textContent = r.id;
  $('insp-id').title = `고유 ID · 변경되지 않음: ${r.id}`;
  $('btn-delete').hidden = readOnly || editSession?.mode === 'create' || resourceDraft?.mode === 'create';
  $('insp-name-wrap').hidden = readOnly;
  const pose = ['waypoint', 'charger', 'obstacle', 'node', 'station', 'robot'].includes(kind);
  const center = kind === 'zone' ? centroid(r.polygon) : pose ? r : null;
  $('insp-x-wrap').hidden = !center;
  $('insp-y-wrap').hidden = !center;
  const angle = kind !== 'portal';
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
    const add = (prop: string, label: string, options?: string[], min?: number) => {
      const wrap = document.createElement('label'); wrap.className = 'field property-field';
      const title = document.createElement('span'); title.textContent = label;
      const input = document.createElement(options ? 'select' : 'input');
      input.id = `prop-${prop}`; input.dataset.prop = prop;
      if (options) for (const option of options) { const el = document.createElement('option'); el.value = option; el.textContent = option || '기본값'; input.append(el); }
      else { const el = input as HTMLInputElement; el.type = 'number'; el.required = true; el.step = 'any'; if (min != null) el.min = String(min); }
      input.addEventListener('input', () => applyInspector(input.id));
      wrap.append(title, input); extra.append(wrap);
    };
    if (kind === 'node') { add('allowedDeviationXY', '위치 허용오차 · m', undefined, 0); add('allowedDeviationTheta', '각도 허용오차 · rad', undefined, 0); }
    if (kind === 'station') add('stationKind', '스테이션 용도', ['other', 'charger', 'pick_drop', 'wait']);
    if (kind === 'zone' && ['directed', 'bidirected'].includes(r.kind)) { add('direction', '통행 방향 · rad'); add('directedLimitation', '방향 제한', ['', 'SOFT', 'RESTRICTED', 'STRICT']); }
    if (kind === 'zone' && r.kind === 'release') add('releaseLossBehavior', '권한 해제 시', ['', 'STOP', 'CONTINUE', 'EVACUATE']);
    if (kind === 'portal' || kind === 'rail') add('zoneId', '연결 구역', s.zones.map(z => z.id));
  }
  for (const el of extra.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-prop]')) {
    if (document.activeElement !== el) el.value = String(el.dataset.prop === 'stationKind' ? (r.stationKind ?? r.kind ?? 'other') : r[el.dataset.prop!] ?? (el.tagName === 'SELECT' ? '' : 0));
  }
  const geometry = $('geometry-content');
  const rows: [string, string][] = [['맵', activeMap.label], ['고유 ID', r.id]];
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
  else resourceDraft = { mode: 'modify', data: { ...r, kind: selected.kind } };
}
function applyInspector(id: string): void {
  if (!activeMap.editable || !transportConnected || savePending || selected?.kind === 'robot') return;
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
  for (const target of targets) if (resourceOf(current,target.kind,target.id)) send('editorDelete', target);
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
    mode: "create",
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
  if (resourceDraft) { status("속성 패널에서 저장 또는 취소한 뒤 계속하세요."); return; }
  const s = snap();
  const px = 1 / Math.max(cam.scale, 0.08);

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
      editDrag = "rotate";
      return;
    }
    if (hit === "body") {
      editDrag = "body";
      editGrab = { dx: p.x - editSession.x, dy: p.y - editSession.y };
      return;
    }
    if (editSession.asset === "obstacle" && Math.hypot(p.x - editSession.x, p.y - editSession.y) > 12) {
      editDrag = "size";
      return;
    }
    editDrag = "body";
    editGrab = { dx: p.x - editSession.x, dy: p.y - editSession.y };
    return;
  }

  if (tool === "select") {
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

    const hit = hitTest(s, p.x, p.y);
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
        editDrag = 'body';
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

  if (ZONE_TOOLS[tool]) {
    if (editSession?.kind === "zone" && editSession.mode === "create") {
      status("먼저 확인하거나 취소해");
      return;
    }
    if (draftPoly.length >= 3) {
      const first = draftPoly[0];
      const closeR = 10 / Math.max(cam.scale, 0.08);
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
    if (editDrag === "rotate") {
      editSession.theta = Math.atan2(p.y - editSession.y, p.x - editSession.x);
    } else if (editDrag === "size") {
      editSession.size = clampObstacleSize(Math.hypot(p.x - editSession.x, p.y - editSession.y));
      editSession.theta = Math.atan2(p.y - editSession.y, p.x - editSession.x);
    } else if (editDrag === "body") {
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
    const px = 1 / Math.max(cam.scale, 0.08);
    const handle = hitZoneHandle(snap(), p.x, p.y, selected?.kind === "zone" ? selected.id : undefined, px, zonePreview ?? undefined);
    canvas.style.cursor = handle?.type === "label" ? "grab" : handle ? "move" : "";
  } else if (editSession?.kind === "pose") {
    const px = 1 / Math.max(cam.scale, 0.08);
    const hit = hitPoseEditor(editSession, p.x, p.y, px);
    canvas.style.cursor = hit === "rotate" ? "crosshair" : hit ? "move" : "";
  }
}

function onPointerUp(e: PointerEvent): void {
  const p = eventPos(e);
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
  document.body.dataset.mode = "operate";
  addTool($("tools-operate"), "select", "Select", "V");
  addTool($("tools-operate"), "move", "Move", "M");
  addTool($("tools-operate"), "dock", "Dock", "D");
  addTool($("tools-scene"), "select", "Select", "V");
  addTool($("tools-scene"), "waypoint", "Waypoint", "W");
  addTool($("tools-scene"), "charger", "Charger", "C");
  addTool($("tools-scene"), "obstacle", "Obstacle", "O");
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
    if (ev.key === "m" || ev.key === "M") if (mode === "operate" && !editSession) setTool("move");
    if (ev.key === "d" || ev.key === "D") if (mode === "operate" && !editSession) setTool("dock");
    if (ev.key === "w" || ev.key === "W") if (mode === "scene" && !editSession) setTool("waypoint");
    if (ev.key === "c" || ev.key === "C") if (mode === "scene" && !editSession) setTool("charger");
    if (ev.key === "o" || ev.key === "O") if (mode === "scene" && !editSession) setTool("obstacle");
    if (ev.key === "n" || ev.key === "N") if (mode === "vda" && !editSession) setTool("node");
    if ((ev.key === "e" || ev.key === "E") && mode === "vda" && !editSession) setTool("edge");
    if (ev.key === "g" || ev.key === "G") {
      if (editSession) return;
      occLayer = occLayer === "off" ? "occupancy" : occLayer === "occupancy" ? "inflated" : "off";
      occOverlay = buildOccOverlay();
      $("occ-legend").hidden = occLayer === "off";
      $("occ-legend-clearance").hidden = occLayer !== "inflated";
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
      if (ev.key === "1") setMode("operate");
      if (ev.key === "2") setMode("scene");
      if (ev.key === "3") setMode("vda");
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
  setConn("connecting", "connecting");
  const client = new Client(WS_URL);
  const joinedRoom = await client.joinOrCreate(ROOM_NAME);
  room = joinedRoom;
  transportConnected = true;
  reconnectDelayMs = 1500;
  setConn("online", "online");
  status("연결됨 · 1 운용 / 2 현장 / 3 VDA");
  const resetConnection = (reason: string) => {
    if (room !== joinedRoom) return;
    room = null;
    transportConnected = false;
    savePending = false;
    runtimePending.clear();
    runtimeRequests.clear();
    for (const timer of runtimeTimers.values()) clearTimeout(timer);
    runtimeTimers.clear();
    if (joinedRoom.connection.isOpen) void joinedRoom.leave().catch(() => {});
    selectedRobot = "";
    $("sel-robot-id").textContent = "—";
    setConn("offline", "offline");
    status(reason);
    renderRobots(snap());
    fillInspector(snap());
    draw();
    scheduleReconnect();
  };
  const refresh = () => {
    if (room !== joinedRoom) return;
    const s = snap();
    renderRobots(s);
    renderOutliner(s);
    fillInspector(s);
    draw();
  };
  joinedRoom.onStateChange(refresh);
  joinedRoom.onMessage('editorAck', (msg: { kind: string; id: string; action: string }) => {
    if (room !== joinedRoom) return;
    if (msg.action === 'upsert' && savePending) {
      savePending = false;
      selected = { kind: msg.kind, id: msg.id };
      clearEditSession(); draftPoly = []; draftLine = []; draftCursor = null;
      status('리소스 저장 완료'); fillInspector(snap()); renderOutliner(snap()); draw();
    } else if (msg.action === 'delete') status('리소스 삭제 완료');
  });
  joinedRoom.onMessage("error", (msg: { message?: string }) => {
    if (room !== joinedRoom) return;
    savePending = false;
    fillInspector(snap());
    lastError = msg.message ?? "error";
    status(lastError);
    flashUntil = performance.now() + 280;
    draw();
  });
  joinedRoom.onMessage("obstacleAck", () => {
    if (room !== joinedRoom) return;
    lastAck = "obstacle ok";
    status(lastAck);
  });
  joinedRoom.onMessage("commandAck", (msg: { robotId?: string; commandId?: string; kind?: string; targetId?: string; state?: string }) => {
    if (room !== joinedRoom) return;
    const robotId = msg.robotId ?? selectedRobot;
    const action = msg.kind === "dock" ? "도킹" : "이동";
    status(`${robotId} ${action} 명령 전송됨 · 로봇 응답 대기${msg.commandId ? ` · ${msg.commandId}` : ""}`);
  });
  joinedRoom.onMessage("runtimeAck", (msg: { requestId?: string; ok?: boolean; message?: string }) => {
    if (room !== joinedRoom) return;
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
  setMode("scene");
  resize();
  fit();
  const loop = () => {
    draw();
    requestAnimationFrame(loop);
  };
  loop();
  try {
    await connect();
  } catch (err) {
    setConn("offline", "offline");
    status(`서버 연결 실패: ${err instanceof Error ? err.message : String(err)}`);
    scheduleReconnect();
  }
}

void main();
