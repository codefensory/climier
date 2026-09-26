// `update <id>` CLI adapter for the canonical task/gate/knowledge providers.
//
// The CLI keeps its historical flags and envelopes. This module parses those
// flags, selects the canonical update operation, and delegates it through the
// Application Operations bridge. The provider plan carries compatibility-only
// fields to the same kernel transaction as typed changes.
import {
  bootstrapBuiltins,
  createOperationBridge,
  executeOperation,
} from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { readState } from "../../storage/state.mjs";
import { isRemoteBackend, throwMissingRemoteNode } from "./internal/task-routing.mjs";
import { readRemoteNode, nodeFromMutation } from "./internal/domain-routing.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";

const REGISTRY = bootstrapBuiltins();

export const knownFlags = [
  "title",
  "body",
  "initiative",
  "domain",
  "tags",
  "refs",
  "meta",
  "definition",
  "acceptance",
  "backlog",
  "purpose",
  "resolution-mode",
  "knowledge-type",
  "mitigation",
  "scope-domains",
  "scope-initiatives",
  "scope-tags",
  "scope-node-ids",
  "if-revision",
  "as",
];

function csv(raw) {
  if (!raw || raw === true) return [];
  return String(raw).split(",").map((value) => value.trim()).filter(Boolean);
}

function refs(raw) {
  return csv(raw).map((target) => ({ type: "external", target }));
}

function parseMeta(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --meta requires a JSON object value");
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`update: --meta must be valid JSON (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("update: --meta must be a JSON object");
  }
  // Metadata is generic JSON. Historical meta.execution values remain opaque
  // and are preserved without validation or normalization by the core.
  return parsed;
}

function parseBacklog(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --backlog requires a value (true or false)");
  const value = String(raw).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`update: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return value === "true";
}

function parseIfRevision(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --if-revision requires a numeric value");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`update: --if-revision must be a positive integer (got '${raw}')`);
  }
  return value;
}

const SCALAR_FLAGS = [
  "title",
  "body",
  "initiative",
  "domain",
  "definition",
  "acceptance",
  "purpose",
  "mitigation",
];

function buildChanges(flags) {
  const changes = {};
  for (const field of SCALAR_FLAGS) {
    if (flags[field] === undefined) continue;
    if (flags[field] === true) throw new Error(`update: --${field} requires a value`);
    changes[field] = flags[field];
  }

  if (flags["resolution-mode"] !== undefined) {
    if (flags["resolution-mode"] === true) throw new Error("update: --resolution-mode requires a value");
    changes.resolution_mode = flags["resolution-mode"];
  }
  if (flags["knowledge-type"] !== undefined) {
    if (flags["knowledge-type"] === true) throw new Error("update: --knowledge-type requires a value");
    changes.knowledge_type = flags["knowledge-type"];
  }
  if (flags.tags !== undefined) {
    if (flags.tags === true) throw new Error("update: --tags requires a value");
    changes.tags = csv(flags.tags);
  }
  if (flags.refs !== undefined) {
    if (flags.refs === true) throw new Error("update: --refs requires a value");
    changes.refs = refs(flags.refs);
  }
  if (flags.meta !== undefined) changes.meta = parseMeta(flags.meta);

  const backlog = parseBacklog(flags.backlog);
  if (backlog !== undefined) changes.backlog = backlog;

  const scope = {};
  for (const flag of ["scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids"]) {
    if (flags[flag] === undefined) continue;
    if (flags[flag] === true) throw new Error(`update: --${flag} requires a value`);
    const key = flag === "scope-node-ids"
      ? "node_ids"
      : flag.slice("scope-".length);
    scope[key] = csv(flags[flag]);
  }
  if (Object.keys(scope).length > 0) changes.scope = scope;

  if (Object.keys(changes).length === 0) {
    throw new Error("update: at least one field required (e.g. --title X)");
  }
  return changes;
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  if (node && node.kind === "knowledge") return REGISTRY.lookup("knowledge.update").provider;
  if (node && node.kind === "resolvable" && node.subkind === "gate") return REGISTRY.lookup("gate.update").provider;
  return REGISTRY.lookup("task.update").provider;
}

// Preserve the complete historical CLI patch surface while applying typed and
// compatibility-only fields in the provider's one transaction draft.
const PROVIDER_PATCH_KEYS = Object.freeze({
  task: new Set(["title", "body", "acceptance", "definition", "domain", "initiative", "tags", "refs"]),
  gate: new Set(["title", "body", "initiative", "domain", "tags", "refs", "meta", "definition", "acceptance", "backlog", "purpose", "resolution_mode"]),
  knowledge: new Set(["title", "body", "mitigation", "knowledge_type", "scope", "status", "domain", "tags", "refs", "meta"]),
});

function createUpdateProvider(id, changes, expectedRevision) {
  return {
    async prepare(args) {
      const provider = providerFor(args.snapshot, id);
      const current = args.snapshot?.nodes?.[id] || null;
      const revision = expectedRevision ?? (Number.isInteger(current?.revision) ? current.revision : 1);
      args.request.if_revision = { kind: "single", id, value: revision };
      const providerKey = current?.kind === "knowledge"
        ? "knowledge"
        : current?.subkind === "gate"
          ? "gate"
          : "task";
      const typed = {};
      const legacy = {};
      for (const [field, value] of Object.entries(changes)) {
        (PROVIDER_PATCH_KEYS[providerKey].has(field) ? typed : legacy)[field] = value;
      }
      if (typed.scope) typed.scope = { ...(current?.scope || {}), ...typed.scope };
      if (legacy.scope) legacy.scope = { ...(current?.scope || {}), ...legacy.scope };
      if (legacy.backlog === false) legacy.backlog = undefined;
      const providerChanges = Object.keys(typed).length > 0
        ? typed
        : { title: typeof current?.title === "string" ? current.title : "" };
      const plan = await provider.prepare({
        ...args,
        input: { ...args.input, changes: providerChanges, if_revision: revision },
      });
      return {
        ...plan,
        target: { ...plan.target, status: current?.status },
        logAction: "update",
        legacy_patch: legacy,
      };
    },
    async apply(args) {
      const provider = providerFor(args.snapshot, id);
      const applied = await provider.apply(args);
      if (args.plan.legacy_patch && Object.keys(args.plan.legacy_patch).length > 0) {
        args.tx.updateNode(id, args.plan.legacy_patch);
      }
      return { ...applied, result: args.tx.getNode(id) };
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
        return operation.endsWith(".update") && entry ? { ...entry, provider } : entry;
      },
    },
  };
}

export default async function update({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
  backendClient,
  source,
}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "update: node id required", { field: "id" });

  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "update");
  const changes = buildChanges(flags);
  const expectedRevision = parseIfRevision(flags["if-revision"]);

  let operation;
  let target;
  if (isRemoteBackend(backendClient)) {
    target = await readRemoteNode(backendClient, id, "update");
    operation = target.kind === "knowledge"
      ? "knowledge.update"
      : target.kind === "resolvable" && target.subkind === "gate"
        ? "gate.update"
        : target.kind === "resolvable" && target.subkind === "task"
          ? "task.update"
          : null;
    if (!operation) {
      throwV2("REMOTE_UNSUPPORTED_OPERATION", `update: remote target ${id} is not a task, gate, or knowledge node`, {
        id,
        kind: target.kind,
        subkind: target.subkind,
      });
    }
  } else {
    const snapshot = await readState(dir);
    target = snapshot.nodes?.[id] || null;
    operation = target?.kind === "knowledge"
      ? "knowledge.update"
      : target?.kind === "resolvable" && target.subkind === "gate"
        ? "gate.update"
        : "task.update";
  }

  const input = { id, changes };
  if (expectedRevision !== undefined) input.if_revision = expectedRevision;
  else if (isRemoteBackend(backendClient)) input.if_revision = Number.isInteger(target?.revision) ? target.revision : 1;
  const selectedClient = isRemoteBackend(backendClient)
    ? backendClient
    : {
        ...(backendClient || {}),
        type: "local",
        async executeOperation(args) {
          const operationSource = source || await backendClient?.operationSource || {
            registry: REGISTRY,
            mutate,
            loadApplicablePolicy: ({ projectDir }) => loadApplicablePolicy({ projectDir }),
            authorizeAction,
            pluginId,
          };
          const provider = createUpdateProvider(id, changes, expectedRevision);
          return executeOperation({
            projectDir: dir,
            actor: agent,
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
  const mutation = await createOperationBridge({ backendClient: selectedClient }).executeOperation({
    actor: agent,
    operation,
    input,
  });
  let node = isRemoteBackend(selectedClient)
    ? nodeFromMutation(mutation, id) || mutation.result?.node || null
    : mutation.diff.updated.find((entry) => entry.id === id)?.node || null;
  if (!node && mutation.result && typeof mutation.result === "object") {
    node = { ...mutation.result, revision: mutation.diff.target_revision };
    delete node.added_edges;
  }
  if (!node) throwMissingRemoteNode("update", id);
  return { node };
}
