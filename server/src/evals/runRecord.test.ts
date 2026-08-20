import { describe, expect, it } from "vitest";
import type { ScenarioRecord } from "../../../evals/types.js";
import {
  EvalRunSchema,
  buildLegacyMetadata,
  buildMarkdown,
  buildRunId,
  combineJudgeState,
  combineStatus,
  compactTimestamp,
  costUsd,
  countJudgeStates,
  describeJudgeCalibration,
  describeRunCost,
  findRegressions,
  groupByScenario,
  isValidRunId,
  listScenarioFiles,
  mergeRepeatGroups,
  reconcileExpectedScenarios,
  repeatRatioLabel,
  repeatSummary,
  runCostUsd,
  slugify,
  type EvalRun,
  type EvalScenario,
} from "./runRecord.js";

describe("run ids", () => {
  it("compacts an ISO timestamp so ids sort by time", () => {
    expect(compactTimestamp("2026-08-19T15:15:56.157Z")).toBe("20260819T151556Z");
  });

  it("slugifies labels and never yields an empty slug", () => {
    expect(slugify("gpt-5.4-mini baseline")).toBe("gpt-5-4-mini-baseline");
    expect(slugify("  DeepSeek / v4 Flash (OpenRouter)  ")).toBe("deepseek-v4-flash-openrouter");
    expect(slugify("***")).toBe("run");
    expect(slugify("x".repeat(100))).toHaveLength(48);
  });

  it("builds an id from timestamp and label, and validates ids for use as a path segment", () => {
    const id = buildRunId("2026-08-19T15:15:56.157Z", "gpt-5.4-mini baseline");
    expect(id).toBe("20260819T151556Z-gpt-5-4-mini-baseline");
    expect(isValidRunId(id)).toBe(true);
    expect(isValidRunId("../etc/passwd")).toBe(false);
    expect(isValidRunId("a/b")).toBe(false);
    expect(isValidRunId("")).toBe(false);
    expect(isValidRunId("-leading-dash")).toBe(false);
  });
});

describe("combineStatus / combineJudgeState", () => {
  it("fail beats documented_red beats pass across sub-cases", () => {
    expect(combineStatus(["pass", "pass"])).toBe("pass");
    expect(combineStatus(["pass", "documented_red"])).toBe("documented_red");
    expect(combineStatus(["documented_red", "fail"])).toBe("fail");
  });

  it("unscored beats scored beats null across sub-cases", () => {
    expect(combineJudgeState([null, null])).toBe(null);
    expect(combineJudgeState([null, "scored"])).toBe("scored");
    expect(combineJudgeState(["scored", "unscored"])).toBe("unscored");
  });
});

describe("groupByScenario", () => {
  const records: ScenarioRecord[] = [
    {
      number: 7,
      suffix: "reject",
      name: "above-cap-approval",
      status: "pass",
      latencyMs: 4000,
      tokensIn: null,
      tokensOut: null,
      judgeState: null,
      note: "reject path ok",
    },
    {
      number: 7,
      suffix: "approve",
      name: "above-cap-approval",
      status: "documented_red",
      latencyMs: 6000,
      tokensIn: 100,
      tokensOut: 10,
      judge: { state: "scored", toneOk: true, groundedOk: true, notes: "calm" },
      judgeState: "scored",
      note: "approve path red",
    },
    {
      number: 1,
      name: "failed-delivery-refund",
      status: "pass",
      latencyMs: 3617,
      tokensIn: 10343,
      tokensOut: 106,
      judge: { state: "unscored", notes: "judge unavailable: boom" },
      judgeState: "unscored",
      note: "refund once",
    },
  ];

  it("groups sub-cases per scenario, sums metrics, sorts by number, and prefixes sub-case notes", () => {
    const groups = groupByScenario(records);
    expect(groups.map((g) => g.number)).toEqual([1, 7]);
    const seven = groups[1]!;
    expect(seven.status).toBe("documented_red");
    expect(seven.latencyMs).toBe(10000);
    expect(seven.tokensIn).toBe(100);
    expect(seven.tokensOut).toBe(10);
    expect(seven.notes).toEqual(["[approve] approve path red", "[reject] reject path ok"]);
    expect(seven.judgeNotes).toEqual(["[approve] calm"]);
    expect(seven.judgeState).toBe("scored");
    const one = groups[0]!;
    expect(one.judgeState).toBe("unscored");
    expect(one.judgeNotes).toEqual(["judge unavailable: boom"]);
  });

  it("keeps token totals null when no sub-case reported them, rather than fabricating 0", () => {
    const groups = groupByScenario([records[0]!]);
    expect(groups[0]!.tokensIn).toBeNull();
    expect(groups[0]!.tokensOut).toBeNull();
  });

  it("counts judge states per group", () => {
    expect(countJudgeStates(groupByScenario(records))).toEqual({ scored: 1, unscored: 1, notApplicable: 0 });
  });
});

function sampleRun(): EvalRun {
  return {
    schemaVersion: 1,
    runId: "20260819T151556Z-sample",
    label: "sample",
    source: "ui",
    status: "completed",
    startedAt: "2026-08-19T15:15:56.157Z",
    finishedAt: "2026-08-19T15:20:00.000Z",
    durationMs: 243843,
    exitCode: 0,
    failureReason: null,
    provider: {
      baseUrl: "https://openrouter.ai/api/v1",
      primaryModel: "vendor/model-a",
      fallbackModel: "vendor/model-a",
      judgeModel: "judge-z",
      judgeBaseUrl: "https://api.openai.com/v1",
    },
    scenarioFilter: [14],
    gitCommit: "abc123",
    promptSha256: "p",
    fixturesSha256: "f",
    judgeStates: { scored: 0, unscored: 0, notApplicable: 1 },
    scenarios: [
      {
        number: 14,
        name: "all-models-down-degraded",
        status: "pass",
        latencyMs: 2453,
        tokensIn: null,
        tokensOut: null,
        notes: ["degraded reply"],
        judgeNotes: [],
        judgeState: null,
        repeatCount: 1,
        repeatPassCount: 1,
        repeatStatuses: ["pass"],
        latencyMeanMs: 2453,
        latencySpreadMs: 0,
      },
    ],
    pricing: null,
    incompleteScenarios: [],
    judgeCalibration: null,
  };
}

function pricedRun(): EvalRun {
  const run = sampleRun();
  run.pricing = {
    source: "openrouter",
    openrouterModelId: "vendor/model-a",
    promptUsdPerMillion: 0.75,
    completionUsdPerMillion: 4.5,
    fetchedAt: "2026-08-19T15:15:57.000Z",
  };
  run.scenarios = [
    { ...run.scenarios[0]!, number: 1, tokensIn: 10_000, tokensOut: 1_000 },
    { ...run.scenarios[0]!, number: 2, tokensIn: 20_000, tokensOut: null },
    { ...run.scenarios[0]!, number: 14 },
  ];
  return run;
}

describe("EvalRunSchema", () => {
  it("round-trips a record and rejects a key field or a bad status", () => {
    const run = sampleRun();
    expect(EvalRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(EvalRunSchema.safeParse({ ...run, status: "done" }).success).toBe(false);
    expect(EvalRunSchema.safeParse({ ...run, schemaVersion: 2 }).success).toBe(false);
    // Strictness on provider: an unknown key is stripped, not kept, so a
    // record can never smuggle an apiKey field into the archive.
    const parsed = EvalRunSchema.parse({ ...run, provider: { ...run.provider, apiKey: "sk-leak" } });
    expect("apiKey" in parsed.provider).toBe(false);
  });

  it("defaults pricing to null for records written before the cost column existed, and round-trips a priced one", () => {
    const { pricing: _omitted, ...legacy } = sampleRun();
    expect(EvalRunSchema.parse(JSON.parse(JSON.stringify(legacy))).pricing).toBeNull();
    const priced = pricedRun();
    expect(EvalRunSchema.parse(JSON.parse(JSON.stringify(priced)))).toEqual(priced);
    expect(EvalRunSchema.safeParse({ ...priced, pricing: { ...priced.pricing, promptUsdPerMillion: -1 } }).success).toBe(false);
  });
});

describe("cost", () => {
  it("prices tokens per million and never fabricates a figure without rates or counts", () => {
    const pricing = pricedRun().pricing;
    expect(costUsd(10_000, 1_000, pricing)).toBeCloseTo(0.0075 + 0.0045, 10);
    expect(costUsd(20_000, null, pricing)).toBeCloseTo(0.015, 10);
    expect(costUsd(null, null, pricing)).toBeNull();
    expect(costUsd(10_000, 1_000, null)).toBeNull();
  });

  it("sums a run's priced scenarios, skipping model-free ones rather than counting them as 0", () => {
    expect(runCostUsd(pricedRun())).toBeCloseTo(0.027, 10);
    expect(runCostUsd(sampleRun())).toBeNull();
    expect(runCostUsd({ ...pricedRun(), scenarios: [sampleRun().scenarios[0]!] })).toBeNull();
  });

  it("describes the cost line for RESULTS.md with its rates and caveat, or the reason there is none", () => {
    expect(describeRunCost(pricedRun())).toBe(
      "$0.0270 (vendor/model-a at $0.75 in / $4.5 out per 1M tokens, OpenRouter list price fetched 2026-08-19; agent tokens only, judge calls not counted)",
    );
    expect(describeRunCost(sampleRun())).toBe("n/a (no OpenRouter price recorded for the primary model)");
    expect(buildMarkdown(pricedRun(), null)).toContain("- Cost: $0.0270 (vendor/model-a");
  });
});

describe("legacy export", () => {
  it("derives the results.json metadata block from a run", () => {
    expect(buildLegacyMetadata(sampleRun())).toEqual({
      primaryModel: "vendor/model-a",
      fallbackModel: "vendor/model-a",
      gitCommit: "abc123",
      runCount: 1,
      judgeStates: { scored: 0, unscored: 0, notApplicable: 1 },
      promptSha256: "p",
      fixturesSha256: "f",
    });
  });

  it("renders the markdown table and the diff against a previous run", () => {
    const md = buildMarkdown(sampleRun(), [
      {
        number: 14,
        name: "all-models-down-degraded",
        status: "fail",
        latencyMs: 1,
        tokensIn: null,
        tokensOut: null,
        notes: [],
        judgeNotes: [],
        judgeState: null,
        repeatCount: 1,
        repeatPassCount: 0,
        repeatStatuses: ["fail"],
        latencyMeanMs: 1,
        latencySpreadMs: 0,
      },
    ]);
    expect(md).toContain("| 14 | all-models-down-degraded | PASS | 1/1 | 2453 ms | n/a | n/a |");
    expect(md).toContain("scenario 14: newly passing (was fail)");
    expect(md).toContain("Run id: 20260819T151556Z-sample");
    expect(md).toContain("Judge calibration: not computed for this run");
    expect(md).not.toContain("sk-");
  });
});

function scenario(overrides: Partial<EvalScenario> & Pick<EvalScenario, "number" | "status">): EvalScenario {
  return {
    name: `scenario-${overrides.number}`,
    latencyMs: null,
    tokensIn: null,
    tokensOut: null,
    notes: [],
    judgeNotes: [],
    judgeState: null,
    repeatCount: 1,
    repeatPassCount: overrides.status === "pass" ? 1 : 0,
    repeatStatuses: [overrides.status],
    latencyMeanMs: null,
    latencySpreadMs: null,
    ...overrides,
  };
}

describe("reconcileExpectedScenarios (denominator discipline)", () => {
  const expected = [
    { number: 1, name: "one", file: "01-one.eval.test.ts" },
    { number: 2, name: "two", file: "02-two.eval.test.ts" },
    { number: 3, name: "three", file: "03-three.eval.test.ts" },
  ];

  it("passes through every expected scenario that has a real result", () => {
    const present = [scenario({ number: 1, status: "pass" }), scenario({ number: 2, status: "fail" }), scenario({ number: 3, status: "pass" })];
    const { scenarios, missingNumbers } = reconcileExpectedScenarios(present, expected);
    expect(scenarios.map((s) => s.status)).toEqual(["pass", "fail", "pass"]);
    expect(missingNumbers).toEqual([]);
  });

  it("fills a missing expected scenario with a synthetic fail instead of shrinking the denominator", () => {
    const present = [scenario({ number: 1, status: "pass" }), scenario({ number: 3, status: "pass" })];
    const { scenarios, missingNumbers } = reconcileExpectedScenarios(present, expected);
    expect(scenarios).toHaveLength(3);
    expect(missingNumbers).toEqual([2]);
    const two = scenarios.find((s) => s.number === 2)!;
    expect(two.status).toBe("fail");
    expect(two.repeatStatuses).toEqual(["fail"]);
    expect(two.notes[0]).toContain("No result was recorded");
  });

  it("marks every expected scenario as a synthetic fail when nothing ran at all", () => {
    const { scenarios, missingNumbers } = reconcileExpectedScenarios([], expected);
    expect(scenarios).toHaveLength(3);
    expect(missingNumbers).toEqual([1, 2, 3]);
    expect(scenarios.every((s) => s.status === "fail")).toBe(true);
  });
});

describe("repeatSummary / repeatRatioLabel", () => {
  it("reports N/N for a legacy record with no repeat fields populated, derived from status", () => {
    const legacyPass = scenario({ number: 1, status: "pass", repeatStatuses: [], repeatPassCount: 0 });
    expect(repeatSummary(legacyPass)).toEqual({ count: 1, passCount: 1, statuses: ["pass"] });
    expect(repeatRatioLabel(legacyPass)).toBe("1/1");

    const legacyFail = scenario({ number: 2, status: "fail", repeatStatuses: [], repeatPassCount: 0 });
    expect(repeatSummary(legacyFail)).toEqual({ count: 1, passCount: 0, statuses: ["fail"] });
    expect(repeatRatioLabel(legacyFail)).toBe("0/1");
  });

  it("reports the real ratio once repeat fields are populated", () => {
    const repeated = scenario({
      number: 1,
      status: "fail",
      repeatCount: 3,
      repeatPassCount: 2,
      repeatStatuses: ["pass", "pass", "fail"],
    });
    expect(repeatRatioLabel(repeated)).toBe("2/3");
  });
});

describe("mergeRepeatGroups", () => {
  it("is an identity for a single repeat, filling repeat fields from status", () => {
    const group = [scenario({ number: 1, status: "pass", latencyMs: 500 })];
    const merged = mergeRepeatGroups([group]);
    expect(merged[0]!.repeatCount).toBe(1);
    expect(merged[0]!.repeatPassCount).toBe(1);
    expect(merged[0]!.latencyMeanMs).toBe(500);
    expect(merged[0]!.latencySpreadMs).toBe(0);
  });

  it("combines repeats: fails overall if any repeat failed, reports the pass ratio and latency spread", () => {
    const run1 = [scenario({ number: 1, status: "pass", latencyMs: 1000 })];
    const run2 = [scenario({ number: 1, status: "pass", latencyMs: 2000 })];
    const run3 = [scenario({ number: 1, status: "fail", latencyMs: 3000, notes: ["assertion failed"] })];
    const merged = mergeRepeatGroups([run1, run2, run3]);
    expect(merged).toHaveLength(1);
    const s = merged[0]!;
    expect(s.status).toBe("fail");
    expect(s.repeatCount).toBe(3);
    expect(s.repeatPassCount).toBe(2);
    expect(s.repeatStatuses).toEqual(["pass", "pass", "fail"]);
    expect(s.latencyMeanMs).toBe(2000);
    expect(s.latencySpreadMs).toBe(2000);
    expect(s.notes).toEqual(["[run 3] assertion failed"]);
  });

  it("passes overall only when every repeat passed", () => {
    const allPass = mergeRepeatGroups([
      [scenario({ number: 1, status: "pass" })],
      [scenario({ number: 1, status: "pass" })],
    ]);
    expect(allPass[0]!.status).toBe("pass");
    expect(allPass[0]!.repeatPassCount).toBe(2);
  });
});

describe("findRegressions (CI gate)", () => {
  it("flags a baseline-passing scenario that now fails, naming it", () => {
    const baseline = [scenario({ number: 1, status: "pass", name: "policy-cap" }), scenario({ number: 2, status: "fail" })];
    const current = [scenario({ number: 1, status: "fail", name: "policy-cap" }), scenario({ number: 2, status: "pass" })];
    const regressions = findRegressions(baseline, current);
    expect(regressions).toEqual([{ number: 1, name: "policy-cap", previousStatus: "pass", currentStatus: "fail" }]);
  });

  it("simulates a deliberately-broken policy cap: a previously-passing cap scenario regressing is the exact acceptance case for evals:gate", () => {
    // Stand-in for "monkeypatch a cap value and rerun": the deterministic
    // effect of a broken cap is that a scenario asserting the capped amount
    // (e.g. scenario 6/7/20's INR 500 cap check) flips from pass to fail.
    // Exercising that transition here proves findRegressions (the core of
    // `npm run evals:gate`) reports it correctly and by name, without an
    // actual paid run or touching the real policy engine/fixtures.
    const baseline = [scenario({ number: 6, status: "pass", name: "prior-promise-vs-cap" })];
    const brokenCapRun = [scenario({ number: 6, status: "fail", name: "prior-promise-vs-cap", notes: ["expected amount 500, got 1000"] })];
    const regressions = findRegressions(baseline, brokenCapRun);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.number).toBe(6);
    expect(regressions[0]!.name).toBe("prior-promise-vs-cap");
  });

  it("treats a scenario missing entirely from the current run as a regression, never a silent skip", () => {
    const baseline = [scenario({ number: 1, status: "pass" })];
    const regressions = findRegressions(baseline, []);
    expect(regressions).toEqual([{ number: 1, name: "scenario-1", previousStatus: "pass", currentStatus: "fail" }]);
  });

  it("never flags a baseline scenario that was already failing, or a new scenario with no baseline", () => {
    const baseline = [scenario({ number: 1, status: "fail" })];
    const current = [scenario({ number: 1, status: "fail" }), scenario({ number: 2, status: "fail" })];
    expect(findRegressions(baseline, current)).toEqual([]);
  });
});

describe("describeJudgeCalibration", () => {
  it("reports agreement percentage and marks the golden set as drafted/pending review", () => {
    const text = describeJudgeCalibration({
      goldenSetVersion: "v1",
      computedAt: "2026-08-20T00:00:00.000Z",
      total: 12,
      agreeing: 10,
      agreementPct: (10 / 12) * 100,
      judgeModel: "gpt-5.4-mini",
      disagreements: [],
    });
    expect(text).toContain("10/12");
    expect(text).toContain("83%");
    expect(text).toContain("drafted/ASSUMED, pending human review");
    expect(text).toContain("gpt-5.4-mini");
  });

  it("reports absence plainly when not computed", () => {
    expect(describeJudgeCalibration(null)).toBe("not computed for this run (only computed for a full-suite run)");
  });
});

describe("listScenarioFiles", () => {
  it("parses the committed scenario files into a numbered catalogue", () => {
    const files = listScenarioFiles();
    expect(files.length).toBeGreaterThanOrEqual(19);
    expect(files[0]).toEqual({ number: 1, name: "failed-delivery-refund", file: "01-failed-delivery-refund.eval.test.ts" });
    expect(files.find((f) => f.number === 14)?.name).toBe("all-models-down-degraded");
  });
});
