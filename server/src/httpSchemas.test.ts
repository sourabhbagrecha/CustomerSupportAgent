import { describe, expect, it } from "vitest";
import { LedgerQuerySchema } from "./httpSchemas.js";

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
