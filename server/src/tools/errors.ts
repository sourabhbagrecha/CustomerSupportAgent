export class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: "timeout" | "server_error" | "not_found",
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
