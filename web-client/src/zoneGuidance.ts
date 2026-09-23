import { isSimplePolygon, signedArea } from "../../shared/polygon.ts";
import type { Point } from "../../shared/semantic.ts";
import { ZoneGuidanceOverlays, ZoneKinds, ZoneValidationLevels, type ZoneGuidanceOverlay, type ZoneValidationLevel } from "../../shared/config/index.ts";

/** Initial body-plus-margin width used by the driving policy for soft-zone hints. */
export const SOFT_ZONE_MIN_WIDTH_PX = 2 * (9.43 + 2);

export type ZoneGuidance = {
  title: string;
  detail: string;
  overlay: ZoneGuidanceOverlay;
};

export type ZoneValidation = {
  level: ZoneValidationLevel;
  message: string;
};

export function zoneGuidance(kind: string): ZoneGuidance | null {
  if (kind === ZoneKinds.code.prefer) return {
    title: "내부 유도",
    detail: "경계에서 멀고 존 안쪽 골격에 가까운 경로를 우선합니다. 폭이 부족하면 일반 경로로 통과할 수 있습니다.",
    overlay: ZoneGuidanceOverlays.code["prefer-inner"],
  };
  if (kind === ZoneKinds.code.avoid) return {
    title: "가장자리 회피",
    detail: "존을 피할 수 있으면 우회하고, 불가피하면 경계에 가까운 얕은 통과를 우선합니다. 목적지 접근은 허용됩니다.",
    overlay: ZoneGuidanceOverlays.code["avoid-depth"],
  };
  return null;
}

function minimumWidth(poly: Point[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) return 0;
    const nx = -dy / length, ny = dx / length;
    let lo = Number.POSITIVE_INFINITY, hi = Number.NEGATIVE_INFINITY;
    for (const point of poly) {
      const projection = point.x * nx + point.y * ny;
      lo = Math.min(lo, projection); hi = Math.max(hi, projection);
    }
    result = Math.min(result, hi - lo);
  }
  return Number.isFinite(result) ? result : 0;
}

export function validateZoneForGuidance(kind: string, polygon: Point[]): ZoneValidation[] {
  if (polygon.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return [{ level: ZoneValidationLevels.code.error, message: "좌표를 확인하세요. 유효한 숫자만 사용할 수 있습니다." }];
  }
  if (polygon.length < 3 || !isSimplePolygon(polygon) || Math.abs(signedArea(polygon)) < 0.01) {
    return [{ level: ZoneValidationLevels.code.error, message: "단순한 3점 이상 다각형과 면적이 필요합니다." }];
  }
  if ((kind === ZoneKinds.code.prefer || kind === ZoneKinds.code.avoid) && minimumWidth(polygon) < SOFT_ZONE_MIN_WIDTH_PX) {
    return [{ level: ZoneValidationLevels.code.warning, message: `폭이 약 ${minimumWidth(polygon).toFixed(1)}px로 좁습니다. 로봇 몸체와 여유를 수용하지 못해 ${kind === ZoneKinds.code.prefer ? "내부 유도가 약해질 수 있습니다" : "경계 가까운 통과도 보장되지 않습니다"}.` }];
  }
  return [];
}
