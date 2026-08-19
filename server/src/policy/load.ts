import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PolicyDocumentSchema, type PolicyDocument } from "./schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_JSON_PATH = join(__dirname, "..", "..", "..", "fixtures", "policy.json");

let cached: PolicyDocument | undefined;

// fixtures/policy.json is committed, generated once by scripts/generate-fixtures.ts
// from fixtures/policy.source.json (same source as policy.md, so the two can
// never drift). Cached in-process; the server restarts to pick up changes.
export function loadPolicyDocument(): PolicyDocument {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(POLICY_JSON_PATH, "utf-8"));
  cached = PolicyDocumentSchema.parse(raw);
  return cached;
}
