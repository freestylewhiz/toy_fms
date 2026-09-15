import { describe, expect, test } from "bun:test";
import {
  canAppendVertex,
  centroid,
  ensureCcw,
  isSimplePolygon,
  segmentsIntersect,
  translatePoly,
} from "./polygon.ts";

describe("polygon", () => {
  test("square is simple and ccw stays", () => {
    const sq = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isSimplePolygon(sq)).toBe(true);
    expect(ensureCcw(sq)[0]).toEqual({ x: 0, y: 0 });
  });

  test("bowtie / hourglass is not simple", () => {
    const bow = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(isSimplePolygon(bow)).toBe(false);
  });

  test("append that would cross is rejected", () => {
    const chain = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(canAppendVertex(chain, { x: 0, y: 10 })).toBe(true);
    expect(canAppendVertex(chain, { x: 0, y: -4 })).toBe(false);
  });

  test("crossing segments", () => {
    expect(segmentsIntersect(
      { x: 0, y: 0 }, { x: 10, y: 10 },
      { x: 0, y: 10 }, { x: 10, y: 0 },
    )).toBe(true);
    expect(segmentsIntersect(
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 10, y: 0 }, { x: 20, y: 0 },
    )).toBe(false);
  });

  test("centroid of square", () => {
    const c = centroid([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    expect(c.x).toBeCloseTo(5, 5);
    expect(c.y).toBeCloseTo(5, 5);
  });

  test("translate", () => {
    const moved = translatePoly([{ x: 1, y: 2 }], 3, 4);
    expect(moved[0]).toEqual({ x: 4, y: 6 });
  });
});
