import { describe, expect, it } from "vitest";
import { SlidingWindow } from "../src/services/sliding-window.js";

describe("SlidingWindow", () => {
  it("triggers only when the limit is reached inside the window", () => {
    const window = new SlidingWindow<string>();
    expect(window.add("actor", "one", 3, 1_000, 1_000).triggered).toBe(false);
    expect(window.add("actor", "two", 3, 1_000, 1_500).triggered).toBe(false);
    expect(window.add("actor", "three", 3, 1_000, 1_999).triggered).toBe(true);
  });

  it("drops occurrences older than the configured window", () => {
    const window = new SlidingWindow<string>();
    window.add("actor", "old", 2, 1_000, 1_000);
    const result = window.add("actor", "new", 2, 1_000, 2_001);
    expect(result.triggered).toBe(false);
    expect(result.occurrences.map((item) => item.value)).toEqual(["new"]);
  });
});
