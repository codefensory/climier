// v1 stub for deprecate-knowledge. The real implementation lives in
// v2-deprecate-knowledge.mjs and is swapped in by bin/climier.mjs when
// state.version === 2. v1 has no knowledge nodes; this command has no
// v1 equivalent. Gotchas have `close-gotcha` for the same intent.
export default async function deprecateKnowledge() {
  throw new Error("deprecate-knowledge: v2-only command (no v1 equivalent); run `climier init --v2` to use it, or use `close-gotcha` on v1");
}