// Thrown when both PRIMARY_MODEL and FALLBACK_MODEL have exhausted retries.
// The caller (graph runner) must catch this and return the deterministic,
// LLM-free degraded reply (CLAUDE.md invariant 6): this error type, and only
// this error type, is the signal for that path.
export class ModelsUnavailable extends Error {
  constructor(
    message: string,
    public readonly primaryError: unknown,
    public readonly fallbackError: unknown,
  ) {
    super(message);
    this.name = "ModelsUnavailable";
  }
}
