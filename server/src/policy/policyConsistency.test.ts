import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolicyDocumentSchema } from "./schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "fixtures");

// Walks the parsed policy.json value tree and collects every numeric leaf
// (the caps and the refund window), regardless of nesting depth.
function collectNumbers(value: unknown, out: Set<number>): void {
  if (typeof value === "number") {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, out);
  }
}

describe("policy.md / policy.json consistency", () => {
  it("every number in policy.json also appears verbatim in policy.md", () => {
    const rawPolicy: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, "policy.json"), "utf-8"));
    const policy = PolicyDocumentSchema.parse(rawPolicy);
    const policyMd = readFileSync(join(FIXTURES_DIR, "policy.md"), "utf-8");

    const numbers = new Set<number>();
    collectNumbers(policy, numbers);

    // Sanity check: policy.json should actually contain limits to compare.
    expect(numbers.size).toBeGreaterThan(0);

    for (const n of numbers) {
      expect(policyMd.includes(String(n))).toBe(true);
    }
  });
});
