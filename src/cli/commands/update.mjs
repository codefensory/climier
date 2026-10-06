
import {
  createOperationBridge,
  executeOperation,
} from "../../application/operations/index.mjs";
import { getOperationSource } from "../../operation-source.mjs";
import { readState } from "../../storage/state.mjs";
import { isRemoteBackend, throwMissingRemoteNode } from "./internal/task-routing.mjs";
import { readRemoteNode, nodeFromMutation } from "./internal/domain-routing.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";


export const knownFlags = ["title", "body", "initiative", "domain", "tags", "refs", "meta", "definition", "acceptance", "backlog", "purpose", "resolution-mode", "knowledge-type", "mitigation", "scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids", "if-revision", "as"];

export const UPDATE_FLAG_TO_KEY = Object.freeze({
  "resolution-mode": "resolution_mode",
  "knowledge-type": "knowledge_type",
  "scope-domains": "scope.domains",
  "scope-initiatives": "scope.initiatives",
  "scope-tags": "scope.tags",
  "scope-node-ids": "scope.node_ids",
});

function csv(raw) {
  if (!raw || raw === true) {
    return [];
  }
  return String(raw).split(",").map((value) => value.trim()).filter(Boolean);
}
function refs(raw) {
  return csv(raw).map((target) => ({ type: "external", target }));
}
function parseMeta(raw) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error("update: --meta requires a JSON object value");
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`update: --meta must be valid JSON (${error.message})`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("update: --meta must be a JSON object");
  }

  return parsed;
}
function parseBacklog(raw) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error("update: --backlog requires a value (true or false)");
  }
  const value = String(raw).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`update: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return value === "true";
}
function parseIfRevision(raw) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error("update: --if-revision requires a numeric value");
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`update: --if-revision must be a positive integer (got '${raw}')`);
  }
  return value;
}

const SCALAR_FLAGS = ["title", "body", "initiative", "domain", "definition", "acceptance", "purpose", "mitigation"];

function buildScalarChanges(flags) {
  const changes = {};
  for (const field of SCALAR_FLAGS) {
    if (flags[field] === undefined) {
      continue;
    }
    if (flags[field] === true) {
      throw new Error(`update: --${field} requires a value`);
    }
    changes[field] = flags[field];
  }
  return changes;
}
function addFlagChange(changes, flags, flag, field) {
  if (flags[flag] === undefined) {
    return;
  }
  if (flags[flag] === true) {
    throw new Error(`update: --${flag} requires a value`);
  }
  changes[field] = flags[flag];
}
function buildFlagChanges(flags) {
  const changes = {};
  addFlagChange(changes, flags, "resolution-mode", "resolution_mode");
  addFlagChange(changes, flags, "knowledge-type", "knowledge_type");
  if (flags.tags !== undefined) {
    if (flags.tags === true) {
      throw new Error("update: --tags requires a value");
    }
    changes.tags = csv(flags.tags);
  }
  if (flags.refs !== undefined) {
    if (flags.refs === true) {
      throw new Error("update: --refs requires a value");
    }
    changes.refs = refs(flags.refs);
  }
  if (flags.meta !== undefined) {
    changes.meta = parseMeta(flags.meta);
  }
  return changes;
}
function buildScope(flags) {
  const scope = {};
  for (const flag of ["scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids"]) {
    if (flags[flag] === undefined) {
      continue;
    }
    if (flags[flag] === true) {
      throw new Error(`update: --${flag} requires a value`);
    }
    const key = flag === "scope-node-ids"
      ? "node_ids"
      : flag.slice("scope-".length);
    scope[key] = csv(flags[flag]);
  }
  return scope;
}
function buildChanges(flags) {
  const changes = { ...buildScalarChanges(flags), ...buildFlagChanges(flags) };
  const backlog = parseBacklog(flags.backlog);
  if (backlog !== undefined) {
    changes.backlog = backlog;
  }
  const scope = buildScope(flags);
  if (Object.keys(scope).length > 0) {
    changes.scope = scope;
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("update: at least one field required (e.g. --title X)");
  }
  return changes;
}
function providerFor(snapshot, id, operationSource) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  if (node && node.kind === "knowledge") {
    return operationSource.registry.lookup("knowledge.update").provider;
  }
  if (node && node.kind === "resolvable" && node.subkind === "gate") {
    return operationSource.registry.lookup("gate.update").provider;
  }
  return operationSource.registry.lookup("task.update").provider;
}

async function prepareUpdateProvider(args, id, changes, expectedRevision, operationSource, selectedProvider) {
  const provider = selectedProvider || providerFor(args.snapshot, id, operationSource);
  const current = args.snapshot?.nodes?.[id] || null;
  const revision = expectedRevision ?? (Number.isInteger(current?.revision) ? current.revision : 1);
  args.request.if_revision = { kind: "single", id, value: revision };
  const plan = await provider.prepare({
    ...args,
    input: { ...args.input, changes, if_revision: revision },
  });
  return {
    ...plan,
    target: { ...plan.target, status: current?.status },
    logAction: "update",
  };
}

async function applyUpdateProvider(args, id, operationSource, selectedProvider) {
  const provider = selectedProvider || providerFor(args.snapshot, id, operationSource);
  const applied = await provider.apply(args);
  return { ...applied, result: args.tx.getNode(id) };
}
function createUpdateProvider(id, changes, expectedRevision, operationSource) {
  let selectedProvider;
  return {
    setSelectedProvider(provider) {
      selectedProvider = provider;
    },
    prepare(args) {
      return prepareUpdateProvider(args, id, changes, expectedRevision, operationSource, selectedProvider);
    },
    apply(args) {
      return applyUpdateProvider(args, id, operationSource, selectedProvider);
    },
  };
}
function withUpdateProvider(source, provider) {
  return {
    ...source,
    registry: {
      ...source.registry,
      lookup(operation) {
        const entry = source.registry.lookup(operation);
        if (operation.endsWith(".update") && entry) {
          provider.setSelectedProvider(entry.provider || entry);
          return { ...entry, provider };
        }
        return entry;
      },
    },
  };
}
function operationForTarget(target) {
  if (target?.kind === "knowledge") {
    return "knowledge.update";
  }
  if (target?.kind === "resolvable") {
    const operationBySubkind = { gate: "gate.update", task: "task.update" };
    return operationBySubkind[target.subkind] || null;
  }
  return null;
}

async function readUpdateTarget(backendClient, dir, id) {
  if (isRemoteBackend(backendClient)) {
    const target = await readRemoteNode(backendClient, id, "update");
    const operation = operationForTarget(target);
    if (!operation) {
      throwV2("REMOTE_UNSUPPORTED_OPERATION", `update: remote target ${id} is not a task, gate, or knowledge node`, {
        id,
        kind: target.kind,
        subkind: target.subkind,
      });
    }
    return { target, operation };
  }
  const snapshot = await readState(dir);
  const target = snapshot.nodes?.[id] || null;
  return { target, operation: operationForTarget(target) || "task.update" };
}
function createLocalClient({ backendClient, source, pluginId, dir }) {
  return {
    ...backendClient,
    type: "local",
    async executeOperation(args) {
      const operationSource = source || await backendClient?.operationSource || await getOperationSource();
      const provider = createUpdateProvider(args.input.id, args.input.changes, args.input.if_revision, operationSource);
      return executeOperation({
        projectDir: dir,
        actor: args.actor,
        operation: args.operation,
        input: args.input,
        source: withUpdateProvider({ ...operationSource, pluginId: operationSource.pluginId || pluginId }, provider),
        policyActionFromPlan: true,
      });
    },
    async executeBatch() {
      throwV2("INVALID_OPERATION_BRIDGE", "update: single operation execution is required");
    },
  };
}
function buildOperationInput({ id, changes, expectedRevision, target, remote }) {
  const input = { id, changes };
  if (expectedRevision !== undefined) {
    input.if_revision = expectedRevision;
  } else if (remote) {
    input.if_revision = Number.isInteger(target?.revision) ? target.revision : 1;
  }
  return input;
}
function remoteNodeFromMutation(mutation, id) {
  return nodeFromMutation(mutation, id) || mutation.result?.node || null;
}
function localNodeFromMutation(mutation, id) {
  return mutation.diff.updated.find((entry) => entry.id === id)?.node || null;
}
function updatedNodeFromMutation(mutation, id, remote) {
  let node = remote
    ? remoteNodeFromMutation(mutation, id)
    : localNodeFromMutation(mutation, id);
  if (!node && mutation.result && typeof mutation.result === "object") {
    node = { ...mutation.result, revision: mutation.diff.target_revision };
    delete node.added_edges;
  }
  return node;
}

export default async function update({ statePath, projectDir, flags = {}, positional = [], pluginId, backendClient, source }) {
  const id = positional[0];
  if (!id) {
    throwV2("MISSING_FIELD", "update: node id required", { field: "id" });
  }
  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "update");
  const changes = buildChanges(flags);
  const expectedRevision = parseIfRevision(flags["if-revision"]);
  const { target, operation } = await readUpdateTarget(backendClient, dir, id);
  const input = buildOperationInput({
    id,
    changes,
    expectedRevision,
    target,
    remote: isRemoteBackend(backendClient),
  });
  const selectedClient = isRemoteBackend(backendClient)
    ? backendClient
    : createLocalClient({ backendClient, source, pluginId, dir });
  const mutation = await createOperationBridge({ backendClient: selectedClient }).executeOperation({
    actor: agent,
    operation,
    input,
  });
  const node = updatedNodeFromMutation(mutation, id, isRemoteBackend(selectedClient));
  if (!node) {
    throwMissingRemoteNode("update", id);
  }
  return { node };
}
