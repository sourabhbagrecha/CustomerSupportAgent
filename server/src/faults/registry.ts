import { FAULT_NAMES, type FaultName, type FaultRegistrySnapshot } from "./types.js";

// In-memory only, per PLAN Section 5 / CLAUDE.md invariant 3 (zero infra).
// Faults are process-local: restarting the server clears them. Set via the
// REST endpoint (UI toggles) or directly by the eval harness importing this
// module in-process.
const state = new Map<FaultName, { enabled: boolean; remaining?: number }>();

export function setFault(name: FaultName, enabled: boolean, uses?: number): void {
  if (!enabled) {
    state.delete(name);
    return;
  }
  state.set(name, { enabled: true, remaining: uses });
}

export function clearAllFaults(): void {
  state.clear();
}

// Returns true if the fault is active, and consumes one use if the fault is
// counted (`remaining` set). A counted fault that reaches 0 uses is removed.
export function consumeFault(name: FaultName): boolean {
  const entry = state.get(name);
  if (!entry) return false;
  if (entry.remaining === undefined) return true;
  if (entry.remaining <= 0) {
    state.delete(name);
    return false;
  }
  entry.remaining -= 1;
  if (entry.remaining <= 0) state.delete(name);
  return true;
}

// Non-consuming check, for faults that should stay active across an entire
// pipeline step (e.g. checking refund_timeout_after_success after the DB
// write already happened but before deciding what to throw).
export function isFaultActive(name: FaultName): boolean {
  return state.has(name);
}

export function getSnapshot(): FaultRegistrySnapshot {
  const snapshot: Partial<FaultRegistrySnapshot> = {};
  for (const name of FAULT_NAMES) {
    const entry = state.get(name);
    if (entry) snapshot[name] = { enabled: true, remaining: entry.remaining };
  }
  return snapshot as FaultRegistrySnapshot;
}
