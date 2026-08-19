import { describe, expect, it } from "vitest";
import { paretoFrontier, scenarioDisagrees, type ParetoPoint } from "./evalMath";

// Pure functions only: the comparison chart claims "these runs are the
// shortlist" and the heatmap filter claims "these are the scenarios that
// discriminate". Both claims are deterministic, so they are tested here; the
// rendering around them is not (no DOM, no LLM, per CLAUDE.md).

function ids(points: ParetoPoint[]): string[] {
  return [...paretoFrontier(points)].sort();
}

describe("paretoFrontier", () => {
  it("keeps the cheapest run at each quality level and drops the rest", () => {
    const points: ParetoPoint[] = [
      { id: "cheap-perfect", x: 0.02, y: 1 },
      { id: "dear-perfect", x: 0.37, y: 1 },
      { id: "cheap-poor", x: 0.01, y: 0.4 },
    ];
    // dear-perfect is beaten by cheap-perfect on cost at equal quality;
    // cheap-poor survives because nothing is cheaper than it.
    expect(ids(points)).toEqual(["cheap-perfect", "cheap-poor"]);
  });

  it("treats two runs on the same point as both non-dominated", () => {
    const points: ParetoPoint[] = [
      { id: "a", x: 0.1, y: 0.9 },
      { id: "b", x: 0.1, y: 0.9 },
    ];
    expect(ids(points)).toEqual(["a", "b"]);
  });

  it("drops a run that ties on one axis and loses on the other", () => {
    expect(
      ids([
        { id: "same-cost-better", x: 0.1, y: 0.95 },
        { id: "same-cost-worse", x: 0.1, y: 0.6 },
      ]),
    ).toEqual(["same-cost-better"]);
    expect(
      ids([
        { id: "same-quality-cheaper", x: 0.05, y: 0.8 },
        { id: "same-quality-dearer", x: 0.5, y: 0.8 },
      ]),
    ).toEqual(["same-quality-cheaper"]);
  });

  it("keeps every point when no run beats another on both axes", () => {
    expect(
      ids([
        { id: "free-but-weak", x: 0, y: 0.5 },
        { id: "mid", x: 0.1, y: 0.8 },
        { id: "dear-but-perfect", x: 0.4, y: 1 },
      ]),
    ).toEqual(["dear-but-perfect", "free-but-weak", "mid"]);
  });

  it("returns an empty set for no points and the sole point for one", () => {
    expect(ids([])).toEqual([]);
    expect(ids([{ id: "only", x: 3, y: 0.1 }])).toEqual(["only"]);
  });
});

describe("scenarioDisagrees", () => {
  it("is false when every selected run reached the same status", () => {
    expect(scenarioDisagrees(["pass", "pass", "pass"])).toBe(false);
    expect(scenarioDisagrees(["fail", "fail"])).toBe(false);
  });

  it("is true when any run differs", () => {
    expect(scenarioDisagrees(["pass", "fail", "pass"])).toBe(true);
    expect(scenarioDisagrees(["pass", "documented_red"])).toBe(true);
  });

  it("counts a run that did not run the scenario as a differing state", () => {
    expect(scenarioDisagrees(["pass", null])).toBe(true);
    expect(scenarioDisagrees([null, null])).toBe(false);
  });

  it("is false below two runs, where there is nothing to disagree with", () => {
    expect(scenarioDisagrees([])).toBe(false);
    expect(scenarioDisagrees(["fail"])).toBe(false);
  });
});
