import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  checkForUpdate,
  createManifestClient,
  selectStableVersion,
} from "../src/upgrade/manifest-client.ts";

type TestServer = { origin: string; close: () => Promise<void> };

async function withManifestServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function manifest(version: string) {
  return {
    manifest_version: 1,
    version,
    release_channel: "stable",
    state_schema: 1,
    min_bun: ">=1.4",
    notes_url: "http://example.test/releases",
    artifacts: {},
  };
}

test("manifest client selects the highest stable version and excludes prereleases", () => {
  assert.equal(selectStableVersion(["1.2.0", "2.0.0-next.1", "1.10.0", "2.0.0"]), "2.0.0");
  assert.equal(selectStableVersion(["2.0.0-next.1", "1.0.0-alpha"]), null);
});

test("manifest client reads the stable manifest from the latest download endpoint", async (t) => {
  const server = await withManifestServer((request, response) => {
    assert.equal(request.url, "/releases/latest/download/manifest.json");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(manifest("2.1.0")));
  });
  t.after(server.close);

  const client = createManifestClient({ repository: server.origin });
  const result = await client.fetchManifest();
  assert.equal(result.version, "2.1.0");
  assert.equal(result.release_channel, "stable");
});

test("manifest client reports an available stable update", async (t) => {
  const server = await withManifestServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(manifest("2.0.0")));
  });
  t.after(server.close);

  assert.deepEqual(await checkForUpdate({ currentVersion: "1.9.0", repository: server.origin }), {
    currentVersion: "1.9.0",
    latestVersion: "2.0.0",
    updateAvailable: true,
    manifest: manifest("2.0.0"),
  });
});

test("manifest client fails closed when the network is unavailable", async () => {
  await assert.rejects(
    createManifestClient({ repository: "http://127.0.0.1:1", timeoutMs: 100 }).fetchManifest(),
    (error: unknown) => (error as { code?: string }).code === "UPDATE_CHECK_UNREACHABLE",
  );
});

test("manifest client turns a request timeout into UPDATE_CHECK_UNREACHABLE", async (t) => {
  const server = await withManifestServer((_request, _response) => {
    // Keep the response open until the client's abort signal fires.
  });
  t.after(server.close);

  await assert.rejects(
    createManifestClient({ repository: server.origin, timeoutMs: 20 }).fetchManifest(),
    (error: unknown) => {
      const caught = error as { code?: string; details?: { timeout_ms?: number } };
      return caught.code === "UPDATE_CHECK_UNREACHABLE" && caught.details?.timeout_ms === 20;
    },
  );
});
