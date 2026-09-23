import { defineCodes } from './defineCodes.ts';

export const BLACKBOX_CONFIRMATIONS = defineCodes({ BLACKBOX_RESET: '전체 블랙박스 기록 삭제 확인' });
export const BLACKBOX_SCOPES = defineCodes({ blackbox: '모든 맵과 로봇의 블랙박스 기록' });

export const ScanLimitKinds = defineCodes({ bytes: "탐색 용량", lines: "탐색 행 수" });
export type ScanLimitKind = (typeof ScanLimitKinds.values)[number];
