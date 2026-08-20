import type Database from "better-sqlite3";
import type { ActionType, Order, Payment, PaymentType } from "../tools/schemas.js";
import type { PolicyDocument, PolicyVerdict } from "./schemas.js";

export interface PolicyCheckInput {
  actionType: ActionType;
  orderId: string | null;
  amount: number;
  customerId: string;
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

// The money that has moved (or is moving) on one order, split by direction
// and by settlement status. Both balance functions read from this, so they
// can never disagree about what an order still owes.
interface OrderMoney {
  // Charges that have actually settled.
  charged: number;
  // Refunds that have settled at the provider.
  refundedSettled: number;
  // Refunds submitted to the provider and still in flight.
  refundedPending: number;
  // Credits that have settled.
  creditedSettled: number;
  // Credits issued and still in flight.
  creditedPending: number;
}

// The asymmetry below is deliberate and is the non-obvious part of this file.
// Money coming IN counts only once it has settled: a 'pending' charge is
// money we have not collected yet, so counting it would inflate the
// refundable balance and let us pay out against a charge that may still
// fail. Money going OUT counts as soon as it is submitted: a 'pending'
// refund or credit is already in flight at the provider and is expected to
// land, so it must be reserved the moment it exists. Without that reservation
// a customer asking about an in-flight refund could have a second one
// auto-approved on top of it (the idempotency key does not catch this: a
// different amount, or the same amount from a new thread, derives a
// different key). 'failed' rows are ignored on both sides: nothing was
// collected and nothing is on its way.
function orderMoney(db: Database.Database, orderId: string): OrderMoney {
  const sumOf = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE order_id = ? AND type = ? AND status = ?`,
  );
  const total = (type: PaymentType, status: Payment["status"]): number =>
    (sumOf.get(orderId, type, status) as { total: number }).total;
  return {
    charged: total("charge", "succeeded"),
    refundedSettled: total("refund", "succeeded"),
    refundedPending: total("refund", "pending"),
    creditedSettled: total("credit", "succeeded"),
    creditedPending: total("credit", "pending"),
  };
}

// What is still refundable on this order: settled charges minus every refund
// already settled or in flight.
function refundableBalance(money: OrderMoney): number {
  return money.charged - money.refundedSettled - money.refundedPending;
}

// What is still creditable on this order: settled charges minus every refund
// and credit already settled or in flight.
function creditableBalance(money: OrderMoney): number {
  return (
    money.charged - money.refundedSettled - money.refundedPending - money.creditedSettled - money.creditedPending
  );
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
// A credit tied to an order is additionally bounded by that order's
// creditable balance (settled charges minus refunds and credits already
// issued, in flight ones included), and a credit with no order at all always
// requires approval, since without an order there is nothing to bound it
// against.
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

    // Ownership check applies to any action type that carries an orderId,
    // credits included. The reason text deliberately mirrors order_not_found
    // ("No order found...") rather than confirming the order exists but
    // belongs to someone else; only the denyReason code stays distinct, for
    // the audit trail.
    if (order.customerId !== input.customerId) {
      return {
        verdict: "deny",
        denyReason: "order_not_owned_by_customer",
        reason: `No order found with id ${input.orderId} for this customer.`,
      };
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

      const money = orderMoney(db, input.orderId);
      // Clamped at zero for the same reason the credit bound below is: an
      // order refunded past what it was charged reads as "balance 0" to the
      // customer, not as a negative number. The comparison itself is
      // unaffected, since a requested amount is always positive.
      const available = Math.max(0, refundableBalance(money));
      if (input.amount > available) {
        // When part of what is missing is a refund we have already sent to
        // the provider, say so. Otherwise the customer is told a balance of 0
        // on an order they can see was never refunded. The agent relays this
        // text verbatim (hard rule 2 in agent/prompt.ts), so it stays short
        // and safe to read out loud.
        const inFlight =
          money.refundedPending > 0
            ? ` A refund of ${money.refundedPending} INR on this order is already in progress and is counted against that balance.`
            : "";
        return {
          verdict: "deny",
          denyReason: "exceeds_refundable_amount",
          reason: `Requested amount ${input.amount} exceeds the refundable balance of ${available} on this order.${inFlight}`,
        };
      }
    }

    if (input.actionType === "credit") {
      // Clamped at zero so an order already over-credited before this bound
      // existed reads as "balance 0", not a negative number, in the reason.
      const available = Math.max(0, creditableBalance(orderMoney(db, input.orderId)));
      if (input.amount > available) {
        return {
          verdict: "requires_approval",
          reason: `Requested credit ${input.amount} exceeds the creditable balance of ${available} on this order (charged minus refunds and credits already issued or in progress) and requires human approval.`,
        };
      }
    }
  }

  if (input.actionType === "credit" && !input.orderId) {
    return {
      verdict: "requires_approval",
      reason: "Credit is not tied to an order, so it cannot be checked against what that order was charged; it requires human approval.",
    };
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
