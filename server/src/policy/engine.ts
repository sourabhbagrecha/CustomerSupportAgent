import type Database from "better-sqlite3";
import type { ActionType, Order } from "../tools/schemas.js";
import type { PolicyDocument, PolicyVerdict } from "./schemas.js";

export interface PolicyCheckInput {
  actionType: ActionType;
  orderId: string | null;
  amount: number;
}

function loadOrder(db: Database.Database, orderId: string): Order | undefined {
  const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as
    | {
        id: string;
        customer_id: string;
        item_name: string;
        amount: number;
        currency: "INR";
        status: Order["status"];
        order_date: string;
        delivery_date: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    customerId: row.customer_id,
    itemName: row.item_name,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    orderDate: row.order_date,
    deliveryDate: row.delivery_date,
  };
}

function refundableBalance(db: Database.Database, orderId: string): number {
  const charged = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ? AND type = 'charge' AND status = 'succeeded'`)
    .get(orderId) as { total: number };
  const refunded = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ? AND type = 'refund' AND status = 'succeeded'`)
    .get(orderId) as { total: number };
  return charged.total - refunded.total;
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

// Deterministic, side-effect-free: given the requested action and the
// current DB state, decide allow / requires_approval / deny. This is the
// layer that makes the money path jailbreak-proof: it never reads the
// model's reasoning or claimed authority, only order/payment facts and the
// policy.json caps. Called by the ledger pipeline BEFORE any ledger write.
export function evaluatePolicy(
  db: Database.Database,
  policy: PolicyDocument,
  input: PolicyCheckInput,
  now: string = new Date().toISOString(),
): PolicyVerdict {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { verdict: "deny", denyReason: "invalid_amount", reason: "Requested amount must be a positive number." };
  }

  if (input.orderId) {
    const order = loadOrder(db, input.orderId);
    if (!order) {
      return { verdict: "deny", denyReason: "order_not_found", reason: `No order found with id ${input.orderId}.` };
    }

    if (input.actionType === "refund") {
      if (!policy.eligibleOrderStatusesForRefund.includes(order.status)) {
        return {
          verdict: "deny",
          denyReason: "order_not_eligible_status",
          reason: `Order status "${order.status}" is not eligible for a refund.`,
        };
      }

      const windowAnchor = order.deliveryDate ?? order.orderDate;
      const ageDays = daysBetween(windowAnchor, now);
      if (ageDays > policy.refundWindowDays) {
        return {
          verdict: "deny",
          denyReason: "outside_refund_window",
          reason: `Order is ${Math.floor(ageDays)} days past delivery/order date, outside the ${policy.refundWindowDays}-day refund window.`,
        };
      }

      const available = refundableBalance(db, input.orderId);
      if (input.amount > available) {
        return {
          verdict: "deny",
          denyReason: "exceeds_refundable_amount",
          reason: `Requested amount ${input.amount} exceeds the refundable balance of ${available} on this order.`,
        };
      }
    }
  }

  const cap = input.actionType === "refund" ? policy.maxAutoRefundINR : policy.maxAutoCreditINR;
  if (input.amount > cap) {
    return {
      verdict: "requires_approval",
      reason: `Requested amount ${input.amount} exceeds the auto-${input.actionType} cap of ${cap} INR and requires human approval.`,
    };
  }

  return { verdict: "allow", reason: `Within policy: amount ${input.amount} <= cap ${cap} INR.` };
}
