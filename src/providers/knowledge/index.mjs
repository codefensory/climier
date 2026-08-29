// src/providers/knowledge/index.mjs — barrel for the knowledge-core
// provider slice (plan B4-knowledge-core).
//
// Exposes the two providers (knowledge.create, knowledge.update) plus
// the pure helpers used by the v2 read commands and the future
// B4-knowledge-lifecycle slice.
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

export { SCOPE_ORDER, matchesScopes } from "./scopes.mjs";
export { specificityRank, rankKnowledge } from "./ranking.mjs";
export { searchKnowledge } from "./search.mjs";
export { informingForNode } from "./informing.mjs";
export { createProvider } from "./create.mjs";
export { updateProvider } from "./update.mjs";
