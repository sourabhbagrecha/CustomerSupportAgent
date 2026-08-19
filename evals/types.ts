// Shared, dependency-free types for the eval result-recording mechanism.
// Kept separate from harness.ts (which pulls in the full agent graph) so
// scripts/export-results.ts can import just the shapes it needs without
// dragging in better-sqlite3/langgraph.

export type ScenarioStatus = "pass" | "fail" | "documented_red";

export interface JudgeVerdict {
  toneOk: boolean;
  groundedOk: boolean;
  notes: string;
}

export interface ScenarioRecord {
  number: number;
  suffix?: string;
  name: string;
  status: ScenarioStatus;
  latencyMs: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  judge?: JudgeVerdict | null;
  note: string;
}
