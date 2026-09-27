import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "./test-manifest-checker.mjs";

test("test manifest checker rejects a runtime case with no row", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
  ] };
  const runtime = [
    { path: "test/example.test.mjs", name: "present" },
    { path: "test/example.test.mjs", name: "missing" },
  ];

  assert.throws(() => validateManifest(manifest, runtime), /unlisted runtime case.*missing/);
});

test("test manifest checker rejects an unlisted runtime case", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
  ] };
  const runtime = [
    { path: "test/example.test.mjs", name: "present" },
    { path: "test/example.test.mjs", name: "extra" },
  ];

  assert.throws(() => validateManifest(manifest, runtime), /unlisted runtime case.*extra/);
});

test("test manifest checker rejects stale manifest rows", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
    { path: "test/example.test.mjs", name: "removed", ordinal: 1, disposition: "keep" },
  ] };

  assert.throws(
    () => validateManifest(manifest, [{ path: "test/example.test.mjs", name: "present" }]),
    /stale manifest row.*removed/,
  );
});

const interpolatedTitle = `runtime interpolated title ${"captured"}`;
test(`collector sees ${interpolatedTitle}`, async (t) => {
  await t.test("nested t.test row", () => {});
});
