import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { initState } from "../../../src/kernel/state-operations.ts";
import { createProjectCatalog } from "../../../src/server/catalog/index.ts";
import { createRemoteApiServer } from "../../../src/server/http.ts";

export const testAuthStore = Object.freeze({
  async login(password) {
    if (password !== "password") {
      const error = new Error("invalid password");
      error.code = "AUTH_INVALID_PASSWORD";
      throw error;
    }
    return "test-token";
  },
  async verifyBearer(token) {
    return token === "test-token";
  },
});

export async function withApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const projectIds = ["project-a", "project-b"];
  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog") });
  const projectDirs = await Promise.all(projectIds.map((id) => catalog.provisionProject(id)));
  for (const projectDir of projectDirs) {
    await initState({ projectDir });
  }
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    authStore: testAuthStore,
    async openProject(storagePath: string, metadata?: { projectId?: unknown }) {
      openCount += 1;
      assert.equal(typeof metadata?.projectId, "string");
      return { projectDir: storagePath };
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  try {
    await run({ baseUrl, openCount: () => openCount, projectDirs });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = previousHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function withInitApi(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-init-http-"));
  const previousHome = process.env.CLIMIER_HOME;
  process.env.CLIMIER_HOME = path.join(root, "home");
  const dataRoot = path.join(root, "catalog");
  const catalog = createProjectCatalog({ dataRoot });
  let openCount = 0;
  const server = createRemoteApiServer({
    catalog,
    authStore: testAuthStore,
    async openProject(projectDir: string) {
      openCount += 1;
      return { projectDir };
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  try {
    await run({ baseUrl, dataRoot, openCount: () => openCount });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousHome === undefined) {
      delete process.env.CLIMIER_HOME;
    } else {
      process.env.CLIMIER_HOME = previousHome;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

type HttpJson = {
  [key: string]: unknown;
  ok: boolean;
  result: HttpJson;
  error: { code: string };
  name: string;
  results: unknown[];
  revision_before: number;
  revision_after: number;
};
type JsonResponse = Omit<Response, "json"> & { json(): Promise<HttpJson> };

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    "x-climier-protocol-version": "1",
    ...extra,
  };
}

export async function operation(
  baseUrl: string,
  projectId: string,
  operationId: string,
  input: unknown,
): Promise<JsonResponse> {
  const actor = "alice";
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/operations`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ operation: operationId, input, actor }),
  });
  return response as JsonResponse;
}
