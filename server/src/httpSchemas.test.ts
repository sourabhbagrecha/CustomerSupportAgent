import { describe, expect, it } from "vitest";
import { ApprovalResolveRequestSchema, EvalRunRequestSchema, LedgerQuerySchema } from "./httpSchemas.js";

describe("LedgerQuerySchema", () => {
  it("applies defaults when the query string is empty", () => {
    const parsed = LedgerQuerySchema.parse({});
    expect(parsed).toEqual({ limit: 100, offset: 0 });
  });

  it("coerces string query values to numbers", () => {
    const parsed = LedgerQuerySchema.parse({ limit: "25", offset: "50" });
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(50);
  });

  it("accepts a valid status and threadId", () => {
    const parsed = LedgerQuerySchema.parse({ status: "denied", threadId: "cust_005_1" });
    expect(parsed.status).toBe("denied");
    expect(parsed.threadId).toBe("cust_005_1");
  });

  it("rejects a limit above the cap rather than clamping it", () => {
    expect(LedgerQuerySchema.safeParse({ limit: "5000" }).success).toBe(false);
    expect(LedgerQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(LedgerQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(LedgerQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
  });

  it("rejects a non-numeric limit", () => {
    expect(LedgerQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });
});

describe("ApprovalResolveRequestSchema", () => {
  it("accepts an approve decision with no notes at all", () => {
    expect(ApprovalResolveRequestSchema.safeParse({ decision: "approve" }).success).toBe(true);
  });

  it("accepts an approve decision with an internal note only", () => {
    const parsed = ApprovalResolveRequestSchema.safeParse({ decision: "approve", internalNote: "Goodwill exception." });
    expect(parsed.success).toBe(true);
  });

  it("rejects a reject decision with no customer-facing note", () => {
    expect(ApprovalResolveRequestSchema.safeParse({ decision: "reject" }).success).toBe(false);
  });

  it("rejects a reject decision with an internal note but no customer-facing note", () => {
    expect(
      ApprovalResolveRequestSchema.safeParse({ decision: "reject", internalNote: "Staff-only reasoning." }).success,
    ).toBe(false);
  });

  it("rejects a reject decision with a whitespace-only customer-facing note", () => {
    expect(ApprovalResolveRequestSchema.safeParse({ decision: "reject", customerNote: "   " }).success).toBe(false);
  });

  it("accepts a reject decision with a real customer-facing note", () => {
    const parsed = ApprovalResolveRequestSchema.safeParse({
      decision: "reject",
      customerNote: "Order was never delivered.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a reject decision with both an internal note and a customer-facing note", () => {
    const parsed = ApprovalResolveRequestSchema.safeParse({
      decision: "reject",
      internalNote: "Reviewer's private reasoning.",
      customerNote: "Order was never delivered.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a customer-facing note over the length bound", () => {
    const parsed = ApprovalResolveRequestSchema.safeParse({ decision: "approve", customerNote: "x".repeat(501) });
    expect(parsed.success).toBe(false);
  });

  it("rejects an internal note over the length bound", () => {
    const parsed = ApprovalResolveRequestSchema.safeParse({ decision: "approve", internalNote: "x".repeat(501) });
    expect(parsed.success).toBe(false);
  });
});

describe("EvalRunRequestSchema", () => {
  it("accepts the minimal body and defaults the key variable", () => {
    const parsed = EvalRunRequestSchema.parse({
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      primaryModel: "vendor/model-a",
    });
    expect(parsed.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(parsed.fallbackModel).toBeUndefined();
    expect(parsed.scenarios).toBeUndefined();
  });

  it("rejects a relative base URL, a non *_API_KEY variable name, and an empty scenario subset", () => {
    expect(EvalRunRequestSchema.safeParse({ baseUrl: "openrouter.ai/api/v1", primaryModel: "m" }).success).toBe(false);
    expect(
      EvalRunRequestSchema.safeParse({ baseUrl: "https://x.test/v1", primaryModel: "m", apiKeyEnv: "PATH" }).success,
    ).toBe(false);
    expect(
      EvalRunRequestSchema.safeParse({ baseUrl: "https://x.test/v1", primaryModel: "m", apiKeyEnv: "sk-raw-key" }).success,
    ).toBe(false);
    expect(EvalRunRequestSchema.safeParse({ baseUrl: "https://x.test/v1", primaryModel: "m", scenarios: [] }).success).toBe(
      false,
    );
    expect(EvalRunRequestSchema.safeParse({ baseUrl: "https://x.test/v1", primaryModel: "" }).success).toBe(false);
  });

  it("accepts a scenario subset and judge overrides", () => {
    const parsed = EvalRunRequestSchema.parse({
      baseUrl: "https://openrouter.ai/api/v1",
      primaryModel: "vendor/model-a",
      scenarios: [14, 18],
      judgeModel: "judge-z",
      judgeBaseUrl: "https://api.openai.com/v1",
      judgeApiKeyEnv: "OPENAI_API_KEY",
    });
    expect(parsed.scenarios).toEqual([14, 18]);
    expect(parsed.judgeModel).toBe("judge-z");
  });
});
