import { defineConfig } from "vitest/config";

// Deterministic unit tests only: policy engine verdicts, idempotency key
// derivation, ledger state transitions, reconciliation, retrieval ranking,
// policy.md/policy.json consistency. Never the LLM itself (that's evals/).
export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts"],
    environment: "node",
  },
});
