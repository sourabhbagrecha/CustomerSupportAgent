import { defineConfig } from "vitest/config";

// Deterministic unit tests only: policy engine verdicts, idempotency key
// derivation, ledger state transitions, reconciliation, retrieval ranking,
// policy.md/policy.json consistency. Never the LLM itself (that's evals/).
export default defineConfig({
  test: {
    // web/ is included for its pure presentation math only (evalMath: pareto
    // frontier, disagreement detection). No component or DOM tests live here;
    // the environment stays "node" deliberately. scripts/ is included for the
    // fixture date-shift arithmetic (scripts/seedFixtures.test.ts), which is
    // deterministic and model-free like everything else in this suite.
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
  },
});
