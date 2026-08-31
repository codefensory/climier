// src/providers/task/create.mjs — pure provider for `task.create`.
//
// ADR-011 §§1, 2, 3, 5 + ADR-012 §3:
//   - `prepare` is read-only. It validates the input shape, looks up the
//     initiative, validates every `blocked_by` against the snapshot
//     (existence, kind, no self-edge, no duplicate edges already in the
//     snapshot), and returns an immutable plan describing what the
//     operation will commit.
//   - `apply` only mutates the in-memory tx draft: one `tx.createNode`
//     for the new task and one `tx.addEdge` per blocker (canonical
//     BLOCKS direction). It must not touch `revision` (the kernel
//     assigns revision per ADR-011 §2).
//   - This module imports nothing from filesystem, lock, state, log,
//     policy, commands, registry, adapters, CLI or UI. Only the v2
//     error helpers and the kernel graph primitive (for the BLOCKS
//     canonical edge shape) are used.

import { throwV2 } from "../../contracts/errors.mjs";
import { blocksEdge } from "../../kernel/edges.mjs";

const OP = "task.create";
const LOG_ACTION = "add-task";

// ALLOWED_KINDS — the only (kind, subkind) pair this provider accepts.
// Lifecycle operations use the same provider shape and classify under
// their respective operation ids (`task.take`, `task.resolve`, etc.).
const TASK_KIND = "resolvable";
const TASK_SUBKIND = "task";

// REQUIRED_STRING_FIELDS — input fields that must be present, non-empty
// strings. The provider mirrors the `add-task` public contract from the
// CLI adapter and the v2 command surface. Keeping the field surface
// stable lets callers adapt without further provider changes.
const REQUIRED_STRING_FIELDS = ["id", "initiative", "title", "body", "acceptance"];

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSnapshotNodes(snapshot) {
  return snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

function readSnapshotEdges(snapshot) {
  return Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
}

function readSnapshotInitiatives(snapshot) {
  return snapshot && snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
}

// normalizeBlockers — coerces the input into a deduped, sorted array of
// blocker ids. Accepts either a CSV string (CLI flag shape) or an
// array. Returns `null` when the input is missing/empty so the caller can
// distinguish "no blockers" from "invalid input".
function normalizeBlockers(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${OP}: blocked_by must be a CSV string or array of ids`,
    { field: "blocked_by" },
  );
}

function dedupeAndSort(ids) {
  return Array.from(new Set(ids)).sort();
}

function validateInputShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input must be an object`,
      { field: "input" },
    );
  }
  // Internal capability (ADR-008 §"Capacidad interna"): with
  // allow_unregistered_initiative=true the initiative check is
  // optional. The CLI surface never passes the flag, so this branch
  // is unreachable from public callers.
  const allowUnregistered = input.allow_unregistered_initiative === true;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (allowUnregistered && field === "initiative") continue;
    const value = asNonEmptyString(input[field]);
    if (!value) {
      throwV2("MISSING_FIELD", `${OP}: --${field.replace(/_/g, "-")} required`, { field });
    }
  }
  // The provider rejects anything other than task (kind/subkind) so
  // the same code path is shared with `task.update` and so the
  // operation dispatch cannot accidentally bind a `gate.create` or
  // another operation to this provider. ADR-012 §2 lists distinct operation
  // ids per kind/subkind — `task.create` only accepts `task`.
  if (input.kind !== undefined && input.kind !== TASK_KIND) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: kind must be '${TASK_KIND}' for task.create`,
      { field: "kind", value: input.kind, expected: TASK_KIND },
    );
  }
  if (input.subkind !== undefined && input.subkind !== TASK_SUBKIND) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: subkind must be '${TASK_SUBKIND}' for task.create`,
      { field: "subkind", value: input.subkind, expected: TASK_SUBKIND },
    );
  }
  // The provider never lets the caller seed `revision`; that field is
  // owned by the kernel (ADR-011 §2).
  if ("revision" in input) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: input must not carry 'revision' (the kernel assigns revision once per apply)`,
      { field: "revision" },
    );
  }
}

function validateInitiative(initiativeId, snapshot, input) {
  // Internal capability (ADR-008 §"Capacidad interna"):
  // addNodeInternal({ allowUnregisteredInitiative: true }) sets
  // allow_unregistered_initiative=true on the input. The CLI surface
  // does not expose the flag, so this branch is unreachable from
  // public callers.
  const allowUnregistered = input && input.allow_unregistered_initiative === true;
  const initiatives = readSnapshotInitiatives(snapshot);
  if (!Object.prototype.hasOwnProperty.call(initiatives, initiativeId)) {
    if (allowUnregistered) return;
    throwV2(
      "INITIATIVE_NOT_FOUND",
      `${OP}: initiative '${initiativeId}' is not registered`,
      {
        initiative: initiativeId,
        existing: Object.keys(initiatives).sort(),
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

function validateBlockersAgainstSnapshot(blockers, selfId, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);

  for (const blockerId of blockers) {
    if (blockerId === selfId) {
      throwV2(
        "SELF_EDGE",
        `${OP}: edge ${blockerId} -> ${selfId} is a self-edge`,
        { from: blockerId, to: selfId, type: "BLOCKS" },
      );
    }
    const blocker = nodes[blockerId];
    if (!blocker) {
      throwV2(
        "INVALID_EDGE_TARGET",
        `${OP}: edge BLOCKS ${blockerId} -> ${selfId} references missing node '${blockerId}'`,
        { from: blockerId, to: selfId, type: "BLOCKS", missing: blockerId },
      );
    }
    // BLOCKS on a task may target a task blocked by either a resolvable
    // task or a resolvable gate. Knowledge nodes are not BLOCKS endpoints
    // (their `kind` is `knowledge`, not `resolvable`).
    if (blocker.kind !== "resolvable" || !["task", "gate"].includes(blocker.subkind)) {
      throwV2(
        "INVALID_EDGE_KIND",
        `${OP}: BLOCKS requires both ends to be resolvable (got ${blocker.kind}/${blocker.subkind || "?"} -> ${TASK_KIND}/${TASK_SUBKIND})`,
        {
          from: blockerId,
          to: selfId,
          type: "BLOCKS",
          fromKind: blocker.kind,
          toKind: TASK_KIND,
          fromSubkind: blocker.subkind || null,
          toSubkind: TASK_SUBKIND,
        },
      );
    }
  }

  // Duplicate detection runs against the existing snapshot edges. The
  // duplicate input itself is deduped above; we still validate that
  // none of the new BLOCKS edges collide with the snapshot's existing
  // graph so apply cannot push a duplicate into the draft.
  for (const blockerId of blockers) {
    const edge = blocksEdge(blockerId, selfId);
    const collision = edges.find(
      (e) => e.from === edge.from && e.to === edge.to && e.type === edge.type,
    );
    if (collision) {
      throwV2(
        "DUPLICATE_EDGE",
        `${OP}: edge BLOCKS ${edge.from} -> ${edge.to} already exists`,
        {
          from: edge.from,
          to: edge.to,
          type: edge.type,
          existing: { ...collision },
        },
      );
    }
  }
}

// validateDerivedFromAgainstSnapshot — DERIVED_FROM is the only non-
// BLOCKS edge that `task.create` accepts today (mirrors add-node
// behaviour). Both ends must be resolvable (task or gate) so
// the link stays inside the decision-graph; knowledge targets are
// rejected with INVALID_EDGE_KIND.
// Self-edges and duplicates against the existing snapshot are
// rejected for parity with BLOCKS.
function validateDerivedFromAgainstSnapshot(sources, selfId, snapshot) {
  const nodes = readSnapshotNodes(snapshot);
  const edges = readSnapshotEdges(snapshot);
  for (const sourceId of sources) {
    if (sourceId === selfId) {
      throwV2(
        "SELF_EDGE",
        `${OP}: edge ${selfId} -> ${sourceId} is a self-edge`,
        { from: selfId, to: sourceId, type: "DERIVED_FROM" },
      );
    }
    const source = nodes[sourceId];
    if (!source) {
      throwV2(
        "INVALID_EDGE_TARGET",
        `${OP}: edge DERIVED_FROM ${selfId} -> ${sourceId} references missing node '${sourceId}'`,
        { from: selfId, to: sourceId, type: "DERIVED_FROM", missing: sourceId },
      );
    }
    if (source.kind !== "resolvable" || !["task", "gate"].includes(source.subkind)) {
      throwV2(
        "INVALID_EDGE_KIND",
        `${OP}: DERIVED_FROM requires both ends to be resolvable (got ${TASK_KIND}/${TASK_SUBKIND} -> ${source.kind}/${source.subkind || "?"})`,
        {
          from: selfId,
          to: sourceId,
          type: "DERIVED_FROM",
          fromKind: TASK_KIND,
          toKind: source.kind,
          fromSubkind: TASK_SUBKIND,
          toSubkind: source.subkind || null,
        },
      );
    }
    const collision = edges.find(
      (e) => e.from === selfId && e.to === sourceId && e.type === "DERIVED_FROM",
    );
    if (collision) {
      throwV2(
        "DUPLICATE_EDGE",
        `${OP}: edge DERIVED_FROM ${selfId} -> ${sourceId} already exists`,
        {
          from: selfId,
          to: sourceId,
          type: "DERIVED_FROM",
          existing: { ...collision },
        },
      );
    }
  }
}

// resolveDerivedFrom — coerces the input into a deduped, sorted array
// of source ids. Mirrors `normalizeBlockers`.
function resolveDerivedFrom(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${OP}: derived_from must be a CSV string or array of ids`,
    { field: "derived_from" },
  );
}

function resolveOptionalString(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${OP}: ${field} must be a string when present`,
      { field },
    );
  }
  return value;
}

// resolveOptionalTags — CSV string or string array; used for the
// optional task `tags` / `domain` decoration that mirrors `add-task`'s
// public surface.
function resolveOptionalCsv(raw, field) {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "string") return raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${OP}: ${field} must be a CSV string or array`,
    { field },
  );
}

function buildNodeSeed(input, id) {
  // The seed omits `revision` by construction (validated above). The
  // kernel assigns it once per apply.
  // `status` is optional: the public CLI default is "open"; trusted
  // internals (imports, migrations) may seed a task already in
  // in_progress / done / canceled / etc. so the lifecycle
  // operators don't have to follow up with a second mutation.
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
  if (input.initiative !== undefined && input.initiative !== null && input.initiative !== "") {
    seed.initiative = input.initiative;
  }
  if (input.backlog === true) seed.backlog = true;
  // meta is preserved as-is when provided (validateExecution has
  // already normalized the `execution` sub-shape). Undefined inputs
  // leave the seed without a `meta` key — matches the add-node
  // contract (only present when --meta was passed).
  if (input.meta !== undefined && input.meta !== null) {
    if (!asPlainObject(input.meta)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: 'meta' must be an object`, { field: "meta" });
    }
    seed.meta = { ...input.meta };
  }
  const domain = resolveOptionalString(input.domain, "domain");
  if (domain) seed.domain = domain;
  const definition = resolveOptionalString(input.definition, "definition");
  if (definition) seed.definition = definition;
  const refs = resolveOptionalCsv(input.refs, "refs");
  if (refs.length > 0) {
    seed.refs = refs.map((target) => ({ type: "external", target }));
  }
  const tags = resolveOptionalCsv(input.tags, "tags");
  if (tags.length > 0) seed.tags = tags;
  return seed;
}

function asPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ===================================================================
// Provider
// ===================================================================

/**
 * Pure `prepare` for task.create.
 *
 * Contract:
 *   - read-only: never mutates the snapshot, never reaches outside the
 *     provided arguments;
 *   - validates id, kind/subkind, all required string fields, the
 *     initiative registration, no id collision, every blocker against
 *     the snapshot (existence / kind / self / duplicate);
 *   - returns a frozen plan: { target, policyAction, logAction,
 *     nodeSeed, blocked_by }; apply uses only the plan and the tx.
 *
 * @param {{ snapshot: object, input: object, request: object }} args
 * @returns {object} frozen plan
 */
async function prepare({ snapshot, input, request }) {
  // `request` is accepted for symmetry with `apply` (and provider-level
  // context) but is not consumed today: validation is driven entirely by
  // the snapshot and the input. Referenced so the linter does not flag the
  // parameter and so callers can read request metadata without re-plumbing
  // the call site.
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

/**
 * Pure `apply` for task.create.
 *
 * Contract:
 *   - mutates the tx draft only (tx.createNode + one tx.addEdge per
 *     blocker);
 *   - never writes or increments `revision`;
 *   - returns `{ result, effects }`: `result.id` is the new task id,
 *     `result.added_edges` is the canonical BLOCKS list (deterministic
 *     order — sorted in prepare).
 *
 * @param {{ tx: object, plan: object, input: object, request: object, snapshot: object }} args
 * @returns {Promise<{ result: object, effects: null }>}
 */
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
  // createNode carries the seed but explicitly NOT `revision`. The
  // kernel diff compares snapshot vs. draft ignoring revision, so
  // the seed must be revision-free. The transaction layer already
  // strips `revision` defensively; we re-assert here to document the
  // intent at the provider boundary.
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
