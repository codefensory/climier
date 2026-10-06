import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "./test-manifest-checker.mjs";
import { collectTestNames, parseJunitTestNames, parseTapTestNames } from "./test-manifest-collector.mjs";
import { findRawWriterFiles } from "./test-manifest-lanes.mjs";
import { buildManifestRows } from "./test-manifest-rows.mjs";

const SHA = "a".repeat(40);

function rawDeclaration() {
  return { category: "lane-legacy", motive: "seeds a pre-cut state", replacement: "writeCanonicalState" };
}

const RAW_FILE = "test/raw.test.mjs";
const MOVE_SOURCE = "test/old.test.mjs";
const MOVE_DESTINATION = "test/new.test.mjs";
const TS_MOVE_SOURCE = "test/renamed-suite.test.mjs";
const TS_MOVE_DESTINATION = "test/renamed-suite.test.ts";

function moveManifest(destinationNames = ["first", "second"], sourceNames = ["first", "second"]) {
  return {
    version: 1,
    base_sha: SHA,
    tests: [
      ...sourceNames.map((name) => ({ path: MOVE_SOURCE, name, ordinal: 1, disposition: "move", move_from: MOVE_SOURCE })),
      ...destinationNames.map((name) => ({ path: MOVE_DESTINATION, name, ordinal: 1, disposition: "move", move_from: MOVE_SOURCE })),
    ],
  };
}

const movedRuntime = [
  { path: MOVE_DESTINATION, name: "first" },
  { path: MOVE_DESTINATION, name: "second" },
];

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
    await writeFile(path.join(dir, "typescript-mutator.test.ts"), "await updateState(dir, (state) => state);\n");
    await writeFile(path.join(dir, "canonical.test.mjs"), "await writeCanonicalState(dir, state);\n");
    await writeFile(path.join(dir, "notes.md"), "writeState(dir, state)\n");

    assert.deepEqual(await findRawWriterFiles(dir), [
      "legacy-mutator.test.mjs",
      "raw-writer.test.mjs",
      "typescript-mutator.test.ts",
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

test("test manifest checker accepts a moved file when source and destination names match", () => {
  assert.equal(validateManifest(moveManifest(), movedRuntime), true);
});

test("test manifest checker rejects a move with a different name multiset", () => {
  assert.throws(
    () => validateManifest(moveManifest(["first", "third"]), [
      { path: MOVE_DESTINATION, name: "first" },
      { path: MOVE_DESTINATION, name: "third" },
    ]),
    /move from test\/old\.test\.mjs must preserve the runtime name multiset/,
  );
});

test("test manifest checker rejects a move whose ordinals differ", () => {
  const manifest = moveManifest();
  manifest.tests[0].ordinal = 2;

  assert.throws(
    () => validateManifest(manifest, movedRuntime),
    /move from test\/old\.test\.mjs must preserve the runtime name multiset/,
  );
});

test("test manifest checker rejects a move source with no rows", () => {
  const manifest = moveManifest();
  manifest.tests = manifest.tests.filter((row) => row.path !== MOVE_SOURCE);

  assert.throws(
    () => validateManifest(manifest, movedRuntime),
    /move source test\/old\.test\.mjs has no manifest rows/,
  );
});

test("test manifest checker accepts a delete row listed by the caller's allowlist", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
    {
      path: "test/example.test.mjs",
      name: "removed",
      ordinal: 1,
      disposition: "delete",
      category: "raw-lane",
      reason: "the behavior this case pinned no longer exists",
      replacement: "covered by the canonical suite",
    },
  ] };
  const allowlist = manifest.tests
    .filter((row) => row.disposition === "delete")
    .map(({ path: filePath, name, ordinal }) => ({ path: filePath, name, ordinal }));

  assert.equal(
    validateManifest(manifest, [{ path: "test/example.test.mjs", name: "present" }], { deleteAllowlist: allowlist }),
    true,
  );
});

test("test manifest checker rejects a delete row the allowlist does not list", () => {
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: [
    { path: "test/example.test.mjs", name: "present", ordinal: 1, disposition: "keep" },
    {
      path: "test/example.test.mjs",
      name: "removed",
      ordinal: 1,
      disposition: "delete",
      category: "raw-lane",
      reason: "the behavior this case pinned no longer exists",
      replacement: "covered by the canonical suite",
    },
  ] };

  assert.throws(
    () => validateManifest(manifest, [{ path: "test/example.test.mjs", name: "present" }], { deleteAllowlist: [] }),
    /manifest deletes must match the deletion allowlist/,
  );
});

test("test manifest checker skips the raw lane annotation for a delete row of a declared file", () => {
  const rows = [
    { path: RAW_FILE, name: "kept raw case", ordinal: 1, disposition: "keep", lane: "raw", ...rawDeclaration() },
    {
      path: RAW_FILE,
      name: "retired raw case",
      ordinal: 1,
      disposition: "delete",
      category: "raw-lane",
      reason: "the raw writer refuses the state this case planted",
      replacement: "covered by the canonical suite",
    },
  ];
  const manifest = { version: 1, base_sha: "a".repeat(40), tests: rows };
  const runtime = [{ path: RAW_FILE, name: "kept raw case" }];

  assert.equal(
    validateManifest(manifest, runtime, { rawWriterFiles: [RAW_FILE], rawLaneDeclarations: { [RAW_FILE]: rawDeclaration() } }),
    true,
  );
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

test("manifest collector discovers TypeScript test suites", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "climier-manifest-ts-"));
  try {
    await writeFile(path.join(dir, "renamed.test.ts"), [
      'import { test } from "node:test";',
      'test("TypeScript suite case", () => {});',
    ].join("\n"));

    assert.deepEqual(await collectTestNames({ rootDir: dir, testDir: dir }), [
      { path: "renamed.test.ts", name: "TypeScript suite case" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("JUnit collector reads Bun test names and decodes XML entities", () => {
  const junit = [
    '<testsuite file="test/runtime.test.mjs">',
    '  <testcase name="runtime &amp; captured" file="test/runtime.test.mjs" />',
    '</testsuite>',
  ].join("\n");
  assert.deepEqual(parseJunitTestNames(junit, "test/runtime.test.mjs"), [
    { path: "test/runtime.test.mjs", name: "runtime & captured" },
  ]);
});

const interpolatedTitle = `runtime interpolated title ${"captured"}`;
test(`collector sees ${interpolatedTitle}`, () => {});

test("manifest rows: a .test.mjs to .test.ts move preserves ordinals, lanes and deletes", () => {
  const names = ["duplicate", "duplicate", "second"];
  const sourceRows = names.map((name, index) => ({
    path: TS_MOVE_SOURCE,
    name,
    ordinal: names.slice(0, index + 1).filter((item) => item === name).length,
    disposition: "move",
    move_from: TS_MOVE_SOURCE,
    lane: "raw",
    category: "lane-legacy",
    motive: "preserve the migration inventory",
    replacement: "writeCanonicalState",
  }));
  const destinationRows = sourceRows.map((row) => ({ ...row, path: TS_MOVE_DESTINATION }));
  const retired = {
    path: "test/retired.test.mjs",
    name: "retired case",
    ordinal: 1,
    disposition: "delete",
    category: "raw-lane",
    reason: "the behavior was removed",
    coverage_removed: true,
  };
  const rawLaneDeclarations = {
    [TS_MOVE_SOURCE]: { category: "lane-legacy", motive: "preserve the migration inventory", replacement: "writeCanonicalState" },
    [TS_MOVE_DESTINATION]: { category: "lane-legacy", motive: "preserve the migration inventory", replacement: "writeCanonicalState" },
  };
  const tests = buildManifestRows({
    rows: names.map((name) => ({ path: TS_MOVE_DESTINATION, name })),
    previous: [...sourceRows, ...destinationRows, retired],
    declarations: {},
  });

  assert.equal(validateManifest({ version: 1, base_sha: SHA, tests }, names.map((name) => ({
    path: TS_MOVE_DESTINATION,
    name,
  })), {
    rawWriterFiles: Object.keys(rawLaneDeclarations),
    rawLaneDeclarations,
  }), true);
  assert.deepEqual(
    tests.filter((row) => row.path === TS_MOVE_DESTINATION).map(({ name, ordinal, disposition, lane, category }) => ({ name, ordinal, disposition, lane, category })),
    sourceRows.map(({ name, ordinal, disposition, lane, category }) => ({ name, ordinal, disposition, lane, category })),
  );
  assert.equal(tests.filter((row) => row.path === TS_MOVE_SOURCE && row.disposition === "move").length, names.length);
  assert.deepEqual(tests.find((row) => row.path === retired.path), retired);
});

test("manifest rows: a move keeps the source rows when the file is gone", () => {
  const previous = {
    tests: [
      { path: MOVE_SOURCE, name: "first", ordinal: 1, disposition: "move", move_from: MOVE_SOURCE },
      { path: MOVE_SOURCE, name: "second", ordinal: 1, disposition: "move", move_from: MOVE_SOURCE },
      { path: MOVE_DESTINATION, name: "first", ordinal: 1, disposition: "move", move_from: MOVE_SOURCE },
      { path: MOVE_DESTINATION, name: "second", ordinal: 1, disposition: "move", move_from: MOVE_SOURCE },
    ],
  };

  const tests = buildManifestRows({ rows: movedRuntime, previous: previous.tests, declarations: {} });
  const manifest = { version: 1, base_sha: SHA, tests };

  assert.equal(validateManifest(manifest, movedRuntime), true);
  assert.equal(tests.filter((row) => row.path === MOVE_SOURCE).length, 2, "the source rows must survive the regeneration");
});

test("manifest rows: regenerating without a previous manifest keeps every runtime row", () => {
  const tests = buildManifestRows({ rows: movedRuntime, previous: [], declarations: {} });

  assert.deepEqual(tests.map((row) => [row.path, row.name, row.disposition]), [
    [MOVE_DESTINATION, "first", "keep"],
    [MOVE_DESTINATION, "second", "keep"],
  ]);
});

test("manifest rows: a stale keep row is dropped while delete and move rows are carried", () => {
  const previous = [
    { path: "test/gone.test.mjs", name: "stale keep", ordinal: 1, disposition: "keep" },
    { path: "test/gone.test.mjs", name: "retired", ordinal: 1, disposition: "delete", category: "raw-lane", reason: "behavior removed", coverage_removed: true },
    { path: MOVE_SOURCE, name: "first", ordinal: 1, disposition: "move", move_from: MOVE_SOURCE },
  ];

  const tests = buildManifestRows({ rows: [{ path: MOVE_DESTINATION, name: "first" }], previous, declarations: {} });

  assert.deepEqual(tests.map((row) => [row.path, row.name, row.disposition]), [
    ["test/gone.test.mjs", "retired", "delete"],
    [MOVE_DESTINATION, "first", "keep"],
    [MOVE_SOURCE, "first", "move"],
  ]);
});
