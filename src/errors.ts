export class LlmWikiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "LlmWikiError";
    this.code = code;
    this.details = details;
  }
}

export function asLlmWikiError(error: unknown): LlmWikiError {
  if (error instanceof LlmWikiError) {
    return error;
  }

  if (error instanceof Error) {
    return new LlmWikiError("INTERNAL_ERROR", error.message);
  }

  return new LlmWikiError("INTERNAL_ERROR", String(error));
}
