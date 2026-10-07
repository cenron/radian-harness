/** The single error type Radian throws. Command and tool handlers catch it at the boundary. */
export class RadianError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RadianError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
