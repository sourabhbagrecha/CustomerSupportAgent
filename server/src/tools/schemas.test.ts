import { describe, expect, it } from "vitest";
import { RawPaymentResultSchema } from "./schemas.js";

// Phase 3 runtime output validation (docs/plans/005): RawPaymentResultSchema
// is the single source of truth for the raw mock-provider response shape.
// ledger/pipeline.ts's callRawMockApi parses every provider response against
// this schema before trusting it; these tests pin the schema's actual
// acceptance behavior down so a future edit cannot silently loosen it.
describe("RawPaymentResultSchema", () => {
  it("accepts the real mock provider output shape", () => {
    const result = RawPaymentResultSchema.safeParse({
      paymentId: "pay_abc123def456",
      providerReference: "prov_9876543210",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing paymentId", () => {
    const result = RawPaymentResultSchema.safeParse({ providerReference: "prov_9876543210" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string paymentId", () => {
    const result = RawPaymentResultSchema.safeParse({ paymentId: "", providerReference: "prov_9876543210" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing providerReference", () => {
    const result = RawPaymentResultSchema.safeParse({ paymentId: "pay_abc123def456" });
    expect(result.success).toBe(false);
  });
});
