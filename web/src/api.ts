import type {
  ApprovalRow,
  ChatResponse,
  FaultName,
  FaultsSnapshot,
  LedgerPage,
  LedgerStatus,
  PendingApprovalSummary,
  Persona,
  ThreadState,
  ThreadSummary,
} from "./types";

// Small typed wrapper around fetch for the REST endpoints in server/src/index.ts.
// Every response body arrives as `unknown` from `res.json()`; each function
// narrows it with a shape check before handing back a typed value, per the
// "any only at JSON boundaries, immediately narrowed" rule.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request to ${path} failed with status ${res.status}.`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export function getPersonas(): Promise<{ personas: Persona[] }> {
  return request("/api/personas");
}

export function getFaults(): Promise<{ faults: FaultsSnapshot }> {
  return request("/api/faults");
}

export function setFault(name: FaultName, enabled: boolean, uses?: number): Promise<{ faults: FaultsSnapshot }> {
  return request("/api/faults", { method: "POST", body: JSON.stringify({ name, enabled, uses }) });
}

export function clearFaults(): Promise<{ faults: FaultsSnapshot }> {
  return request("/api/faults/clear", { method: "POST" });
}

export function sendChatMessage(threadId: string, customerId: string, message: string): Promise<ChatResponse> {
  return request("/api/chat", { method: "POST", body: JSON.stringify({ threadId, customerId, message }) });
}

export function getThreadState(threadId: string): Promise<ThreadState> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/state`);
}

export function getThreads(): Promise<{ threads: ThreadSummary[] }> {
  return request("/api/threads");
}

export function getPendingApproval(threadId: string): Promise<{ approval: ApprovalRow | null }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/approvals/pending`);
}

// Cross-thread queue for the audit view, as opposed to the single-thread
// getPendingApproval above.
export function getPendingApprovals(): Promise<{ approvals: PendingApprovalSummary[] }> {
  return request("/api/approvals/pending");
}

export function getLedger(params: {
  status?: LedgerStatus;
  threadId?: string;
  limit?: number;
  offset?: number;
}): Promise<LedgerPage> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.threadId) query.set("threadId", params.threadId);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const suffix = query.toString();
  return request(suffix ? `/api/ledger?${suffix}` : "/api/ledger");
}

export function resolveApproval(
  threadId: string,
  approvalId: number,
  decision: "approve" | "reject",
  remark?: string,
): Promise<ChatResponse> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/approvals/${approvalId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision, remark }),
  });
}
