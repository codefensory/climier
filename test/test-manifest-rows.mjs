/** Row merge for the versioned test manifest.
 *

 * names the TAP reporter prints, so a row that exists in the manifest but not
 * in the runtime can only be an explicit declaration: a `delete` row for a
 * retired case, or the `move` row that documents where a renamed file came
 * from. Runtime rows inherit their disposition from the row they replace, so
 * adding disposition later does not silently downgrade it to `keep`.
 */

/** Stable identity of a manifest row: path, name and ordinal. */
function rowKey({ path, name, ordinal }) {
  return JSON.stringify([path, name, ordinal]);
}

/**

 *
 * @param {object} params
 * @param {{path: string, name: string}[]} params.rows runtime cases in TAP order

 * @param {Record<string, object>} [params.declarations] raw-lane annotations by path
 * @returns {object[]} sorted manifest rows, including the carried declarations
 */
export function buildManifestRows({ rows, previous = [], declarations = {} }) {
  const priorByKey = new Map(previous.map((row) => [rowKey(row), row]));
  const ordinalByName = new Map();
  const tests = rows.map(({ path: filePath, name }) => {
    const base = JSON.stringify([filePath, name]);
    const ordinal = (ordinalByName.get(base) ?? 0) + 1;
    ordinalByName.set(base, ordinal);
    const prior = priorByKey.get(JSON.stringify([filePath, name, ordinal]));
    if (prior?.disposition === "delete") return prior;
    const declaration = declarations[filePath];
    const carriedMoveMetadata = prior?.disposition === "move"
      ? Object.fromEntries(Object.entries(prior).filter(([key]) => !["path", "name", "ordinal", "disposition", "move_from"].includes(key)))
      : {};
    return {
      path: filePath,
      name,
      ordinal,
      disposition: prior?.disposition ?? "keep",
      ...(prior?.disposition === "move" ? { move_from: prior.move_from } : {}),
      ...carriedMoveMetadata,
      ...(declaration ? { lane: "raw", ...declaration } : {}),
    };
  });

  const carried = previous.filter((row) => (row.disposition === "delete" || row.disposition === "move")
    && !tests.some((current) => current.path === row.path && current.name === row.name && current.ordinal === row.ordinal));
  tests.push(...carried);
  tests.sort((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name) || left.ordinal - right.ordinal);
  return tests;
}
