// Compatibility facade for plugin consumers of the registry API.
// The generic registry and built-in catalog are owned by Application
// Operations; this module intentionally contains no provider composition.

export {
  buildRegistry,
  ADMITTED_PROVIDER_KINDS,
} from "../application/operations/registry.mjs";
export {
  createBuiltinOperationRegistry,
  bootstrapBuiltins,
  PUBLIC_TASK_OPS,
  PUBLIC_GATE_OPS,
  PUBLIC_KNOWLEDGE_OPS,
  PUBLIC_CORE_OPS,
} from "../application/operations/builtins.mjs";
