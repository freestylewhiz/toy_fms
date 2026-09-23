import { defineCodes } from "./defineCodes.ts";

export const ConnectionStates = defineCodes({ online: "온라인", offline: "오프라인" });
export type ConnectionState = (typeof ConnectionStates.values)[number];

/** Stable runtime map identifiers. Instance IDs such as teleporter IDs remain runtime strings. */
export const RuntimeMapIds = defineCodes({ yard: "테스트 야드", large_lab: "대형 실험실" });
export type RuntimeMapId = (typeof RuntimeMapIds.values)[number];

export const PreviewMapIds = defineCodes({ "1st_floor": "1층 미리보기" });
export type PreviewMapId = (typeof PreviewMapIds.values)[number];
