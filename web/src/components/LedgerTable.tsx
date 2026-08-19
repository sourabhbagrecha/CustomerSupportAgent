import { Fragment } from "react";
import { formatAmount, formatTime } from "../format";
import type { LedgerRow } from "../types";

interface LedgerTableProps {
  rows: LedgerRow[];
  total: number;
}

function statusLabel(status: LedgerRow["status"]): string {
  return status.replace(/_/g, " ");
}

export function LedgerTable({ rows, total }: LedgerTableProps) {
  return (
    <div className="ledger-table-wrap">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>Created</th>
            <th>Customer</th>
            <th>Action</th>
            <th>Order</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Reason</th>
            <th>Resolved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              <tr>
                <td className="ledger-nowrap">{formatTime(row.createdAt)}</td>
                <td className="ledger-nowrap">{row.customerId}</td>
                <td>{row.actionType}</td>
                <td className="ledger-nowrap">{row.orderId ?? "N/A"}</td>
                <td className="ledger-nowrap">{formatAmount(row.amount, row.currency)}</td>
                <td>
                  <span className={`ledger-status ledger-status-${row.status}`}>{statusLabel(row.status)}</span>
                </td>
                <td>
                  <span className="ledger-reason">{row.reason}</span>
                </td>
                <td className="ledger-nowrap">{row.resolvedAt ? formatTime(row.resolvedAt) : "not resolved"}</td>
              </tr>
              {/* The idempotency key is 64 hex characters and the raw response is
                  a JSON blob; both belong behind a disclosure rather than in a
                  column, the same way the trace panel handles full payloads. */}
              <tr className="ledger-detail-row">
                <td colSpan={8}>
                  <details>
                    <summary>Thread {row.threadId}</summary>
                    <pre className="trace-raw ledger-key">
                      {JSON.stringify(
                        { idempotencyKey: row.idempotencyKey, threadId: row.threadId, rawResponse: row.rawResponse },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      {total > rows.length && (
        <p className="audit-note">
          Showing {rows.length} of {total} rows.
        </p>
      )}
    </div>
  );
}
