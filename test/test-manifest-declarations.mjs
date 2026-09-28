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

const importerSource = (motive) => ({ category: "importer-source", motive, replacement: "no replacement until the importer lane retires" });
const guard = (motive) => ({ category: "guard", motive, replacement: "keep while the guard is required" });
const mentionOnly = (motive) => ({ category: "mention-only", motive, replacement: "none needed" });

export const rawLaneDeclarations = {
  "test/kernel-mutate-initiative.test.mjs": mentionOnly("names the writers in a test title and a comment; the fixture uses the ledger protocol"),
  "test/kernel/mutation/contract-guards.test.mjs": mentionOnly("names the writers in a comment listing what the module exports"),
  "test/plugin-compat.test.mjs": guard("`init --force on a state with corrupt JSON (cannot read) does not crash and writes emptyState()` seeds a raw v4 source with no ledger because a ledger changes recovery by rejecting the replacement candidate with CLIMIER_LEDGER_FINGERPRINT_MISMATCH"),
  "test/plugin-policy-seam-lifecycle-note-initiative.test.mjs": mentionOnly("names updateState in a test title; the fixture uses the ledger protocol"),
  "test/state.test.mjs": importerSource("covers the raw writer semantics and the guards that refuse ledger-backed projects"),
  "test/test-manifest.test.mjs": mentionOnly("carries the lane detector's fixture text; the file writes no state"),
  "test/v2-initiatives.test.mjs": guard("asserts legacy writeState schema validation and rejection; valid fixture uses writeCanonicalState"),
  "test/v5-read-consumers.test.mjs": guard("seeds 2, 3 and 4 sources for read compatibility and a version 6 source to prove the refusal"),
};
