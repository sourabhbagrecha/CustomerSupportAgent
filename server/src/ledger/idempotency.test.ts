import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "./idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    const b = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    expect(a).toBe(b);
  });

  it("normalizes amount formatting (500 === 500.00)", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 500);
    const b = deriveIdempotencyKey("thread1", "refund", "order1", 500.0);
    expect(a).toBe(b);
  });

  it("differs when the thread differs", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    const b = deriveIdempotencyKey("thread2", "refund", "order1", 450);
    expect(a).not.toBe(b);
  });

  it("differs when the action type differs", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    const b = deriveIdempotencyKey("thread1", "credit", "order1", 450);
    expect(a).not.toBe(b);
  });

  it("differs when the order differs", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    const b = deriveIdempotencyKey("thread1", "refund", "order2", 450);
    expect(a).not.toBe(b);
  });

  it("differs when the amount differs", () => {
    const a = deriveIdempotencyKey("thread1", "refund", "order1", 450);
    const b = deriveIdempotencyKey("thread1", "refund", "order1", 451);
    expect(a).not.toBe(b);
  });

  it("treats a null orderId (account-level credit) as its own stable bucket", () => {
    const a = deriveIdempotencyKey("thread1", "credit", null, 100);
    const b = deriveIdempotencyKey("thread1", "credit", null, 100);
    expect(a).toBe(b);
    const c = deriveIdempotencyKey("thread1", "credit", "order1", 100);
    expect(a).not.toBe(c);
  });
});
