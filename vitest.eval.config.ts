import { defineConfig } from "vitest/config";

// The 15 scenario evals. These make real OpenAI calls, so they run
// sequentially (not in parallel workers) to keep behavior easy to reason
// about and to avoid needless concurrent API load, and get a generous
// per-test timeout since a multi-tool-call turn can take tens of seconds.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    setupFiles: ["evals/setupEnv.ts"],
  },
});
