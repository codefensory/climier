export const PROTOCOL_VERSION = "1";
export const PROTOCOL_HEADER = "X-Climier-Protocol-Version";
export const AUTH_STORAGE_KEY = "climier.auth.token";

export type ApiErrorBody = {
  error?: string | { code?: string; message?: string; details?: unknown };
};

export type ProjectSummary = {
  project_id: string;
  name: string | null;
  revision: number;
  node_count: number;
  updated_at: string | null;
};

export type SnapshotResponse<T> = {
  status: 200 | 304;
  snapshot: T | null;
  etag: string | null;
};
