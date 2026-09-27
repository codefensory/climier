import assert from "node:assert/strict";

function key({ path, name, ordinal }) {
  return JSON.stringify([path, name, ordinal]);
}

function countByFileAndName(rows) {
  const counts = new Map();
  for (const row of rows) {
    const item = JSON.stringify([row.path, row.name]);
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function assertMoveNameMultisets(manifest) {
  const moves = new Map();
  for (const row of manifest.tests) {
    if (row.disposition !== "move") continue;
    assert.equal(typeof row.move_from, "string", `move row ${row.path}:${row.name} needs move_from`);
    const source = moves.get(row.move_from) ?? [];
    source.push(row);
    moves.set(row.move_from, source);
  }

  for (const [sourcePath, destinationRows] of moves) {
    const sourceRows = manifest.tests.filter((row) => row.path === sourcePath && row.disposition === "move");
    assert.ok(sourceRows.length > 0, `move source ${sourcePath} has no manifest rows`);
    assert.deepEqual(
      countByFileAndName(sourceRows),
      countByFileAndName(destinationRows),
      `move from ${sourcePath} must preserve the runtime name multiset`,
    );
  }
}

export function validateManifest(manifest, runtimeCases, { deleteAllowlist } = {}) {
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
    assert.ok(row, `unlisted runtime case ${item.path}:${item.name}#${ordinal}`);
    assert.notEqual(row.disposition, "delete", `runtime case marked delete ${item.path}:${item.name}#${ordinal}`);
  }

  for (const [identity, row] of declared) {
    if (row.disposition === "delete") continue;
    assert.ok(runtime.has(identity), `stale manifest row ${row.path}:${row.name}#${row.ordinal}`);
  }

  const declaredDeletes = manifest.tests.filter((row) => row.disposition === "delete").map(key).toSorted();
  const allowedDeletes = (deleteAllowlist ?? declaredDeletes).toSorted();
  assert.deepEqual(declaredDeletes, allowedDeletes, "manifest deletes must match the deletion allowlist");
  return true;
}

export { countByFileAndName };
