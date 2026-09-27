import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "./test-manifest-checker.mjs";
import { parseTapTestNames } from "./test-manifest-collector.mjs";
import { findRawWriterFiles } from "./test-manifest-lanes.mjs";

const SHA = "a".repeat(40);

function rawDeclaration() {
  return { category: "lane-legacy", motive: "seeds a pre-cut state", replacement: "writeCanonicalState" };
}

const RAW_FILE = "test/raw.test.mjs";

test("test manifest checker rejects a raw writer file with no declaration", () => {
  const manifest = { version: 1, base_sha: SHA, tests: [
    { path: RAW_FILE, name: "seeds a raw state", ordinal: 1, disposition: "keep" },
  ] };

  assert.throws(
    () => validateManifest(manifest, [{ path: RAW_FILE, name: "seeds a raw state" }], {
      rawWriterFiles: [RAW_FILE],
      rawLaneDeclarations: {},
    }),
    /raw-lane declaration.*test\/raw\.test\.mjs/,
  );
});

test("test manifest checker rejects a declaration whose file no longer writes raw", () => {
  const manifest = { version: 1, base_sha: SHA, tests: [
    { path: "test/clean.test.mjs", name: "uses the canonical helper", ordinal: 1, disposition: "keep" },
  ] };

  assert.throws(
    () => validateManifest(manifest, [{ path: "test/clean.test.mjs", name: "uses the canonical helper" }], {
      rawWriterFiles: [],
      rawLaneDeclarations: { "test/clean.test.mjs": rawDeclaration() },
    }),
    /stale raw-lane declaration.*test\/clean\.test\.mjs/,
  );
});

test("test manifest checker requires the raw lane annotation on every declared row", () => {
  const runtime = [{ path: RAW_FILE, name: "seeds a raw state" }];
  const bare = { version: 1, base_sha: SHA, tests: [
    { path: RAW_FILE, name: "seeds a raw state", ordinal: 1, disposition: "keep" },
  ] };
  const annotated = { version: 1, base_sha: SHA, tests: [
    {
      path: RAW_FILE,
      name: "seeds a raw state",
      ordinal: 1,
      disposition: "keep",
      lane: "raw",
      category: "lane-legacy",
      motive: "seeds a pre-cut state",
      replacement: "writeCanonicalState",
    },
  ] };

  assert.throws(
    () => validateManifest(bare, runtime, { rawWriterFiles: [RAW_FILE], rawLaneDeclarations: { [RAW_FILE]: rawDeclaration() } }),
    /raw lane row.*needs lane, category, motive and replacement/,
  );
  assert.equal(
    validateManifest(annotated, runtime, { rawWriterFiles: [RAW_FILE], rawLaneDeclarations: { [RAW_FILE]: rawDeclaration() } }),
    true,
  );
});

test("test manifest lane scan finds the files that write state outside the canonical helper", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "climier-manifest-lanes-"));
  try {
    await writeFile(path.join(dir, "raw-writer.test.mjs"), "await writeState(dir, state);\n");
    await writeFile(path.join(dir, "legacy-mutator.test.mjs"), "await updateState(dir, (state) => state);\n");
    await writeFile(path.join(dir, "canonical.test.mjs"), "await writeCanonicalState(dir, state);\n");
    await writeFile(path.join(dir, "notes.md"), "writeState(dir, state)\n");

    assert.deepEqual(await findRawWriterFiles(dir), [
      "legacy-mutator.test.mjs",
      "raw-writer.test.mjs",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test manifest checker rejects a runtime case with no row", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
  ] };
  const runtime = [
    { path: "test/example.test.mjs", name: "present" },
    { path: "test/example.test.mjs", name: "missing" },
  ];

  assert.throws(() => validateManifest(manifest, runtime), /missing manifest row.*missing/);
});

test("test manifest checker rejects an unlisted runtime case", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
  ] };
  const runtime = [
    { path: "test/example.test.mjs", name: "present" },
    { path: "test/example.test.mjs", name: "extra" },
  ];

  assert.throws(() => validateManifest(manifest, runtime), /missing manifest row.*extra/);
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
