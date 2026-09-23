import { defineCodes } from "./defineCodes.ts";
import { SceneKinds, VdaKinds, ZoneKinds } from "./resource.ts";

export const AppModes = defineCodes({ operate: "운영", scene: "장면 편집", vda: "VDA 편집" });
export type AppMode = (typeof AppModes.values)[number];

export const ViewSources = defineCodes({ live: "실시간", blackbox: "블랙박스", "live-resync": "실시간 동기화" });
export type ViewSource = (typeof ViewSources.values)[number];

export const PoseAssets = defineCodes({ waypoint: SceneKinds.labels.waypoint, charger: SceneKinds.labels.charger, node: VdaKinds.labels.node, station: VdaKinds.labels.station, obstacle: SceneKinds.labels.obstacle });
export type PoseAsset = (typeof PoseAssets.values)[number];
export const ReplayStatuses = defineCodes({ loading: "불러오는 중", ready: "준비됨", playing: "재생 중", paused: "일시 정지", complete: "완료", error: "오류" });
export type ReplayStatus = (typeof ReplayStatuses.values)[number];

export const ToolKinds = defineCodes({
  select: "선택", move: "이동", dock: "도킹", waypoint: SceneKinds.labels.waypoint, charger: SceneKinds.labels.charger, obstacle: SceneKinds.labels.obstacle,
  forbidden: ZoneKinds.labels.forbidden, prefer: ZoneKinds.labels.prefer, avoid: ZoneKinds.labels.avoid, node: VdaKinds.labels.node, edge: VdaKinds.labels.edge, station: VdaKinds.labels.station,
  grid: "격자", portal: VdaKinds.labels.portal, rail: VdaKinds.labels.rail, teleporter: "텔레포터", corridor: ZoneKinds.labels.corridor, complex: ZoneKinds.labels.complex,
  marquee: "영역 선택", blocked: ZoneKinds.labels.blocked, release: ZoneKinds.labels.release, line_guided: ZoneKinds.labels.line_guided, speed_limit: ZoneKinds.labels.speed_limit,
  priority: ZoneKinds.labels.priority, penalty: ZoneKinds.labels.penalty, directed: ZoneKinds.labels.directed, bidirected: ZoneKinds.labels.bidirected, replanning: ZoneKinds.labels.replanning, action_zone: ZoneKinds.labels.action_zone,
});
export type ToolKind = (typeof ToolKinds.values)[number];

export const EditModes = defineCodes({ create: "배치", modify: "수정" });
export type EditMode = (typeof EditModes.values)[number];
export const EditSessionStatuses = defineCodes({ draft: "초안", pending: "처리 중" });
export type EditSessionStatus = (typeof EditSessionStatuses.values)[number];
export const OccupancyLayers = defineCodes({ off: "숨김", occupancy: "점유 격자", inflated: "확장 점유 격자" });
export type OccupancyLayer = (typeof OccupancyLayers.values)[number];
export const TeleporterEndpointSteps = defineCodes({ A: "끝점 A", B: "끝점 B" });
export type TeleporterEndpointStep = (typeof TeleporterEndpointSteps.values)[number];
export const ZoneGuidanceOverlays = defineCodes({ "prefer-inner": "내부 유도", "avoid-depth": "가장자리 회피" });
export type ZoneGuidanceOverlay = (typeof ZoneGuidanceOverlays.values)[number];
export const ZoneValidationLevels = defineCodes({ warning: "경고", error: "오류" });
export type ZoneValidationLevel = (typeof ZoneValidationLevels.values)[number];

export const EditHandles = defineCodes({ body: "위치 이동", rotate: "방향 회전", size: "크기 변경" });
export type EditHandle = (typeof EditHandles.values)[number];
export const TimeRangeBounds = defineCodes({ start: "시작 시각", end: "종료 시각" });
export type TimeRangeBound = (typeof TimeRangeBounds.values)[number];
