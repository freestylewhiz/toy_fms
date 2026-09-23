import { defineCodes } from "./defineCodes.ts";

export const ResourceKinds = defineCodes({ zone: "구역", node: "노드", edge: "엣지" });
export type ResourceKind = (typeof ResourceKinds.values)[number];

export const ResourceFamilies = defineCodes({ scene: "장면", vda: "VDA" });
export type ResourceFamily = (typeof ResourceFamilies.values)[number];

export const SceneKinds = defineCodes({ waypoint: "이동 지점", charger: "충전소", obstacle: "장애물", forbidden: "금지 구역", prefer: "선호 구역", avoid: "회피 구역", corridor: "회랑", complex: "교차 구역" });
export type SceneKind = (typeof SceneKinds.values)[number];

export const VdaKinds = defineCodes({ node: "노드", edge: "엣지", station: "스테이션", blocked: "차단", release: "해제", line_guided: "선형 주행", speed_limit: "속도 제한", priority: "우선", penalty: "비용", directed: "단방향", bidirected: "양방향", replanning: "재계획", action_zone: "동작 구역", portal: "포털", rail: "레일" });
export type VdaKind = (typeof VdaKinds.values)[number];

export const ObstacleKinds = defineCodes({ triangle: "삼각형", square: "사각형", circle: "원" });
export type ObstacleKind = (typeof ObstacleKinds.values)[number];

export const ZoneKinds = defineCodes({ forbidden: "금지 구역", prefer: "선호 구역", avoid: "회피 구역", blocked: "차단", release: "해제", line_guided: "선형 주행", speed_limit: "속도 제한", priority: "우선", penalty: "비용", directed: "단방향", bidirected: "양방향", replanning: "재계획", action_zone: "동작 구역", corridor: "회랑", complex: "교차 구역" });
export type ZoneKind = (typeof ZoneKinds.values)[number];

export const StationKinds = defineCodes({ charger: "충전소", pick_drop: "픽업/드롭", wait: "대기", other: "기타" });
export type StationKind = (typeof StationKinds.values)[number];

export const DirectedLimitations = defineCodes({ SOFT: "완화", RESTRICTED: "제한", STRICT: "엄격" });
export type DirectedLimitation = (typeof DirectedLimitations.values)[number];

export const ZoneReleaseLossBehaviors = defineCodes({ STOP: "정지", CONTINUE: "계속 진행", EVACUATE: "대피" });
export type ZoneReleaseLossBehavior = (typeof ZoneReleaseLossBehaviors.values)[number];

export const CorridorReferencePoints = defineCodes({ KINEMATIC_CENTER: "운동 중심", CONTOUR: "외곽선" });
export type CorridorReferencePoint = (typeof CorridorReferencePoints.values)[number];

export const EdgeReleaseLossBehaviors = defineCodes({ STOP: "정지", RETURN: "복귀" });
export type EdgeReleaseLossBehavior = (typeof EdgeReleaseLossBehaviors.values)[number];

export const ResourceDisplayKinds = defineCodes({
  ...SceneKinds.labels, ...VdaKinds.labels, ...ZoneKinds.labels,
  waypoint: SceneKinds.labels.waypoint, charger: SceneKinds.labels.charger, obstacle: SceneKinds.labels.obstacle,
  zone: "구역", forbidden: ZoneKinds.labels.forbidden, prefer: ZoneKinds.labels.prefer, avoid: ZoneKinds.labels.avoid,
  corridor: ZoneKinds.labels.corridor, complex: ZoneKinds.labels.complex,
  node: VdaKinds.labels.node, edge: VdaKinds.labels.edge, station: VdaKinds.labels.station,
  portal: VdaKinds.labels.portal, rail: VdaKinds.labels.rail, teleporter: "텔레포터", robot: "로봇",
});
export type ResourceDisplayKind = (typeof ResourceDisplayKinds.values)[number];
export const TeleporterKinds = defineCodes({ teleporter: "텔레포터" });
export type TeleporterKind = (typeof TeleporterKinds.values)[number];

export const SceneZoneKinds = defineCodes({ forbidden: ZoneKinds.labels.forbidden, prefer: ZoneKinds.labels.prefer, avoid: ZoneKinds.labels.avoid, corridor: ZoneKinds.labels.corridor, complex: ZoneKinds.labels.complex });
export const VdaZoneKinds = defineCodes({ blocked: ZoneKinds.labels.blocked, release: ZoneKinds.labels.release, line_guided: ZoneKinds.labels.line_guided, speed_limit: ZoneKinds.labels.speed_limit, priority: ZoneKinds.labels.priority, penalty: ZoneKinds.labels.penalty, directed: ZoneKinds.labels.directed, bidirected: ZoneKinds.labels.bidirected, replanning: ZoneKinds.labels.replanning, action_zone: ZoneKinds.labels.action_zone });
export const FactorZoneKinds = defineCodes({ prefer: ZoneKinds.labels.prefer, avoid: ZoneKinds.labels.avoid, priority: ZoneKinds.labels.priority, penalty: ZoneKinds.labels.penalty });
