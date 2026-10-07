export interface PanePlacement {
  /** Position in the grid: 0|2 on the first row, 1|3 on the second, then 4|5, 6|7, ... */
  slot: number;
  /** The worker pane to split, or undefined to split the coordinator's pane. */
  parentSlot: number | undefined;
  direction: "right" | "down";
}

/**
 * Worker panes fill a two-column grid to the right of the coordinator:
 *
 *   1 | 3
 *   2 | 4
 *   5 | 6
 *
 * Herdr splits one pane at a time, so each slot is made by splitting a fixed earlier slot.
 * A new worker takes the first free slot whose parent is open; failing that, it opens below
 * the newest worker. `openSlots` lists the open workers' slots in the order they opened.
 */
export function placeNextPane(openSlots: readonly number[]): PanePlacement {
  if (openSlots.length === 0) return { slot: 0, parentSlot: undefined, direction: "right" };
  const open = new Set(openSlots);
  const highest = Math.max(...openSlots);
  for (let slot = 1; slot <= highest + 2; slot += 1) {
    const parent = parentOf(slot);
    if (!open.has(slot) && open.has(parent.parentSlot)) return { slot, ...parent };
  }
  return { slot: highest + 1, parentSlot: openSlots.at(-1) ?? highest, direction: "down" };
}

function parentOf(slot: number): { parentSlot: number; direction: "right" | "down" } {
  const firstRows: Record<number, { parentSlot: number; direction: "right" | "down" }> = {
    1: { parentSlot: 0, direction: "down" },
    2: { parentSlot: 0, direction: "right" },
    3: { parentSlot: 1, direction: "right" },
    4: { parentSlot: 1, direction: "down" },
    5: { parentSlot: 3, direction: "down" },
  };
  return firstRows[slot] ?? { parentSlot: slot - 2, direction: "down" };
}
