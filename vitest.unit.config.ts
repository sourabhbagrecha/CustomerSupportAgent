import { defineConfig } from "vitest/config";

// Deterministic unit tests only: policy engine verdicts, idempotency key
// derivation, ledger state transitions, reconciliation, retrieval ranking,
// policy.md/policy.json consistency. Never the LLM itself (that's evals/).
export default defineConfig({
  test: {
    // web/ is included for its pure presentation math only (evalMath: pareto
    // frontier, disagreement detection). No component or DOM tests live here;
    // the environment stays "node" deliberately.
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
  },
});
