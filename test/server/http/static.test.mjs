import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProjectCatalog } from "../../../src/server/catalog/index.mjs";
import { createRemoteApiServer, PROTOCOL_VERSION } from "../../../src/server/http.mjs";
import { testAuthStore } from "./fixtures.mjs";

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "climier-server-static-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function requestRaw(baseUrl, requestPath) {
  const address = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: address.hostname, port: address.port, path: requestPath }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("HTTP server serves the SPA safely with static headers and fallback", async (t) => {
  const root = await makeRoot(t);
  const uiRoot = path.join(root, "ui", "dist");
  await fs.mkdir(path.join(uiRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(uiRoot, "index.html"), "<!doctype html><main>SPA</main>\n");
  await fs.writeFile(path.join(uiRoot, "assets", "app-123.js"), "console.log('app');\n");
  const outside = path.join(root, "outside.txt");
  await fs.writeFile(outside, "outside\n");
  const outsideDirectory = path.join(root, "outside-directory");
  await fs.mkdir(outsideDirectory);
  await fs.symlink(outside, path.join(uiRoot, "outside-link.txt"));
  await fs.symlink(outsideDirectory, path.join(uiRoot, "outside-directory"));

  const catalog = createProjectCatalog({ dataRoot: path.join(root, "catalog") });
  const server = createRemoteApiServer({ catalog, authStore: testAuthStore, uiRoot });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const html = await fetch(`${baseUrl}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.equal(await html.text(), "<!doctype html><main>SPA</main>\n");

  const asset = await fetch(`${baseUrl}/assets/app-123.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await asset.text(), "console.log('app');\n");

  const head = await fetch(`${baseUrl}/assets/app-123.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("console.log('app');\n")));
  assert.equal(await head.text(), "");

  const fallback = await fetch(`${baseUrl}/projects/123/board`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("cache-control"), "no-cache");
  assert.equal(await fallback.text(), "<!doctype html><main>SPA</main>\n");

  const traversal = await requestRaw(baseUrl, "/%2e%2e/outside.txt");
  assert.equal(traversal.status, 404);
  assert.notEqual(traversal.body.toString(), "outside\n");

  const symlink = await fetch(`${baseUrl}/outside-link.txt`);
  assert.equal(symlink.status, 404);
  assert.notEqual(await symlink.text(), "outside\n");

  const symlinkDirectory = await fetch(`${baseUrl}/outside-directory/missing.txt`);
  assert.equal(symlinkDirectory.status, 404);

  const apiUnknown = await fetch(`${baseUrl}/v1/not-a-route`, {
    headers: { "x-climier-protocol-version": PROTOCOL_VERSION },
  });
  assert.equal(apiUnknown.status, 404);
  assert.equal(apiUnknown.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await apiUnknown.json(), {
    ok: false,
    error: { code: "ROUTE_NOT_FOUND", message: "server http: route was not found" },
  });
});
