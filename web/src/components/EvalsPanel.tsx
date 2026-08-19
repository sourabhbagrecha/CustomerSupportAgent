// App.tsx's Evals tab entry point. The actual "compare eval runs" workbench
// (plan 007) lives in components/evals/, split into EvalsPanel (container),
// RunLauncher, RunsTable, and RunComparison; this file just keeps the import
// path App.tsx already uses stable.
export { EvalsPanel } from "./evals/EvalsPanel";
