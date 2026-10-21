import { test } from "node:test";
import assert from "node:assert/strict";

import { createHttpCodec } from "../../../src/server/http/codec.ts";
import { createHttpReads } from "../../../src/server/http/reads.ts";
import { PROTOCOL_VERSION } from "../../../src/server/http.ts";
import * as readModel from "../../../src/read-model/index.ts";

// Every read route, including the ones that carry a node id in the path.
const READ_ROUTES = [
  "read/status",
  "read/context/T-1",
  "read/show/T-1",
  "read/history/T-1",
  "read/search",
  "read/initiatives",
  "read/log",
  "read/changes",
  "read/state",
  "read/nodes/T-1",
];

function createReads() {
  const codec = createHttpCodec({ protocolVersion: PROTOCOL_VERSION });
  return {
    codec,
    reads: createHttpReads({
      httpError: codec.httpError,
      routing: { decodeURIComponent },
      query: { searchParams: (url) => url.searchParams },
      deps: readModel as unknown as Record<string, (args?: unknown) => unknown>,
      clock: Date.now,
    }),
  };
}

test("server read routes: the codec and the read handler agree on kind, id and allowed query parameters", () => {
  const { codec, reads } = createReads();
  for (const route of READ_ROUTES) {
    assert.deepEqual(reads.matchReadRoute(route), codec.readRoute(route), `route ${route}`);
  }
});

test("server changes read requires one non-negative safe integer revision", () => {
  const { reads } = createReads();
  const matched = reads.matchReadRoute("read/changes");
  assert.deepEqual(reads.parseReadQuery(new URL("http://localhost/read/changes?since=42"), matched), { since: 42 });
  for (const query of ["", "?since=", "?since=1.5", "?since=1&since=2"]) {
    assert.throws(() => reads.parseReadQuery(new URL(`http://localhost/read/changes${query}`), matched), { code: "INVALID_QUERY" });
  }
});

test("server read log accepts the canonical node parameter and rejects the pre-canonical task parameter", () => {
  const { reads } = createReads();
  const matched = reads.matchReadRoute("read/log");
  assert.deepEqual(
    reads.parseReadQuery(new URL("http://localhost/read/log?node=T-1&limit=2"), matched),
    { node: "T-1", limit: 2 },
  );
  assert.throws(
    () => reads.parseReadQuery(new URL("http://localhost/read/log?task=T-1"), matched),
    { code: "INVALID_QUERY" },
  );
});
