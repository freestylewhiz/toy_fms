import { describe, expect, test } from "bun:test";
import { SOFT_ZONE_MIN_WIDTH_PX, validateZoneForGuidance, zoneGuidance } from "./zoneGuidance.ts";

describe("soft zone operator guidance", () => {
  test("describes prefer as inner guidance and avoid as shallow edge use", () => {
    expect(zoneGuidance("prefer")?.overlay).toBe("prefer-inner");
    expect(zoneGuidance("prefer")?.detail).toContain("폭이 부족");
    expect(zoneGuidance("avoid")?.overlay).toBe("avoid-depth");
    expect(zoneGuidance("avoid")?.detail).toContain("경계");
  });

  test("warns when a soft zone cannot accommodate the configured body margin", () => {
    const narrow = [{ x: 0, y: 0 }, { x: SOFT_ZONE_MIN_WIDTH_PX - 1, y: 0 }, { x: SOFT_ZONE_MIN_WIDTH_PX - 1, y: 100 }, { x: 0, y: 100 }];
    expect(validateZoneForGuidance("prefer", narrow)[0]?.level).toBe("warning");
    expect(validateZoneForGuidance("avoid", narrow)[0]?.message).toContain("경계 가까운 통과");
  });

  test("rejects self-crossing and degenerate polygons", () => {
    expect(validateZoneForGuidance("prefer", [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }, { x: 20, y: 0 }])[0]?.level).toBe("error");
    expect(validateZoneForGuidance("avoid", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }])[0]?.level).toBe("error");
  });
});
