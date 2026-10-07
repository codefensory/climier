// Raw-lane declarations for the test fixture inventory.
//

// test file that mentions the pre-cut writers, and over-reporting is safe while
// under-reporting would silently drop a file from the inventory. Each reported
// file declares its category and motive here, and the checker fails when a
// reported file has no declaration, when a declaration is stale, or when a row
// of a declared file reaches the manifest without the annotation.
//
// Categories:

//   importer-source seeds source forms for the importer or proves the writer guards
//   guard           the fixture exists to prove a refusal
//   mention-only    the detector matched text (a title, comment or fixture
//                   string), not a call
//

type RawLaneDeclaration = { category: string; motive: string; replacement: string };

const importerSource = (motive: string): RawLaneDeclaration => ({ category: "importer-source", motive, replacement: "no replacement until the importer lane retires" });
const guard = (motive: string): RawLaneDeclaration => ({ category: "guard", motive, replacement: "keep while the guard is required" });
const mentionOnly = (motive: string): RawLaneDeclaration => ({ category: "mention-only", motive, replacement: "none needed" });

export const rawLaneDeclarations: Record<string, RawLaneDeclaration> = {
  "test/kernel-mutate-initiative.test.ts": mentionOnly("names the writers in a test title and a comment; the fixture uses the ledger protocol"),
  "test/kernel/mutation/contract-guards.test.ts": mentionOnly("names the writers in a comment listing what the module exports"),
  "test/plugin-compat.test.ts": guard("`init --force on a state with corrupt JSON (cannot read) does not crash and writes emptyState()` seeds a raw v4 source with no ledger because a ledger changes recovery by rejecting the replacement candidate with CLIMIER_LEDGER_FINGERPRINT_MISMATCH"),
  "test/plugin-policy-seam-lifecycle-note-initiative.test.ts": mentionOnly("names updateState in a test title; the fixture uses the ledger protocol"),
  "test/state.test.ts": importerSource("covers the raw writer semantics and the guards that refuse ledger-backed projects"),
  "test/test-manifest.test.ts": mentionOnly("carries the lane detector's fixture text; the file writes no state"),
  "test/initiatives.test.ts": guard("asserts legacy writeState schema validation and rejection; valid fixture uses writeCanonicalState"),
  "test/v5-read-consumers.test.ts": guard("seeds 2, 3 and 4 sources for read compatibility and a version 6 source to prove the refusal"),
};
