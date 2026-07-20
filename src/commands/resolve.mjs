// v1 stub for resolve. The real implementation lives in v2-resolve.mjs and is
// swapped in by bin/climier.mjs when state.version === 2. On a v1 project
// (or no state) this stub throws a clear v2-only error. v1 users have `done`.
export default async function resolve() {
  throw new Error("resolve: v2-only command (no v1 equivalent); run `climier init --v2` to use it, or use `done` on v1");
}