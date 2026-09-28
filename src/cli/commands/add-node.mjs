
import { createBackendClient } from "../../application/backend-client.mjs";
import { createOperationBridge, executeOperation } from "../../application/operations/index.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

export const knownFlags = [
  "kind",
  "subkind",
  "title",
  "body",
  "refs",
  "meta",
  "initiative",
  "domain",
  "tags",
  "status",
  "resolution-mode",
  "purpose",
  "definition",
  "acceptance",
  "choice",
  "rationale",
  "knowledge-type",
  "mitigation",
  "scope-domains",
  "scope-initiatives",
  "scope-tags",
  "scope-node-ids",
  "backlog",
  "blocked-by",
  "derived-from",
  "supersedes",
  "as",
];

function csv(raw) {
  if (!raw || raw === true) {return [];}
  return String(raw).split(",").map((x) => x.trim()).filter(Boolean);
}

function refs(raw) {
  return raw;
}

function parseMeta(raw) {
  if (raw === undefined) {return undefined;}
  if (raw === true) {throw new Error("add-node: --meta requires a JSON object value");}
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`add-node: --meta must be valid JSON (${err.message})`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("add-node: --meta must be a JSON object");
  }

  return parsed;
}

function parseBacklog(raw) {
  if (raw === undefined) {return undefined;}
  if (raw === true) {throw new Error("add-node: --backlog requires a value (true or false)");}
  const value = String(raw).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`add-node: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return value === "true";
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonEmptyString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function withLegacyCreateLogAction(source, command, input) {
  let action = "add-node";
  if (command === "add-task") {action = "add-task";}
  else if (input.supersedes) {action = "supersede";}
  return {
    ...source,
    mutate(mutation) {
      mutation.request.action = action;
      return source.mutate(mutation);
    },
  };
}

async function bridgeClientForCreate(client, { projectDir, source, pluginId, command, input }) {
  if (client.type !== "local" || typeof client.executeOperation !== "function") {return client;}
  const operationSource = source ?? (client.operationSource ? await client.operationSource : null);
  if (!operationSource) {return client;}
  const selectedSource = withLegacyCreateLogAction({ ...operationSource, pluginId }, command, input);
  return {
    type: "local",
    executeOperation({ actor, operation, input: operationInput }) {
      return executeOperation({ projectDir, actor, operation, input: operationInput, source: selectedSource });
    },
    executeBatch(args) {
      return client.executeBatch(args);
    },
  };
}

function taskInput(id, flags, allowUnregistered) {
  const title = flags.title;
  return {
    id,
    title,
    body: nonEmptyString(flags.body, title),
    acceptance: nonEmptyString(flags.acceptance, "(acceptance TBD)"),
    status: optionalString(flags.status),
    initiative: optionalString(flags.initiative),
    domain: optionalString(flags.domain),
    tags: csv(flags.tags),
    refs: refs(flags.refs),
    definition: optionalString(flags.definition),
    blocked_by: typeof flags["blocked-by"] === "string" ? flags["blocked-by"] : "",
    derived_from: typeof flags["derived-from"] === "string" ? flags["derived-from"] : "",
    backlog: parseBacklog(flags.backlog) === true,
    allow_unregistered_initiative: allowUnregistered === true,

    meta: parseMeta(flags.meta),
  };
}

function gateInput(id, flags, allowUnregistered) {
  const title = flags.title;
  const status = optionalString(flags.status);

  const choice = optionalString(flags.choice)
    || (status === "resolved" ? title : undefined);
  const rationale = optionalString(flags.rationale)
    || (choice ? "(rationale TBD)" : undefined);
  return {
    id,
    initiative: optionalString(flags.initiative),
    title,
    body: nonEmptyString(flags.body, title),
    purpose: nonEmptyString(flags.purpose, "decision"),
    resolution_mode: optionalString(flags["resolution-mode"]),
    status,
    domain: optionalString(flags.domain),
    tags: csv(flags.tags),
    refs: refs(flags.refs),
    meta: parseMeta(flags.meta),
    definition: optionalString(flags.definition),
    acceptance: optionalString(flags.acceptance),
    choice,
    rationale,
    blocked_by: csv(flags["blocked-by"]),
    derived_from: csv(flags["derived-from"]),
    supersedes: optionalString(flags.supersedes),
    backlog: parseBacklog(flags.backlog) === true,
    allow_unregistered_initiative: allowUnregistered === true,
  };
}

function knowledgeInput(id, flags, allowUnregistered) {
  const title = flags.title;

  const scope = {
    domains: csv(flags["scope-domains"]),
    initiatives: csv(flags["scope-initiatives"]),
    tags: csv(flags["scope-tags"]),
    node_ids: csv(flags["scope-node-ids"]),
  };
  const scopeHasAny = scope.domains.length > 0
    || scope.initiatives.length > 0
    || scope.tags.length > 0
    || scope.node_ids.length > 0;
  if (!scopeHasAny) {scope.tags = ["(uncategorized)"];}
  return {
    id,
    initiative: optionalString(flags.initiative),
    title,
    body: nonEmptyString(flags.body, title),
    status: optionalString(flags.status),
    knowledge_type: optionalString(flags["knowledge-type"]),
    mitigation: optionalString(flags.mitigation),
    scope,
    domain: optionalString(flags.domain),
    tags: csv(flags.tags),
    refs: refs(flags.refs),
    meta: parseMeta(flags.meta),
    supersedes: optionalString(flags.supersedes),
    allow_unregistered_initiative: allowUnregistered === true,
  };
}

function pickOperationAndInput(id, nodeType, flags, allowUnregistered) {
  if (nodeType.kind === "resolvable" && nodeType.subkind === "task") {
    return { operation: "task.create", input: taskInput(id, flags, allowUnregistered) };
  }
  if (nodeType.kind === "resolvable" && nodeType.subkind === "gate") {
    return { operation: "gate.create", input: gateInput(id, flags, allowUnregistered) };
  }
  return { operation: "knowledge.create", input: knowledgeInput(id, flags, allowUnregistered) };
}

function validateRequiredNodeFields(id, flags) {
  if (!id) {throwV2("MISSING_FIELD", "add-node: node id required", { field: "id" });}
  if (!flags.kind) {throwV2("MISSING_FIELD", "add-node: --kind required", { field: "kind" });}
  if (!flags.title) {throwV2("MISSING_FIELD", "add-node: --title required", { field: "title" });}
}

function validateNodeType(flags) {
  const kind = String(flags.kind);
  const subkind = flags.subkind ? String(flags.subkind) : undefined;
  if (kind === "resolvable" && (!subkind || !["task", "gate"].includes(subkind))) {
    throwV2("MISSING_FIELD", "add-node: resolvable nodes require --subkind task|gate", { field: "subkind" });
  }
  if (kind !== "resolvable" && kind !== "knowledge") {
    throw new Error(`add-node: --kind must be 'resolvable' or 'knowledge' (got '${kind}')`);
  }
  return { kind, subkind };
}

function validateSupersedes(id, subkind, flags) {
  if (flags.supersedes === undefined || subkind !== "task") {return;}
  throwV2(
    "INVALID_EDGE_KIND",
    "add-node: --supersedes is only valid for gates and knowledge",
    { from: id, to: String(flags.supersedes).trim(), type: "SUPERSEDES", fromKind: "task" },
  );
}

function validateNodeRequest(id, flags) {
  validateRequiredNodeFields(id, flags);
  const nodeType = validateNodeType(flags);
  validateSupersedes(id, nodeType.subkind, flags);
  return nodeType;
}

function nodeFromOperation(result) {
  if (Array.isArray(result.diff.created) && result.diff.created.length > 0) {
    return result.diff.created[0].node;
  }
  if (result.result && result.result.node) {return result.result.node;}
  if (result.result && typeof result.result.id === "string") {return result.result;}
  return null;
}

function completeRemoteKnowledgeInput(remoteInput) {
  delete remoteInput.derived_from;
  if (remoteInput.refs === undefined) {remoteInput.refs = [];}
  const scope = remoteInput.scope;
  if (scope && !scope.domains.length && !scope.initiatives.length && !scope.tags.length && !scope.node_ids.length) {
    scope.tags = ["(uncategorized)"];
  }
}

function completeRemoteResolvableInput(remoteInput, subkind) {
  if (remoteInput.tags === undefined) {remoteInput.tags = [];}
  if (remoteInput.refs === undefined) {remoteInput.refs = [];}
  if (remoteInput.blocked_by === undefined) {remoteInput.blocked_by = [];}
  if (remoteInput.derived_from === undefined) {remoteInput.derived_from = [];}
  if (subkind === "gate" && remoteInput.resolution_mode === undefined) {delete remoteInput.resolution_mode;}
}

function completeRemoteInput(remoteInput, kind, subkind) {
  if (kind === "knowledge") {completeRemoteKnowledgeInput(remoteInput);}
  if (remoteInput.meta === undefined) {delete remoteInput.meta;}
  if (kind === "resolvable") {completeRemoteResolvableInput(remoteInput, subkind);}
  return remoteInput;
}

function validateRemoteNodeRequest(kind, subkind, flags, allowUnregistered) {
  if (allowUnregistered) {throwV2("REMOTE_UNSUPPORTED_OPERATION", "add-node: internal initiative bypass is not supported remotely");}
  if (kind === "resolvable" && subkind === "gate" && flags["resolution-mode"] !== undefined) {
    throwV2("REMOTE_UNSUPPORTED_OPERATION", "add-node: remote gate creation does not support --resolution-mode", { command: "add-node", field: "resolution-mode" });
  }
}

async function createRemoteNode({ backendClient, agent, operation, input, kind, subkind, flags, id, allowUnregistered }) {
  validateRemoteNodeRequest(kind, subkind, flags, allowUnregistered);
  const remoteInput = { ...input };
  delete remoteInput.allow_unregistered_initiative;
  completeRemoteInput(remoteInput, kind, subkind);
  const mutation = await executeRemoteDomain({ backendClient, actor: agent, operation, input: remoteInput, command: "add-node" });
  return { node: nodeFromMutation(mutation, id, "created") || mutation.result?.node || null };
}

async function createLocalNode({ projectDir, agent, operation, input, backendClient, source, pluginId, createCommand }) {
  const client = backendClient || createBackendClient({ projectDir, source });
  const routedClient = await bridgeClientForCreate(client, {
    projectDir,
    source,
    pluginId,
    command: createCommand,
    input,
  });
  const result = await createOperationBridge({ backendClient: routedClient }).executeOperation({
    projectDir,
    actor: agent,
    operation,
    input,
  });
  return { node: nodeFromOperation(result) };
}

export default async function addNode({ statePath, projectDir: suppliedProjectDir, flags = {}, positional = [], pluginId, backendClient, source, createCommand = "add-node" }) {
  const [id] = positional;
  const nodeType = validateNodeRequest(id, flags);
  const projectDir = suppliedProjectDir || statePath;
  const agent = resolveAgent(flags, "add-node");
  const allowUnregistered = flags["allow-unregistered-initiative"] === true
    || flags["allow-unregistered-initiative"] === "true";
  const { operation, input } = pickOperationAndInput(id, nodeType, flags, allowUnregistered);
  if (backendClient?.type === "remote") {
    return createRemoteNode({ backendClient, agent, operation, input, kind: nodeType.kind, subkind: nodeType.subkind, flags, id, allowUnregistered });
  }
  return createLocalNode({ projectDir, agent, operation, input, backendClient, source, pluginId, createCommand });
}
