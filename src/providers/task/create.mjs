

import { throwV2 } from "../../contracts/errors.mjs";
import { blocksEdge } from "../../kernel/edges.mjs";

const OP = "task.create";
const LOG_ACTION = "add-task";

const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";

const REQUIRED_STRING_FIELDS = ["id", "initiative", "title", "body", "acceptance"];

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) { return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {}; }
function readSnapshotEdges(snapshot) { return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : []; }
function readSnapshotInitiatives(snapshot) { return snapshot && snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {}; }

function normalizeBlockers(raw) {
  if (raw === undefined || raw === null) { return []; }
  if (typeof raw === "string") { return raw.split(",").map((x) => x.trim()).filter(Boolean); }
  if (Array.isArray(raw)) { return raw.map((x) => String(x).trim()).filter(Boolean); }
  throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: blocked_by must be a CSV string or array of ids`, {
    field: "blocked_by",
  });
}

function dedupeAndSort(ids) {
  return Array.from(new Set(ids)).toSorted();
}

function validateRequiredFields(input, allowUnregistered) {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (allowUnregistered && field === "initiative") {
      continue;
    }
    if (!asNonEmptyString(input[field])) {
      throwV2("MISSING_FIELD", `${OP}: --${field.replace(/_/g, "-")} required`, { field });
    }
  }
}

function validateTaskKinds(input) {
  if (input.kind !== undefined && input.kind !== TASK_KIND) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: kind must be '${TASK_KIND}' for task.create`, {
      field: "kind",
      value: input.kind,
      expected: TASK_KIND,
    });
  }
  if (input.subkind !== undefined && input.subkind !== TASK_SUBKIND) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: subkind must be '${TASK_SUBKIND}' for task.create`, {
      field: "subkind",
      value: input.subkind,
      expected: TASK_SUBKIND,
    });
  }
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  validateRequiredFields(input, input.allow_unregistered_initiative === true);
  validateTaskKinds(input);
  if ("revision" in input) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must not carry 'revision' (the kernel assigns revision once per apply)`, {
      field: "revision",
    });
  }
}

function validateInitiative(initiativeId, snapshot, input) {
  const allowUnregistered = input && input.allow_unregistered_initiative === true;
  const initiatives = readSnapshotInitiatives(snapshot);
  if (!Object.prototype.hasOwnProperty.call(initiatives, initiativeId)) {
    if (allowUnregistered) {
      return;
    }
    throwV2(
      "INITIATIVE_NOT_FOUND",
      `${OP}: initiative '${initiativeId}' is not registered`,
      {
        initiative: initiativeId,
        existing: Object.keys(initiatives).toSorted(),
      },
    );
  }
}

function validateNoIdCollision(id, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  if (Object.prototype.hasOwnProperty.call(nodes, id)) {
    throwV2("ID_CONFLICT", `${OP}: task '${id}' already exists`, { id });
  }
}

function validateBlocker(blockerId, selfId, nodes) {
  if (blockerId === selfId) {
    throwV2("SELF_EDGE", `${OP}: edge ${blockerId} -> ${selfId} is a self-edge`, {
      from: blockerId,
      to: selfId,
      type: "BLOCKS",
    });
  }
  const blocker = nodes[blockerId];
  if (!blocker) {
    throwV2("INVALID_EDGE_TARGET", `${OP}: edge BLOCKS ${blockerId} -> ${selfId} references missing node '${blockerId}'`, {
      from: blockerId,
      to: selfId,
      type: "BLOCKS",
      missing: blockerId,
    });
  }
  if (blocker.kind !== "resolvable" || !["task", "gate"].includes(blocker.subkind)) {
    throwV2("INVALID_EDGE_KIND", `${OP}: BLOCKS requires both ends to be resolvable (got ${blocker.kind}/${blocker.subkind || "?"} -> ${TASK_KIND}/${TASK_SUBKIND})`, {
      from: blockerId,
      to: selfId,
      type: "BLOCKS",
      fromKind: blocker.kind,
      toKind: TASK_KIND,
      fromSubkind: blocker.subkind || null,
      toSubkind: TASK_SUBKIND,
    });
  }
}

function validateNoDuplicateBlocker(blockerId, selfId, edges) {
  const edge = blocksEdge(blockerId, selfId);
  const collision = edges.find((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.type === edge.type);
  if (collision) {
    throwV2("DUPLICATE_EDGE", `${OP}: edge BLOCKS ${edge.from} -> ${edge.to} already exists`, {
      from: edge.from,
      to: edge.to,
      type: edge.type,
      existing: { ...collision },
    });
  }
}

function validateBlockersAgainstSnapshot(blockers, selfId, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  for (const blockerId of blockers) {
    validateBlocker(blockerId, selfId, nodes);
    validateNoDuplicateBlocker(blockerId, selfId, edges);
  }
}

function validateDerivedFromSource(sourceId, selfId, nodes, edges) {
  if (sourceId === selfId) {
    throwV2("SELF_EDGE", `${OP}: edge ${selfId} -> ${sourceId} is a self-edge`, {
      from: selfId,
      to: sourceId,
      type: "DERIVED_FROM",
    });
  }
  const source = nodes[sourceId];
  if (!source) {
    throwV2("INVALID_EDGE_TARGET", `${OP}: edge DERIVED_FROM ${selfId} -> ${sourceId} references missing node '${sourceId}'`, {
      from: selfId,
      to: sourceId,
      type: "DERIVED_FROM",
      missing: sourceId,
    });
  }
  if (source.kind !== "resolvable" || !["task", "gate"].includes(source.subkind)) {
    throwV2("INVALID_EDGE_KIND", `${OP}: DERIVED_FROM requires both ends to be resolvable (got ${TASK_KIND}/${TASK_SUBKIND} -> ${source.kind}/${source.subkind || "?"})`, {
      from: selfId,
      to: sourceId,
      type: "DERIVED_FROM",
      fromKind: TASK_KIND,
      toKind: source.kind,
      fromSubkind: TASK_SUBKIND,
      toSubkind: source.subkind || null,
    });
  }
  const collision = edges.find((edge) => edge.from === selfId && edge.to === sourceId && edge.type === "DERIVED_FROM");
  if (collision) {
    throwV2("DUPLICATE_EDGE", `${OP}: edge DERIVED_FROM ${selfId} -> ${sourceId} already exists`, {
      from: selfId,
      to: sourceId,
      type: "DERIVED_FROM",
      existing: { ...collision },
    });
  }
}

function validateDerivedFromAgainstSnapshot(sources, selfId, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  for (const sourceId of sources) {
    validateDerivedFromSource(sourceId, selfId, nodes, edges);
  }
}

function resolveDerivedFrom(raw) {
  if (raw === undefined || raw === null) { return []; }
  if (typeof raw === "string") { return raw.split(",").map((x) => x.trim()).filter(Boolean); }
  if (Array.isArray(raw)) { return raw.map((x) => String(x).trim()).filter(Boolean); }
  throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: derived_from must be a CSV string or array of ids`, {
    field: "derived_from",
  });
}

function resolveOptionalString(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: ${field} must be a string when present`,
      { field },
    );
  }
  return value;
}

function resolveOptionalCsv(raw, field) {
  if (raw === undefined || raw === null || raw === "") { return []; }
  if (typeof raw === "string") { return raw.split(",").map((x) => x.trim()).filter(Boolean); }
  if (Array.isArray(raw)) { return raw.map((x) => String(x).trim()).filter(Boolean); }
  throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: ${field} must be a CSV string or array`, { field });
}

function addInitiativeField(seed, input) {
  if (input.initiative !== undefined && input.initiative !== null && input.initiative !== "") {
    seed.initiative = input.initiative;
  }
}

function addMetaField(seed, input) {
  if (input.meta === undefined || input.meta === null) {
    return;
  }
  if (!asPlainObject(input.meta)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: 'meta' must be an object`, { field: "meta" });
  }
  seed.meta = { ...input.meta };
}

function addOptionalStringFields(seed, input) {
  for (const field of ["domain", "definition"]) {
    const value = resolveOptionalString(input[field], field);
    if (value) {
      seed[field] = value;
    }
  }
}

function addOptionalFields(seed, input) {
  addInitiativeField(seed, input);
  if (input.backlog === true) {
    seed.backlog = true;
  }
  addMetaField(seed, input);
  addOptionalStringFields(seed, input);
}

function addListFields(seed, input) {
  const refs = resolveOptionalCsv(input.refs, "refs");
  if (refs.length > 0) {
    seed.refs = refs.map((target) => ({ type: "external", target }));
  }
  const tags = resolveOptionalCsv(input.tags, "tags");
  if (tags.length > 0) {
    seed.tags = tags;
  }
}

function buildNodeSeed(input, id) {
  const seed = {
    id,
    kind: TASK_KIND,
    subkind: TASK_SUBKIND,
    title: input.title,
    body: input.body,
    acceptance: input.acceptance,
    status: typeof input.status === "string" && input.status.length > 0 ? input.status : "open",
    resolution_mode: "labor",
  };
  addOptionalFields(seed, input);
  addListFields(seed, input);
  return seed;
}

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


async function prepare({ snapshot, input, request }) {
  void request;
  validateInputShape(input);
  const blockers = dedupeAndSort(normalizeBlockers(input.blocked_by));
  const derivedFrom = dedupeAndSort(resolveDerivedFrom(input.derived_from));
  validateInitiative(input.initiative, snapshot, input);
  validateNoIdCollision(input.id, snapshot);
  validateBlockersAgainstSnapshot(blockers, input.id, snapshot);
  validateDerivedFromAgainstSnapshot(derivedFrom, input.id, snapshot);
  const seed = buildNodeSeed(input, input.id);

  return Object.freeze({
    target: Object.freeze({
      id: input.id,
      kind: TASK_KIND,
      subkind: TASK_SUBKIND,
      blocked_by: Object.freeze(blockers.slice()),
    }),
    policyAction: Object.freeze({ action: "task.create", pluginId: null }),
    logAction: LOG_ACTION,
    nodeSeed: Object.freeze(seed),
    blocked_by: Object.freeze(blockers.slice()),
    derived_from: Object.freeze(derivedFrom.slice()),
  });
}


async function apply({ tx, plan, input, request, snapshot }) {
  void input;
  void request;
  void snapshot;
  if (!tx || typeof tx.createNode !== "function" || typeof tx.addEdge !== "function") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: apply requires a tx with createNode/addEdge accessors`,
      { field: "tx" },
    );
  }
  const { revision: _r, ...seedWithoutRevision } = plan.nodeSeed;
  void _r;
  tx.createNode(seedWithoutRevision);

  const addedEdges = [];
  for (const blockerId of plan.target.blocked_by) {
    const edge = blocksEdge(blockerId, plan.target.id);
    const persisted = tx.addEdge(edge);
    addedEdges.push(persisted);
  }
  for (const sourceId of plan.derived_from || []) {
    const edge = { from: plan.target.id, to: sourceId, type: "DERIVED_FROM" };
    const persisted = tx.addEdge(edge);
    addedEdges.push(persisted);
  }

  return {
    result: Object.freeze({
      id: plan.target.id,
      kind: plan.target.kind,
      subkind: plan.target.subkind,
      status: "open",
      added_edges: Object.freeze(addedEdges.slice()),
    }),
    effects: null,
  };
}

export const taskCreateProvider = Object.freeze({ prepare, apply });
