import assert from "node:assert/strict";
import test from "node:test";

import { createStaticHandler } from "../../../src/server/http/static.ts";

function responseRecorder() {
  let status: number | undefined;
  let headers: Record<string, string | number> = {};
  let body: Buffer = Buffer.alloc(0);
  return {
    response: {
      writeHead(code: number, value: Record<string, string | number> = {}) {
        status = code;
        headers = value;
      },
      end(value?: string | Buffer) {
        if (value === undefined) {
          body = Buffer.alloc(0);
        } else if (Buffer.isBuffer(value)) {
          body = value;
        } else {
          body = Buffer.from(value);
        }
      },
    },
    result() { return { status, headers, body }; },
  };
}

async function request(handler, pathname, method = "GET") {
  const recorder = responseRecorder();
  const handled = await handler({ method, url: pathname }, recorder.response);
  return { handled, ...recorder.result() };
}

test("memory static source serves the SPA and assets with the filesystem cache contract", async () => {
  const files = new Map<string, Uint8Array>([
    ["index.html", Buffer.from("<main>embedded</main>\n")],
    ["assets/app-abc.js", Buffer.from("console.log('embedded');\n")],
  ]);
  const handler = createStaticHandler({ source: files });

  const html = await request(handler, "/");
  assert.equal(html.handled, true);
  assert.equal(html.status, 200);
  assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(html.headers["cache-control"], "no-cache");
  assert.equal(html.body.toString(), "<main>embedded</main>\n");

  const asset = await request(handler, "/assets/app-abc.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(asset.body.toString(), "console.log('embedded');\n");

  const fallback = await request(handler, "/projects/123/board");
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.toString(), "<main>embedded</main>\n");

  assert.equal((await request(handler, "/v1/projects")).handled, false);
  assert.equal((await request(handler, "/v2/projects")).handled, false);
  assert.equal((await request(handler, "/%2e%2e/outside.txt")).status, 404);
  assert.equal((await request(handler, "/assets/missing.js")).status, 404);
});

test("memory static source reports a missing index as unavailable", async () => {
  const handler = createStaticHandler({ source: new Map() });
  const missing = await request(handler, "/");
  assert.equal(missing.status, 503);
  assert.equal(missing.headers["content-type"], "text/plain; charset=utf-8");
});
