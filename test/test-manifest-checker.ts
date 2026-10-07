import assert from "node:assert/strict";

type ManifestRow = {
  path: string;
  name: string;
  ordinal: number;
  disposition: string;
  move_from?: string;
  category?: string;
  reason?: string;
  replacement?: string;
  coverage_removed?: boolean;
  lane?: string;
  motive?: string;
  [key: string]: unknown;
};
type RuntimeCase = { path: string; name: string };
type Manifest = { version: number; base_sha: string; tests: ManifestRow[] };
type RawLaneDeclaration = { category: string; motive: string; replacement?: string };
type ValidationOptions = {
  deleteAllowlist?: Array<Pick<ManifestRow, "path" | "name" | "ordinal"> | ManifestRow | string>;
  rawWriterFiles?: string[];
  rawLaneDeclarations?: Record<string, RawLaneDeclaration>;
};

function key({ path, name, ordinal }: Pick<ManifestRow, "path" | "name" | "ordinal">): string {
  return JSON.stringify([path, name, ordinal]);
}

function countByFileAndName(rows: ManifestRow[]): Map<string, number> {
  const counts = new Map();
  for (const row of rows) {
    const item = JSON.stringify([row.path, row.name]);
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function countByName(rows: ManifestRow[]): Map<string, number> {
  const counts = new Map();
  for (const row of rows) {
    const identity = JSON.stringify([row.name, row.ordinal]);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

function assertMoveNameMultisets(manifest: Manifest): void {
  const moves = new Map();
  for (const row of manifest.tests) {
    if (row.disposition !== "move") continue;
    assert.equal(typeof row.move_from, "string", `move row ${row.path}:${row.name} needs move_from`);
    const source = moves.get(row.move_from) ?? [];
    source.push(row);
    moves.set(row.move_from, source);
  }

  for (const [sourcePath, rows] of moves) {
    const sourceRows = manifest.tests.filter((row) => row.path === sourcePath && row.disposition === "move");
    const destinationRows = rows.filter((row) => row.path !== sourcePath);
    assert.ok(sourceRows.length > 0, `move source ${sourcePath} has no manifest rows`);
    assert.deepEqual(
      countByName(sourceRows),
      countByName(destinationRows),
      `move from ${sourcePath} must preserve the runtime name multiset and ordinals`,
    );
  }
}

export function validateManifest(
  manifest: Manifest,
  runtimeCases: RuntimeCase[],
  { deleteAllowlist, rawWriterFiles, rawLaneDeclarations }: ValidationOptions = {},
): true {
  assert.equal(manifest?.version, 1, "manifest version must be 1");
  assert.match(manifest?.base_sha ?? "", /^[0-9a-f]{40}$/, "manifest base_sha must be a full commit SHA");
  assert.ok(Array.isArray(manifest.tests), "manifest tests must be an array");
  assert.ok(Array.isArray(runtimeCases), "runtime cases must be an array");

  const declared = new Map();
  for (const row of manifest.tests) {
    assert.equal(typeof row.path, "string", "manifest row path must be a string");
    assert.equal(typeof row.name, "string", "manifest row name must be a string");
    assert.ok(Number.isInteger(row.ordinal) && row.ordinal > 0, `invalid ordinal for ${row.path}:${row.name}`);
    assert.ok(["keep", "move", "delete"].includes(row.disposition), `invalid disposition for ${row.path}:${row.name}`);
    const identity = key(row);
    assert.ok(!declared.has(identity), `duplicate manifest row ${row.path}:${row.name}#${row.ordinal}`);
    declared.set(identity, row);
    if (row.disposition === "delete") {
      assert.ok(row.category && row.reason, `delete row ${row.path}:${row.name} needs category and reason`);
      assert.ok(row.replacement || row.coverage_removed === true, `delete row ${row.path}:${row.name} needs replacement or coverage_removed`);
    }
  }
  assertMoveNameMultisets(manifest);

  const runtimeOrdinals = new Map();
  const runtime = new Map();
  for (const item of runtimeCases) {
    const base = JSON.stringify([item.path, item.name]);
    const ordinal = (runtimeOrdinals.get(base) ?? 0) + 1;
    runtimeOrdinals.set(base, ordinal);
    const identity = key({ ...item, ordinal });
    runtime.set(identity, item);
    const row = declared.get(identity);
    assert.ok(row, `missing manifest row for runtime case ${item.path}:${item.name}#${ordinal}`);
    assert.notEqual(row.disposition, "delete", `runtime case marked delete ${item.path}:${item.name}#${ordinal}`);
    assert.equal(row.ordinal, ordinal, `manifest ordinal does not match runtime order for ${item.path}:${item.name}`);
  }

  const moveSourcePaths = new Set(manifest.tests
    .filter((row) => row.disposition === "move")
    .map((row) => row.move_from));
  for (const [identity, row] of declared) {
    if (row.disposition === "delete" || moveSourcePaths.has(row.path)) continue;
    assert.ok(runtime.has(identity), `stale manifest row ${row.path}:${row.name}#${row.ordinal}`);
  }

  const declaredDeletes = manifest.tests.filter((row) => row.disposition === "delete").map(key).toSorted();

  // manifest) and is compared by identity, so normalize both shapes to keys.
  const allowedDeletes = (deleteAllowlist ?? manifest.tests.filter((row) => row.disposition === "delete"))
    .map((row) => (typeof row === "string" ? row : key(row)))
    .toSorted();
  assert.deepEqual(declaredDeletes, allowedDeletes, "manifest deletes must match the deletion allowlist");
  assertRawLane(manifest, { rawWriterFiles, rawLaneDeclarations });
  return true;
}

function assertRawLane(
  manifest: Manifest,
  { rawWriterFiles, rawLaneDeclarations }: Pick<ValidationOptions, "rawWriterFiles" | "rawLaneDeclarations">,
): void {
  if (!rawWriterFiles && !rawLaneDeclarations) return;
  const files = rawWriterFiles ?? [];
  const declarations = rawLaneDeclarations ?? {};

  for (const filePath of files) {
    assert.ok(declarations[filePath], `raw-lane declaration missing for ${filePath}`);
  }
  for (const filePath of Object.keys(declarations)) {
    assert.ok(files.includes(filePath), `stale raw-lane declaration for ${filePath}`);
  }
  for (const row of manifest.tests) {
    if (row.disposition === "delete") continue;
    const declaration = declarations[row.path];
    if (!declaration) continue;
    assert.ok(
      row.lane === "raw"
        && row.category === declaration.category
        && row.motive === declaration.motive
        && (row.replacement || row.coverage_removed === true),
      `raw lane row ${row.path}:${row.name} needs lane, category, motive and replacement`,
    );
  }
}

export { countByFileAndName };
