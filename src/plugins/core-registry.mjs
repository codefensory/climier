// Built-in operation catalog and compatibility facade for plugin consumers.
// Generic registry behavior lives in application/operations/registry.mjs.

import {
  buildRegistry as buildApplicationRegistry,
  ADMITTED_PROVIDER_KINDS as APPLICATION_ADMITTED_PROVIDER_KINDS,
} from "../application/operations/registry.mjs";
import {
  taskCreateProvider,
  taskUpdateProvider,
  taskTakeProvider,
  taskResolveProvider,
  taskReleaseProvider,
  taskReopenProvider,
  taskCancelProvider,
} from "../providers/task/index.mjs";
import {
  GATE_PROVIDER_KIND,
  gateProviders,
} from "../providers/gate/index.mjs";
import {
  createProvider as knowledgeCreateProviderFactory,
  updateProvider as knowledgeUpdateProviderFactory,
  deprecateProvider as knowledgeDeprecateProviderFactory,
} from "../providers/knowledge/index.mjs";
import { edgeAddProvider } from "../providers/core/edge.mjs";
import { noteAddProvider } from "../providers/core/note.mjs";
import { initiativeCreateProvider } from "../providers/core/initiative.mjs";

// Keep this named wrapper for consumers that imported the former plugin
// facade. Validation, indexing, and duplicate detection have one canonical
// implementation in application/operations.
export function buildRegistry(providers) {
  return buildApplicationRegistry(providers);
}

const TASK_OPERATION_IDS = Object.freeze([
  "task.create",
  "task.update",
  "task.take",
  "task.resolve",
  "task.release",
  "task.reopen",
  "task.cancel",
]);
const GATE_OPERATION_IDS = Object.freeze([
  "gate.create",
  "gate.update",
  "gate.resolve",
  "gate.reopen",
  "gate.cancel",
]);
const KNOWLEDGE_OPERATION_IDS = Object.freeze([
  "knowledge.create",
  "knowledge.update",
  "knowledge.deprecate",
]);
const CORE_OPERATION_IDS = Object.freeze([
  "edge.add",
  "note.add",
  "initiative.create",
]);

function asError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.message = message;
  if (details && typeof details === "object") error.details = Object.freeze({ ...details });
  return error;
}

function collectBuiltins() {
  const taskProviders = {
    "task.create": taskCreateProvider,
    "task.update": taskUpdateProvider,
    "task.take": taskTakeProvider,
    "task.resolve": taskResolveProvider,
    "task.release": taskReleaseProvider,
    "task.reopen": taskReopenProvider,
    "task.cancel": taskCancelProvider,
  };
  const taskEntries = TASK_OPERATION_IDS.map((id, opIndex) => {
    const provider = taskProviders[id];
    if (!provider) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: missing task provider for ${id} (opIndex ${opIndex})`,
        { id, opIndex },
      );
    }
    return { id, kind: "task", provider };
  });

  const gateEntries = GATE_OPERATION_IDS.map((id) => {
    const provider = gateProviders[id];
    if (!provider) {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: gateProviders has no entry for ${id}`,
        { id },
      );
    }
    return { id, kind: GATE_PROVIDER_KIND, provider };
  });

  const knowledgeFactories = {
    "knowledge.create": knowledgeCreateProviderFactory,
    "knowledge.update": knowledgeUpdateProviderFactory,
    "knowledge.deprecate": knowledgeDeprecateProviderFactory,
  };
  const knowledgeEntries = KNOWLEDGE_OPERATION_IDS.map((id) => {
    const factory = knowledgeFactories[id];
    if (typeof factory !== "function") {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: missing knowledge factory for ${id}`,
        { id },
      );
    }
    const provider = factory();
    if (!provider || typeof provider !== "object" ||
        typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_INVALID",
        `bootstrapBuiltins: knowledge factory for ${id} did not return { prepare, apply }`,
        { id },
      );
    }
    return { id, kind: "knowledge", provider };
  });

  const coreProviders = {
    "edge.add": edgeAddProvider,
    "note.add": noteAddProvider,
    "initiative.create": initiativeCreateProvider,
  };
  const coreEntries = CORE_OPERATION_IDS.map((id) => {
    const provider = coreProviders[id];
    if (!provider || typeof provider !== "object" ||
        typeof provider.prepare !== "function" || typeof provider.apply !== "function") {
      throw asError(
        "REGISTRY_BUILTIN_PROVIDER_MISSING",
        `bootstrapBuiltins: core provider for ${id} is not { prepare, apply }`,
        { id },
      );
    }
    return { id, kind: "core", provider };
  });

  return [...taskEntries, ...gateEntries, ...knowledgeEntries, ...coreEntries];
}

export function bootstrapBuiltins() {
  return buildRegistry(collectBuiltins());
}

export const ADMITTED_PROVIDER_KINDS = APPLICATION_ADMITTED_PROVIDER_KINDS;
export const PUBLIC_TASK_OPS = TASK_OPERATION_IDS;
export const PUBLIC_GATE_OPS = GATE_OPERATION_IDS;
export const PUBLIC_KNOWLEDGE_OPS = KNOWLEDGE_OPERATION_IDS;
export const PUBLIC_CORE_OPS = CORE_OPERATION_IDS;
