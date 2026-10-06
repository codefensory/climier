// src/providers/knowledge/index.ts — barrel for the knowledge providers.
// Exposes the three providers (knowledge.create, knowledge.update,

// commands and by `knowledge.deprecate`'s downstream consumers
// (search, status alerts).
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

export { SCOPE_ORDER, matchesScopes } from "./scopes.ts";
export { specificityRank, rankKnowledge } from "./ranking.ts";
export { searchKnowledge } from "./search.ts";
export { knowledgeForNode } from "./projection.ts";
export { informingForNode } from "./informing.ts";
export { createProvider } from "./create.ts";
export { updateProvider } from "./update.ts";
export { deprecateProvider } from "./deprecate.ts";
