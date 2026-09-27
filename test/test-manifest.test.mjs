import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "./test-manifest-checker.mjs";
import { parseTapTestNames } from "./test-manifest-collector.mjs";

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

test("TAP collector builds full names from runtime nesting and indentation", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: describe runtime title",
    "    # Subtest: test with interpolated text captured",
    "    ok 1 - test with interpolated text captured",
    "      type: 'test'",
    "    # Subtest: subtest from t.test",
    "    ok 2 - subtest from t.test",
    "      type: 'test'",
    "    1..2",
    "ok 1 - describe runtime title",
    "  type: 'suite'",
  ].join("\n");
  assert.deepEqual(parseTapTestNames(tap, "test/runtime.test.mjs"), [
    { path: "test/runtime.test.mjs", name: "describe runtime title > test with interpolated text captured" },
    { path: "test/runtime.test.mjs", name: "describe runtime title > subtest from t.test" },
  ]);
});

const interpolatedTitle = `runtime interpolated title ${"captured"}`;
test(`collector sees ${interpolatedTitle}`, () => {});
