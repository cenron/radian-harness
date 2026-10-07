import assert from "node:assert/strict";
import { test } from "node:test";
import { placeNextPane } from "../../../src/core/layout.ts";

test("workers fill a two-column grid beside the coordinator: 1|3, 2|4, 5|6, 7|8", () => {
  const placements = [];
  const open: number[] = [];
  for (let count = 0; count < 8; count += 1) {
    const placement = placeNextPane(open);
    placements.push([placement.slot, placement.parentSlot ?? "coordinator", placement.direction]);
    open.push(placement.slot);
  }
  assert.deepEqual(placements, [
    [0, "coordinator", "right"],
    [1, 0, "down"],
    [2, 0, "right"],
    [3, 1, "right"],
    [4, 1, "down"],
    [5, 3, "down"],
    [6, 4, "down"],
    [7, 5, "down"],
  ]);
});

test("a closed worker's place is reused when the pane it splits from is still open", () => {
  assert.deepEqual(placeNextPane([0, 2, 3]), { slot: 1, parentSlot: 0, direction: "down" });
  assert.deepEqual(placeNextPane([1, 2, 3]), { slot: 4, parentSlot: 1, direction: "down" });
});

test("with no workers open, the next one opens beside the coordinator again", () => {
  assert.deepEqual(placeNextPane([]), { slot: 0, parentSlot: undefined, direction: "right" });
});

test("when no place in the grid can be reached, the worker opens below the newest one", () => {
  assert.deepEqual(placeNextPane([2]), { slot: 3, parentSlot: 2, direction: "down" });
});
