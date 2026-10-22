export type CoordinationErrorCode =
  | "CONFLICT"
  | "LEASE_HELD"
  | "LEASE_NOT_HELD"
  | "NOT_CLAIMANT"
  | "TASK_ALREADY_CLAIMED"
  | "TASK_NOT_CLAIMABLE"
  | "TASK_NOT_FOUND"
  | "AGENT_NOT_REGISTERED"
  | "AGENT_ALREADY_REGISTERED"
  | "AGENT_CAPABILITY_MISSING"
  | "KEY_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "VALIDATION";

/** Usage errors that reflect a bad invocation rather than a coordination race. */
const USAGE_CODES = new Set<CoordinationErrorCode>(["VALIDATION"]);

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly retriable: boolean;

  constructor(code: CoordinationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CoordinationError";
    this.code = code;
    this.retriable = !USAGE_CODES.has(code);
  }
}

export function isCoordinationError(error: unknown): error is CoordinationError {
  return error instanceof CoordinationError;
}

export function describeError(error: unknown): string {
  if (error instanceof CoordinationError) {
    return `${error.code}: ${error.message.replace(`[${error.code}] `, "")}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Exit codes: 0 success, 1 coordination failure, 2 usage error. */
export function errorExitCode(code: CoordinationErrorCode): 0 | 1 | 2 {
  return USAGE_CODES.has(code) ? 2 : 1;
}