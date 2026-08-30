// src/providers/gate/create.mjs — gate.create provider (ADR-011 §§1-5,
// ADR-012 §3, plan §B4-gate-core).
//
// Pure domain semantics for creating a gate, including the multi-node
// supersede path that rewrites the superseded gate's incoming BLOCKS edges.
//
// Contract (ADR-011 §1):
//   prepare({ snapshot, input, request }) -> plan   // read-only
//   apply({ tx, plan })                   -> { result, effects }
//
// The provider owns domain validation only. It never touches the
// filesystem, the lock, the persisted state, the log, policy, commands,
// the registry, adapters, the CLI or the UI, and it NEVER writes or
// increments `revision` (the kernel assigns revisions once per apply).
//
// prepare declares, for the kernel:
//   - target        : { id, kind, subkind } of the node being created
//   - policyAction  : { action: "gate.create" } (fresh-snapshot authorize)
//   - logAction     : core log action preserved from the v2 surface
//                     ("add-node" for a plain create, "supersede" when the
//                     new gate replaces an existing one)
//   - affected      : ids of EXISTING nodes this operation modifies
//   - if_revisions  : kernel precondition shape for `affected`
//
// Supersede semantics (parity with the v2 add-node path):
//   - the superseded gate moves to status "superseded";
//   - a SUPERSEDES edge new -> old is added;
//   - every incoming BLOCKS edge of the old gate (blocker -> old) is
//     rewritten to point at the new gate (blocker -> new), atomically;
//   - outgoing BLOCKS edges (old -> dependent) are left untouched: the v2
//     derivation resolves them through the SUPERSEDES chain;
//   - a rewrite whose destination edge already exists collapses into the
//     existing edge instead of producing a duplicate.

import { throwV2 } from "../../contracts/errors.mjs";
import { blocksEdge, validateEdge } from "../../kernel/edges.mjs";

const COMMAND = "gate.create";
const ID_RE = /^[A-Za-z0-9_.-]+$/;

// Persisted gate statuses accepted at creation. `open` is the default; the
// remaining values exist so trusted internals (imports, migrations) can seed
// an already-decided or retired gate without a second mutation.
export const GATE_STATUSES = Object.freeze(["open", "resolved", "superseded", "canceled", "archived"]);

export const GATE_CREATE_POLICY_ACTION = "gate.create";
export const GATE_CREATE_LOG_ACTION = "add-node";
export const GATE_SUPERSEDE_LOG_ACTION = "supersede";

function edgeKey(edge) {
  return `${edge.from}|${edge.to}|${edge.type}`;
}

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireInput(input) {
  if (!asPlainObject(input)) {
    throwV2("MISSING_FIELD", `${COMMAND}: input must be an object`, { field: "input" });
  }
  return input;
}

function requiredString(input, field) {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throwV2("MISSING_FIELD", `${COMMAND}: '${field}' is required`, { field });
  }
  return value;
}

function optionalString(input, field) {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throwV2("MISSING_FIELD", `${COMMAND}: '${field}' must be a string`, { field });
  }
  return value.trim() ? value : undefined;
}

// Typed list input: an array of non-empty strings. The adapter is
// responsible for turning CLI CSV flags into this shape.
function stringList(input, field) {
  const value = input[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throwV2("MISSING_FIELD", `${COMMAND}: '${field}' must be an array of strings`, { field });
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throwV2("MISSING_FIELD", `${COMMAND}: '${field}[${index}]' must be a non-empty string`, {
        field,
        index,
      });
    }
    return entry.trim();
  });
}

function snapshotNodes(snapshot) {
  return asPlainObject(snapshot) && asPlainObject(snapshot.nodes) ? snapshot.nodes : {};
}

function snapshotEdges(snapshot) {
  return asPlainObject(snapshot) && Array.isArray(snapshot.edges) ? snapshot.edges : [];
}

function validateInitiative(snapshot, input) {
  const allowUnregistered = input.allow_unregistered_initiative === true;
  const initiative = optionalString(input, "initiative");
  if (!initiative) {
    if (allowUnregistered) return undefined;
    throwV2("MISSING_FIELD", `${COMMAND}: 'initiative' is required`, { field: "initiative" });
  }
  const initiatives = asPlainObject(snapshot) && asPlainObject(snapshot.initiatives) ? snapshot.initiatives : {};
  const registered = Object.prototype.hasOwnProperty.call(initiatives, initiative);
  if (!registered && !allowUnregistered) {
    throwV2("INITIATIVE_NOT_FOUND", `${COMMAND}: initiative '${initiative}' is not registered`, {
      initiative,
      existing: Object.keys(initiatives).sort(),
    });
  }
  return initiative;
}

function validateStatus(input) {
  const status = optionalString(input, "status");
  if (status === undefined) return "open";
  if (!GATE_STATUSES.includes(status)) {
    throwV2("INVALID_STATUS", `${COMMAND}: status '${status}' is not valid for a gate`, {
      status,
      allowed: [...GATE_STATUSES],
    });
  }
  return status;
}

// choice/rationale are the gate's decision payload. They are only
// applicable when the gate resolves by choice, they travel together, and a
// gate seeded as `resolved` must carry both.
function validateResolution(input, { resolutionMode, status }) {
  const choice = optionalString(input, "choice");
  const rationale = optionalString(input, "rationale");
  if ((choice || rationale) && resolutionMode !== "choice") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${COMMAND}: choice/rationale are only applicable to gates with resolution_mode 'choice' (got '${resolutionMode}')`,
      { field: choice ? "choice" : "rationale", resolution_mode: resolutionMode },
    );
  }
  if (choice && !rationale) {
    throwV2("MISSING_FIELD", `${COMMAND}: 'rationale' is required when 'choice' is provided`, { field: "rationale" });
  }
  if (rationale && !choice) {
    throwV2("MISSING_FIELD", `${COMMAND}: 'choice' is required when 'rationale' is provided`, { field: "choice" });
  }
  if (status === "resolved" && !choice) {
    throwV2("MISSING_FIELD", `${COMMAND}: a gate created as 'resolved' requires 'choice' and 'rationale'`, {
      field: "choice",
      status,
    });
  }
  if (!choice) return undefined;
  return { choice, rationale };
}

function buildNode(input, { id, initiative, status }) {
  const refs = stringList(input, "refs").map((target) => ({ type: "external", target }));
  const meta = input.meta === undefined || input.meta === null ? undefined : input.meta;
  if (meta !== undefined && !asPlainObject(meta)) {
    throwV2("MISSING_FIELD", `${COMMAND}: 'meta' must be an object`, { field: "meta" });
  }
  const resolutionMode = optionalString(input, "resolution_mode") || "choice";
  const node = {
    id,
    kind: "resolvable",
    title: requiredString(input, "title"),
    body: requiredString(input, "body"),
    refs,
    meta,
    initiative,
    domain: optionalString(input, "domain"),
    tags: stringList(input, "tags"),
    status,
    subkind: "gate",
    resolution_mode: resolutionMode,
    purpose: requiredString(input, "purpose"),
    definition: optionalString(input, "definition"),
    acceptance: optionalString(input, "acceptance"),
  };
  if (input.backlog === true) node.backlog = true;
  const resolution = validateResolution(input, { resolutionMode, status });
  if (resolution) node.resolution = resolution;
  return node;
}

function validateSupersedes(snapshot, input, { id, workingState }) {
  const raw = input.supersedes;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throwV2("MISSING_FIELD", `${COMMAND}: 'supersedes' must be a non-empty node id`, { field: "supersedes" });
  }
  const target = raw.trim();
  const edge = { from: id, to: target, type: "SUPERSEDES" };
  if (target === id) {
    throwV2("SELF_EDGE", `${COMMAND}: edge ${id} -> ${target} is a self-edge`, edge);
  }
  // Structural validation first (missing target -> INVALID_EDGE_TARGET,
  // cross-kind -> INVALID_EDGE_KIND), then the gate-specific subkind rule.
  validateEdge(workingState, edge, COMMAND);
  const targetNode = snapshotNodes(snapshot)[target];
  if (targetNode.subkind !== "gate") {
    throwV2(
      "INVALID_EDGE_KIND",
      `${COMMAND}: SUPERSEDES requires gate -> gate (got gate -> ${targetNode.subkind || targetNode.kind})`,
      { from: id, to: target, type: "SUPERSEDES", fromKind: "gate", toKind: targetNode.subkind || targetNode.kind },
    );
  }
  return target;
}

// if_revisions is the agent-facing precondition map `{ id: revision }`.
// Every existing node this operation modifies must be covered; declaring a
// revision for a node the operation does not touch is a contract error.
//
// Auto-derive behaviour (plan §B4-gate-core supersede CAS):
//   When supersedes targets an existing gate, the operation must run
//   under a CAS so a concurrent writer cannot sneak in between the
//   snapshot read and the status flip. The agent rarely knows the
//   current revision of the superseded node — historically the CLI
//   forced the caller to pass `if_revisions` explicitly. That was a
//   leak: the only safe value for a single-writer flow is the
//   snapshot's current revision, so we derive it here. Callers that
//   pass an explicit if_revisions still get the strict CAS check.
function validatePreconditions(snapshot, input, affected) {
  const raw = input.if_revisions;
  const nodes = snapshotNodes(snapshot);
  if (raw !== undefined && raw !== null && !asPlainObject(raw)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND}: 'if_revisions' must be an object`, { field: "if_revisions" });
  }
  const hasExplicit = raw !== undefined && raw !== null;
  if (hasExplicit) {
    for (const [nodeId, expected] of Object.entries(raw)) {
      if (!affected.includes(nodeId)) {
        throwV2(
          "INVALID_EXECUTION_CONTRACT",
          `${COMMAND}: if_revisions declares '${nodeId}' but the operation does not modify it`,
          { field: "if_revisions", id: nodeId, affected: [...affected] },
        );
      }
      if (!Number.isInteger(expected)) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${COMMAND}: if_revisions['${nodeId}'] must be an integer`, {
          field: "if_revisions",
          id: nodeId,
          value: expected,
        });
      }
    }
    for (const nodeId of affected) {
      if (!Object.prototype.hasOwnProperty.call(raw, nodeId)) {
        throwV2(
          "MISSING_FIELD",
          `${COMMAND}: if_revisions['${nodeId}'] is required because the operation modifies that node`,
          { field: "if_revisions", id: nodeId },
        );
      }
      const current = nodes[nodeId] && Number.isInteger(nodes[nodeId].revision) ? nodes[nodeId].revision : null;
      if (current !== raw[nodeId]) {
        throwV2("REVISION_CONFLICT", `${COMMAND}: node ${nodeId} changed since revision ${raw[nodeId]}`, {
          id: nodeId,
          expected: raw[nodeId],
          current,
        });
      }
    }
    if (affected.length === 0) return { kind: "none" };
    return { kind: "multi", values: { ...raw } };
  }
  if (affected.length === 0) return { kind: "none" };
  // Auto-derive: take the current revision of every affected node from
  // the snapshot. The kernel still enforces CAS, so a concurrent
  // writer that bumps the revision between snapshot and apply will
  // be detected as REVISION_CONFLICT. Callers that need to fail fast
  // against a known revision can still pass if_revisions explicitly.
  const derived = {};
  for (const nodeId of affected) {
    const current = nodes[nodeId] && Number.isInteger(nodes[nodeId].revision) ? nodes[nodeId].revision : null;
    if (current === null) {
      throwV2(
        "REVISION_CONFLICT",
        `${COMMAND}: cannot derive if_revisions for '${nodeId}' (missing or non-integer revision in snapshot)`,
        { id: nodeId, current },
      );
    }
    derived[nodeId] = current;
  }
  return { kind: "multi", values: derived };
}

function planEdges(snapshot, input, { id, workingState, supersedes }) {
  const known = new Set(snapshotEdges(snapshot).map((edge) => edgeKey(edge)));
  const edges = [];
  const push = (edge) => {
    const key = edgeKey(edge);
    if (known.has(key)) {
      throwV2("DUPLICATE_EDGE", `${COMMAND}: edge ${edge.type} ${edge.from} -> ${edge.to} already exists`, edge);
    }
    validateEdge(workingState, edge, COMMAND);
    known.add(key);
    edges.push(edge);
  };
  if (supersedes) push({ from: id, to: supersedes, type: "SUPERSEDES" });
  for (const blocker of stringList(input, "blocked_by")) push(blocksEdge(blocker, id));
  for (const source of stringList(input, "derived_from")) push({ from: id, to: source, type: "DERIVED_FROM" });
  return { edges, known };
}

// Incoming BLOCKS edges of the superseded gate move to the new gate. A
// rewrite whose destination already exists (snapshot edge or planned edge)
// collapses: the stale edge is removed and no duplicate is added.
function planRewrites(snapshot, { id, supersedes, known }) {
  const rewrites = [];
  if (!supersedes) return rewrites;
  for (const edge of snapshotEdges(snapshot)) {
    if (edge.type !== "BLOCKS" || edge.to !== supersedes) continue;
    const remove = { from: edge.from, to: edge.to, type: "BLOCKS" };
    const add = { from: edge.from, to: id, type: "BLOCKS" };
    const collapsed = edge.from === id || known.has(edgeKey(add));
    if (!collapsed) known.add(edgeKey(add));
    rewrites.push({ remove, add, collapsed });
  }
  return rewrites;
}

/**
 * prepare — read-only. Validates the gate domain against the snapshot and
 * returns the immutable plan the kernel will authorize and apply.
 */
export async function prepare({ snapshot, input }) {
  const payload = requireInput(input);
  const rawId = payload.id;
  if (typeof rawId !== "string" || !rawId.trim()) {
    throwV2("MISSING_FIELD", `${COMMAND}: 'id' is required`, { field: "id" });
  }
  const id = rawId.trim();
  if (!ID_RE.test(id)) {
    throwV2("INVALID_ID", `${COMMAND}: id '${id}' is invalid (must match ${ID_RE})`, {
      id,
      pattern: ID_RE.source,
    });
  }
  const nodes = snapshotNodes(snapshot);
  if (Object.prototype.hasOwnProperty.call(nodes, id)) {
    throwV2("ID_CONFLICT", `${COMMAND}: ${id} already exists`, { id });
  }

  const initiative = validateInitiative(snapshot, payload);
  const status = validateStatus(payload);
  const node = buildNode(payload, { id, initiative, status });

  // Structural edge validation needs a state where the new node exists.
  const workingState = { ...snapshot, nodes: { ...nodes, [id]: node } };
  const supersedes = validateSupersedes(snapshot, payload, { id, workingState });
  const { edges, known } = planEdges(snapshot, payload, { id, workingState, supersedes });
  const rewrites = planRewrites(snapshot, { id, supersedes, known });

  const affected = supersedes ? [supersedes] : [];
  const preconditions = validatePreconditions(snapshot, payload, affected);

  return {
    target: { id, kind: "resolvable", subkind: "gate" },
    policyAction: { action: GATE_CREATE_POLICY_ACTION },
    logAction: supersedes ? GATE_SUPERSEDE_LOG_ACTION : GATE_CREATE_LOG_ACTION,
    logNote: supersedes ? `${id} supersedes ${supersedes}` : id,
    node,
    edges,
    rewrites,
    supersedes,
    affected,
    if_revisions: preconditions,
  };
}

/**
 * apply — mutates the draft transaction only and returns
 * `{ result, effects }`. Never assigns or increments `revision`.
 */
export async function apply({ tx, plan }) {
  tx.createNode(plan.node);
  if (plan.supersedes) {
    tx.updateNode(plan.supersedes, { status: "superseded" });
  }
  // Remove every stale blocker edge before adding the rewritten ones so a
  // rewrite can never collide with the edge it replaces.
  for (const rewrite of plan.rewrites) tx.removeEdge(rewrite.remove);
  for (const rewrite of plan.rewrites) {
    if (!rewrite.collapsed) tx.addEdge(rewrite.add);
  }
  for (const edge of plan.edges) tx.addEdge(edge);

  const rewritten = plan.rewrites
    .filter((rewrite) => !rewrite.collapsed)
    .map((rewrite) => ({ blocker: rewrite.remove.from, from: rewrite.remove.to, to: rewrite.add.to }));
  const collapsed = plan.rewrites
    .filter((rewrite) => rewrite.collapsed)
    .map((rewrite) => ({ blocker: rewrite.remove.from, from: rewrite.remove.to, to: rewrite.add.to }));

  return {
    result: {
      node: tx.getNode(plan.target.id),
      superseded: plan.supersedes ? tx.getNode(plan.supersedes) : null,
      edges: plan.edges.map((edge) => ({ ...edge })),
    },
    effects: {
      superseded: plan.supersedes || null,
      blockers_rewritten: rewritten,
      blockers_collapsed: collapsed,
      affected: [...plan.affected],
    },
  };
}

export const gateCreateProvider = Object.freeze({ prepare, apply });
