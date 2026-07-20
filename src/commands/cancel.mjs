// v1 stub for cancel. The real implementation lives in v2-cancel.mjs and is
// swapped in by bin/climier.mjs when state.version === 2. On a v1 project
// (or no state) this stub throws a clear v2-only error so the caller knows
// the command is not missing — it has no v1 equivalent.
export default async function cancel() {
  throw new Error("cancel: v2-only command (no v1 equivalent); run `climier init --v2` to use it, or use `archive` on v1");
}