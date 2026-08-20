// Shared, dependency-free types for the eval result-recording mechanism.
// Kept separate from harness.ts (which pulls in the full agent graph) so
// scripts/export-results.ts can import just the shapes it needs without
// dragging in better-sqlite3/langgraph.

export type ScenarioStatus = "pass" | "fail" | "documented_red";

// A judge call either produced a scored verdict or it did not run to
// completion (missing env, network error, empty response, unparseable or
// malformed JSON). Judge outages never fail the eval suite, but they must
// stay visible rather than being silently treated as a pass: there is no
// "neutral" verdict anymore, only scored or unscored.
export type JudgeVerdict =
  | { state: "scored"; toneOk: boolean; groundedOk: boolean; notes: string }
  | { state: "unscored"; notes: string };

// null means the scenario does not call the judge at all (most fault-injection
// and guardrail scenarios have nothing free-text worth judging).
export type JudgeState = "scored" | "unscored" | null;

export interface ScenarioRecord {
  number: number;
  suffix?: string;
  name: string;
  status: ScenarioStatus;
  latencyMs: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  judge?: JudgeVerdict | null;
  judgeState: JudgeState;
  note: string;
  // Which repeat pass (1-based) wrote this record, when the scenario suite
  // is run more than once per scenario (task P1-6 "repeats", see
  // EVAL_REPEAT_INDEX in evals/harness.ts and server/src/evals/runner.ts).
  // Absent/1 for a normal single run, so every artifact written before this
  // existed still reads the same way.
  repeatIndex?: number;
}
