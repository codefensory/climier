// src/providers/knowledge/index.mjs — barrel for the knowledge providers.
//
// Exposes the three providers (knowledge.create, knowledge.update,
// knowledge.deprecate) plus the pure helpers used by the v2 read
// commands and by `knowledge.deprecate`'s downstream consumers
// (search, status alerts).
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

export { SCOPE_ORDER, matchesScopes } from "./scopes.mjs";
export { specificityRank, rankKnowledge } from "./ranking.mjs";
export { searchKnowledge } from "./search.mjs";
export { knowledgeForNode } from "./projection.mjs";
export { informingForNode } from "./informing.mjs";
export { createProvider } from "./create.mjs";
export { updateProvider } from "./update.mjs";
export { deprecateProvider } from "./deprecate.mjs";
