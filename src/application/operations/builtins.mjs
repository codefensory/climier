// Built-in operation catalog for the Application Operations boundary.
//
// This module owns native operation IDs and provider composition. It is
// process-local: building the registry does not touch state or persistence.

import { buildRegistry, ADMITTED_PROVIDER_KINDS } from "./registry.mjs";
import {
  taskCreateProvider, taskUpdateProvider, taskTakeProvider, taskReleaseProvider, taskReopenProvider,
  taskCancelProvider, taskSubmitProvider, taskAcceptProvider, taskRejectProvider,
} from "../../providers/task/index.mjs";
import { GATE_PROVIDER_KIND, gateProviders } from "../../providers/gate/index.mjs";
import {
  createProvider as knowledgeCreateProviderFactory,
  updateProvider as knowledgeUpdateProviderFactory,
  deprecateProvider as knowledgeDeprecateProviderFactory,
} from "../../providers/knowledge/index.mjs";
import { edgeAddProvider, edgeRemoveProvider } from "../../providers/core/edge.mjs";
import { noteAddProvider } from "../../providers/core/note.mjs";
import { initiativeCreateProvider } from "../../providers/core/initiative.mjs";

const TASK_OPERATION_IDS = Object.freeze([
  "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel",
  "task.submit", "task.accept", "task.reject",
]);
const GATE_OPERATION_IDS = Object.freeze(["gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel"]);
const KNOWLEDGE_OPERATION_IDS = Object.freeze(["knowledge.create", "knowledge.update", "knowledge.deprecate"]);
const CORE_OPERATION_IDS = Object.freeze(["edge.add", "edge.remove", "note.add", "initiative.create"]);

function asError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.message = message;
  if (details && typeof details === "object") {error.details = Object.freeze({ ...details });}
  return error;
}

function entriesFromIds(ids, providers, kind, label) {
  return ids.map((id, index) => {
    const provider = providers[id];
    if (!provider) {
      const details = label === "task" ? { id, opIndex: index } : { id };
      const suffix = label === "task" ? ` (opIndex ${index})` : "";
      throw asError("REGISTRY_BUILTIN_PROVIDER_MISSING", `bootstrapBuiltins: missing ${label} provider for ${id}${suffix}`, details);
    }
    return { id, kind, provider };
  });
}

function taskEntries() {
  return entriesFromIds(TASK_OPERATION_IDS, {
    "task.create": taskCreateProvider, "task.update": taskUpdateProvider, "task.take": taskTakeProvider,
    "task.release": taskReleaseProvider, "task.reopen": taskReopenProvider, "task.cancel": taskCancelProvider,
    "task.submit": taskSubmitProvider, "task.accept": taskAcceptProvider, "task.reject": taskRejectProvider,
  }, "task", "task");
}

function gateEntries() {
  return entriesFromIds(GATE_OPERATION_IDS, gateProviders, GATE_PROVIDER_KIND, "gate");
}

function knowledgeEntries() {
  const factories = {
    "knowledge.create": knowledgeCreateProviderFactory,
    "knowledge.update": knowledgeUpdateProviderFactory,
    "knowledge.deprecate": knowledgeDeprecateProviderFactory,
  };
  return KNOWLEDGE_OPERATION_IDS.map((id) => {
    const factory = factories[id];
    if (typeof factory !== "function") {
      throw asError("REGISTRY_BUILTIN_PROVIDER_MISSING", `bootstrapBuiltins: missing knowledge factory for ${id}`, { id });
    }
    const provider = factory();
    if (!provider || typeof provider !== "object" || typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
      throw asError("REGISTRY_BUILTIN_PROVIDER_INVALID", `bootstrapBuiltins: knowledge factory for ${id} did not return { prepare, apply }`, { id });
    }
    return { id, kind: "knowledge", provider };
  });
}

function coreEntries() {
  return entriesFromIds(CORE_OPERATION_IDS, {
    "edge.add": edgeAddProvider, "edge.remove": edgeRemoveProvider, "note.add": noteAddProvider,
    "initiative.create": initiativeCreateProvider,
  }, "core", "core").map(({ id, kind, provider }) => {
    if (typeof provider !== "object" || typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
      throw asError("REGISTRY_BUILTIN_PROVIDER_MISSING", `bootstrapBuiltins: core provider for ${id} is not { prepare, apply }`, { id });
    }
    return { id, kind, provider };
  });
}

function collectBuiltins() {
  return [...taskEntries(), ...gateEntries(), ...knowledgeEntries(), ...coreEntries()];
}

/** Build the canonical registry of native Application Operations. */
export function createBuiltinOperationRegistry() {
  return buildRegistry(collectBuiltins());
}

/** Compatibility name for callers that bootstrap the native catalog. */
export function bootstrapBuiltins() {
  return createBuiltinOperationRegistry();
}

export { ADMITTED_PROVIDER_KINDS };
export const PUBLIC_TASK_OPS = TASK_OPERATION_IDS;
export const PUBLIC_GATE_OPS = GATE_OPERATION_IDS;
export const PUBLIC_KNOWLEDGE_OPS = KNOWLEDGE_OPERATION_IDS;
export const PUBLIC_CORE_OPS = CORE_OPERATION_IDS;
