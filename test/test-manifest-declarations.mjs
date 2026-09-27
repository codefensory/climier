// Raw-lane declarations for the test fixture inventory.
//
// The detector (test-manifest-lanes.mjs) is textual on purpose: it reports every
// test file that mentions the pre-cut writers, and over-reporting is safe while
// under-reporting would silently drop a file from the inventory. Each reported
// file declares its category and motive here, and the checker fails when a
// reported file has no declaration, when a declaration is stale, or when a row
// of a declared file reaches the manifest without the annotation.
//
// Categories:
//   lane-legacy     seeds the pre-cut raw form; retires with the legacy lane
//   importer-source seeds source forms for the importer or proves the writer guards
//   guard           the fixture exists to prove a refusal
//   mention-only    the detector matched text (a title, comment or fixture
//                   string), not a call
//
// The ui-* suites are out of this inventory by design: they are a separate lane
// whose retirement is T-v1-ui-delete, and the collector does not enumerate them.

function laneLegacy(motive) {
  return { category: "lane-legacy", motive, replacement: "writeCanonicalState" };
}

const importerSource = (motive) => ({ category: "importer-source", motive, replacement: "no replacement until the importer lane retires" });
const guard = (motive) => ({ category: "guard", motive, replacement: "keep while the guard is required" });
const mentionOnly = (motive) => ({ category: "mention-only", motive, replacement: "none needed" });

export const rawLaneDeclarations = {
  "test/add-note.test.mjs": laneLegacy("seeds an existing project through updateState before exercising the add-note adapter"),
  "test/batch-cli.test.mjs": laneLegacy("seeds the batch project state through writeState before running the batch CLI"),
  "test/cli-remote-domain-routing.test.mjs": laneLegacy("seeds the routing sentinel through writeState before the remote domain assertions"),
  "test/cli-remote-read-routing.test.mjs": laneLegacy("seeds the routing sentinel through writeState before the remote read assertions"),
  "test/cli-remote-resolvable-lifecycle-routing.test.mjs": laneLegacy("seeds the routing sentinel through writeState before the remote lifecycle assertions"),
  "test/cli-remote-task-routing.test.mjs": laneLegacy("seeds the routing sentinel through writeState before the remote task assertions"),
  "test/cli-remote-write-routing.test.mjs": laneLegacy("seeds the routing sentinel through writeState before the remote write assertions"),
  "test/kernel-state-operations.test.mjs": importerSource("seeds explicit source states and asserts the writer guards that still refuse them"),
  "test/kernel-mutate-initiative.test.mjs": mentionOnly("names the writers in a test title and a comment; the fixture uses the ledger protocol"),
  "test/kernel/mutation/contract-guards.test.mjs": mentionOnly("names the writers in a comment listing what the module exports"),
  "test/plugin-compat-cli.test.mjs": laneLegacy("plants the plugin fixture through the local bootstrapState wrapper before the CLI run"),
  "test/plugin-compat-mutators.test.mjs": laneLegacy("plants the plugin fixture through the local bootstrapState wrapper before each mutator case"),
  "test/plugin-compat-read-model.test.mjs": laneLegacy("plants the plugin fixture through the local bootstrapState wrapper before the read-model cases"),
  "test/plugin-compat-snapshots.test.mjs": laneLegacy("plants the plugin fixture through the local bootstrapState wrapper before the snapshot cases"),
  "test/plugin-compat.test.mjs": laneLegacy("plants the plugin fixture through the local bootstrapState wrapper, and two cases assert the raw updateState path itself"),
  "test/plugin-foundation-acceptance.test.mjs": laneLegacy("seeds the acceptance project through writeState"),
  "test/plugin-install-residual-happy.test.mjs": laneLegacy("seeds the install project through writeState"),
  "test/plugin-install-residual-uninstall.test.mjs": laneLegacy("seeds the install project through writeState"),
  "test/plugin-policy-seam-lifecycle-note-initiative.test.mjs": mentionOnly("names updateState in a test title; the fixture uses the ledger protocol"),
  "test/plugin-query-snapshot.test.mjs": laneLegacy("seeds the snapshot state through writeState before the plugin query read"),
  "test/project-storage.test.mjs": laneLegacy("writes a v3 state to prove the path is deterministic before project metadata exists"),
  "test/snapshots-restore.test.mjs": laneLegacy("plants the pre-snapshot state through the local bootstrapState wrapper"),
  "test/state-cli.test.mjs": laneLegacy("seeds the current state through writeState before the state projection cases"),
  "test/state-snapshots.test.mjs": laneLegacy("plants the pre-snapshot state through the local bootstrapState wrapper"),
  "test/state.test.mjs": importerSource("covers the raw writer semantics and the guards that refuse ledger-backed projects"),
  "test/storage-ledger.test.mjs": importerSource("starts a legacy write to prove the migration fence refuses it"),
  "test/test-manifest.test.mjs": mentionOnly("carries the lane detector's fixture text; the file writes no state"),
  "test/v2-initiatives.test.mjs": laneLegacy("seeds the v2 collection shapes the reader must still accept"),
  "test/v2-lifecycle.test.mjs": laneLegacy("seeds the v2 state before the lifecycle assertions"),
  "test/v2-search.test.mjs": laneLegacy("seeds the v2 state before the search assertions"),
  "test/v2-take-by-id.test.mjs": laneLegacy("seeds the v2 state before the take-by-id assertions"),
  "test/v5-read-consumers.test.mjs": guard("seeds 2, 3 and 4 sources for read compatibility and a version 6 source to prove the refusal"),
};
