import type { ZodError } from "zod";

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "server_error" | "not_found" | "validation",
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(message = "The call timed out before a response was received.") {
    super(message, "timeout");
    this.name = "ToolTimeoutError";
  }
}

export class ToolServerError extends ToolError {
  constructor(message = "The service returned an internal error.") {
    super(message, "server_error");
    this.name = "ToolServerError";
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(message: string) {
    super(message, "not_found");
    this.name = "ToolNotFoundError";
  }
}

// Thrown when a tool's own return value (or the mock provider's raw
// response) fails validation against its Zod output schema, i.e. the code
// producing the result has a bug, not the model's arguments. The message is
// written for the model: it explains what happened and what to do next
// (retry once, then escalate), since ToolNode turns this into an error
// ToolMessage that feeds straight back into the conversation, the same
// repair path the malformed_tool_args fault already exercises.
export class ToolOutputValidationError extends ToolError {
  constructor(message: string) {
    super(message, "validation");
    this.name = "ToolOutputValidationError";
  }
}

export interface CompactZodIssue {
  path: string;
  message: string;
}

// Shared by agentTools.ts's tool-output validation and pipeline.ts's raw
// provider-response validation, so both `error` event payloads carry the
// same compact shape instead of the full ZodError object tree.
export function compactZodIssues(error: ZodError): CompactZodIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}
