import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteReadMethods } from "../src/application/backend-remote-reads.ts";
import type { RemoteRequest } from "../src/application/types.ts";

function captureRoutes() {
  const routes: string[] = [];
  const request: RemoteRequest = ({ route }) => {
    routes.push(route);
    return Promise.resolve(null);
  };
  return { request, routes };
}

test("backend-remote-reads: readLog sends the node option as the wire node parameter", async () => {
  const { request, routes } = captureRoutes();
  await createRemoteReadMethods(request).readLog({ node: "T-1" });
  assert.deepEqual(routes, ["read/log?node=T-1"]);
});

test("backend-remote-reads: readLog accepts options present with undefined values and sends no query", async () => {
  const { request, routes } = captureRoutes();
  await createRemoteReadMethods(request).readLog({ limit: undefined, action: undefined, agent: undefined, node: undefined });
  assert.deepEqual(routes, ["read/log"]);
});

test("backend-remote-reads: readLog builds the full query from limit, action, agent and node", async () => {
  const { request, routes } = captureRoutes();
  await createRemoteReadMethods(request).readLog({ limit: 2, action: "take", agent: "alice", node: "T-1" });
  assert.deepEqual(routes, ["read/log?limit=2&action=take&agent=alice&node=T-1"]);
});

test("backend-remote-reads: readLog rejects an option outside the accepted set", async () => {
  const { request } = captureRoutes();
  await assert.rejects(
    async () => { await createRemoteReadMethods(request).readLog({ limite: 1 }); },
    (error: unknown) => {
      const coded = error as { code?: string; details?: { field?: string } };
      assert.equal(coded.code, "INVALID_REQUEST");
      assert.equal(coded.details?.field, "limite");
      return true;
    },
  );
});

test("backend-remote-reads: readLog rejects the pre-canonical task option the server does not accept", async () => {
  const { request } = captureRoutes();
  await assert.rejects(
    async () => { await createRemoteReadMethods(request).readLog({ task: "T-1" }); },
    (error: unknown) => {
      const coded = error as { code?: string; details?: { field?: string } };
      assert.equal(coded.code, "INVALID_REQUEST");
      assert.equal(coded.details?.field, "task");
      return true;
    },
  );
});
