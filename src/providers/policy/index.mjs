// T-graph-kernel-policy-seam — canonical policy provider/seam for the
// graph kernel (ADR-007 + ADR-008 + ADR-011 §3).
//
// This module is the single canonical entry point for policy selection
// and authorization used by handlers that route through `kernel.mutate`
// AND by handlers that still own their own `withLock` during the B1/B2
// transition. It re-exports the existing foundation (`src/policy.mjs`)
// so that:
//
//   - `applies`/`loadApplicablePolicy` runs OUTSIDE the lock — read-only
//     metadata-only selection over `.climier.json` and the installed
//     plugin set (no state read, no `withLock`, no persistence).
//   - `authorize`/`authorizeAction` runs INSIDE the lock against the
//     fresh snapshot + plan — preserves `allow`/`deny`/`abstain`,
//     surfaces `POLICY_DENIED`, `POLICY_ERROR` and `POLICY_CONFLICT`
//     without double-locking.
//
// Handlers should consume this module through `src/policy.mjs` (which is
// the canonical home for the selection/decision helpers) and the runtime
// error envelopes (`PolicyDenied`, `PolicyError`, `PolicyConflict`) from
// `src/plugins/errors.mjs`. This directory only exists to satisfy the
// provider-seam layout for the kernel registry (B6A) and to make the
// `applies` selector discoverable as a first-class kernel provider.
//
// No new behaviour, no second canonical implementation: this file is a
// thin re-export of the existing seam. Any future selection/decision
// helpers that the kernel needs (e.g. `decide()` adapters for
// `policyAction`) belong next to the existing helpers in
// `src/policy.mjs`, not here.
export {
  loadApplicablePolicy,
  authorizeAction,
  isPolicyError,
} from "../../policy.mjs";
