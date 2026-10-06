export type ServerError = Error & {
  code?: string;
  details?: Record<string, unknown>;
  status?: number;
};

export type HeaderValue = string | string[] | undefined;
export type Headers = Record<string, HeaderValue>;

export function errorProperties(error: unknown): ServerError {
  if (error instanceof Error) return error as ServerError;
  if (isRecord(error)) return error as unknown as ServerError;
  return new Error(String(error));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
