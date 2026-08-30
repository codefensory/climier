// Transitional compatibility facade. New consumers should import the
// canonical kernel/provider/read-model modules directly.

export { throwV2 } from "./errors.mjs";
export {
  EDGE_TYPES,
  EDGE_TYPE_CONSTANTS,
  existingEdge,
  blocksEdge,
  validateEdge,
} from "./kernel/edges.mjs";
export { deriveV2, isSatisfiedV2 } from "./providers/task/derivation.mjs";
export { supersededBy, isCurrent } from "./providers/gate/semantics.mjs";
export {
  statusOfV2,
  blockingForNode,
  knowledgeForNode,
  informingForNode,
} from "./read-model/index.mjs";
