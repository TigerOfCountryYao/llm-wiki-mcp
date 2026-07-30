import { describe, expect, it } from "vitest";
import {
  reduceSelectionState,
  type SelectionState,
} from "../src/selection.js";

function state(): SelectionState {
  return {
    cursor: 0,
    selected: [true, true, false],
    outcome: "active",
  };
}

describe("selection key state machine", () => {
  it("uses Down only to move", () => {
    const next = reduceSelectionState(state(), "down");
    expect(next.cursor).toBe(1);
    expect(next.selected).toEqual([true, true, false]);
  });

  it("uses Space only to toggle", () => {
    const next = reduceSelectionState(state(), "space");
    expect(next.cursor).toBe(0);
    expect(next.selected).toEqual([false, true, false]);
  });

  it("uses Enter only to confirm", () => {
    const next = reduceSelectionState(state(), "enter");
    expect(next.outcome).toBe("confirmed");
    expect(next.cursor).toBe(0);
    expect(next.selected).toEqual([true, true, false]);
  });

  it("wraps Up without changing selection", () => {
    const next = reduceSelectionState(state(), "up");
    expect(next.cursor).toBe(2);
    expect(next.selected).toEqual([true, true, false]);
  });

  it("uses Escape to cancel", () => {
    expect(reduceSelectionState(state(), "escape").outcome).toBe("cancelled");
  });
});
