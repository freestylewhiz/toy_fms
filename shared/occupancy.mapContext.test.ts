import { expect, test } from "bun:test";
import { MAP_HEIGHT, MAP_ID, MAP_WIDTH } from "./constants.ts";
import { isFree, prepareMapContext, commitMapContext } from "./occupancy.ts";

test("map context swaps atomically and preserves active context on load failure", () => {
  const original = { id: MAP_ID, width: MAP_WIDTH, height: MAP_HEIGHT };
  const destination = prepareMapContext("large_lab");
  expect(destination.width).toBe(10000);
  expect(destination.height).toBe(10000);
  commitMapContext(destination);
  expect(MAP_ID).toBe("large_lab");
  expect(MAP_WIDTH).toBe(10000);
  expect(isFree(0, 0)).toBe(false);
  expect(() => prepareMapContext("missing-map")).toThrow();
  // Restore the process context for other tests in this worker.
  commitMapContext(prepareMapContext(original.id));
  expect(MAP_ID).toBe(original.id);
});
