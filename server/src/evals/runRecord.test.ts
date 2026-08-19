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
  describeRunCost,
  groupByScenario,
  isValidRunId,
  listScenarioFiles,
  runCostUsd,
  slugify,
  type EvalRun,
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
      },
    ],
    pricing: null,
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
      },
    ]);
    expect(md).toContain("| 14 | all-models-down-degraded | PASS | 2453 ms | n/a | n/a |");
    expect(md).toContain("scenario 14: newly passing (was fail)");
    expect(md).toContain("Run id: 20260819T151556Z-sample");
    expect(md).not.toContain("sk-");
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
