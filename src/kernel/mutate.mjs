// src/kernel/mutate.mjs — single mutation frontier for the graph kernel.
//
// ADR-011 §1 + Plan §B1b: every mutation routes through `kernel.mutate`.
// Providers contribute semantics (prepare/apply); the kernel owns:
//   - the single lock (withLock(projectDir, fn));
//   - the snapshot read;
//   - the precondition validation (if_revision / if_revisions);
//   - the policy decision against the fresh snapshot + plan;
//   - the in-memory draft via createTransaction;
//   - the diff + revision assignment;
//   - the single atomic state + log write;
//   - the nested-mutation guard.
//
// Constraints honored in this file:
//   - prepare runs exactly once, inside the lock, against the same
//     snapshot that will be mutated (snapshot freshness is mandatory per
//     the canonical flow in ADR-011 §1).
//   - if_revision / if_revisions are validated under the lock AFTER the
//     snapshot read, BEFORE the policy authorize and apply, so no other
//     writer can sneak a revision bump in between.
//   - policyAction.decide runs against the fresh snapshot + plan AFTER
//     the precondition check; deny throws POLICY_DENIED with no mutation.
//   - apply mutates the draft ONLY (tx); the kernel never calls
//     provider.apply with the live state.
//   - state + log persist in a SINGLE writeState call (one atomic write
//     under the same withLock). Two routes to persistence (updateState
//     twice) would be a violation.
//   - Idempotent operations (snapshot ≡ draft) skip both the state
//     write and the log append; result.effects are still returned.
//   - Nested kernel.mutate calls (provider.apply → kernel.mutate)
//     throw INVALID_EXECUTION_CONTRACT; the guard is module-scoped so
//     `importFresh` in tests resets it.
//   - Non-persisted effects from provider.apply are returned in the
//     kernel response; they are NOT stored on the node.
//
// This module deliberately does NOT import providers, the registry,
// the plugin-core-adapter, bin/climier.mjs, or anything in src/ui/.
import { readState, writeState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { prepareLogEntry } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { createTransaction } from "./transaction.mjs";

const EDGE_TYPE_FIELD_RE = /^[A-Z_]+$/;
const NESTED_GUARD_INITIAL = 0;

// Module-level guard for nested kernel.mutate calls. Module-scope is
// intentional: importFresh (used by tests) re-evaluates this module so
// the guard resets per test, and sequential tests never share state.
// Cross-module nested calls would only happen if a provider.apply
// implementation calls mutate() directly, which we forbid.
let nestedDepth = NESTED_GUARD_INITIAL;

function commandLabel(request) {
  return request && typeof request.action === "string" && request.action.length > 0
    ? `kernel.mutate(${request.action})`
    : "kernel.mutate";
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request must be an object", { field: "request" });
  }
  if (typeof request.action !== "string" || request.action.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.action is required", { field: "action" });
  }
  if (typeof request.actor !== "string" || request.actor.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.actor is required", { field: "actor" });
  }
  if (request.input !== undefined && (request.input === null || typeof request.input !== "object" || Array.isArray(request.input))) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.input must be an object when present", { field: "input" });
  }
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider must be an object", { field: "provider" });
  }
  if (typeof provider.prepare !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider.prepare must be a function", { field: "prepare" });
  }
  if (typeof provider.apply !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider.apply must be a function", { field: "apply" });
  }
}

function validatePlan(plan, commandName) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: prepare must return a plan object`, { field: "plan" });
  }
  if (!plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target must be an object`, { field: "target" });
  }
  if (typeof plan.target.id !== "string" || plan.target.id.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target.id must be a non-empty string`, { field: "target.id" });
  }
}

function planPolicyAction(plan, request) {
  if (plan && plan.policyAction && typeof plan.policyAction === "object" && !Array.isArray(plan.policyAction)) {
    return plan.policyAction;
  }
  return null;
}

function asEdge(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  if (typeof e.from !== "string" || typeof e.to !== "string" || typeof e.type !== "string") return null;
  return { from: e.from, to: e.to, type: e.type };
}

function edgeKey(e) {
  return `${e.from}|${e.to}|${e.type}`;
}

function snapshotEdgeMap(edges) {
  const map = new Map();
  for (const e of edges || []) {
    const normalized = asEdge(e);
    if (!normalized) continue;
    map.set(edgeKey(normalized), normalized);
  }
  return map;
}

function draftEdgeMap(edges) {
  return snapshotEdgeMap(edges);
}

function stripRevision(node) {
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "revision") continue;
    out[k] = v;
  }
  return out;
}

// Deep-equality on JSON-shaped nodes; sufficient for kernel diffs because
// v2 node values are JSON-serializable by construction. Keeps the result
// deterministic — same input → same comparison → same id list.
function deepEqualNodes(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    const av = a[k];
    const bv = b[k];
    if (av === bv) continue;
    if (typeof av !== typeof bv) return false;
    if (av && bv && typeof av === "object") {
      try {
        if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
      } catch {
        return false;
      }
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

// checkPrecondition — validates `if_revision` (single) or
// `if_revisions` (multi) under the lock. The request carries the
// agent-facing expectation; the plan may also declare the expected
// revisions for the nodes it touches via plan.if_revisions
// (kernel-owned trust for the plan, complement of the request). The
// request takes precedence when both are present.
function checkPrecondition(precondition, snapshot, commandName) {
  if (precondition === undefined || precondition === null) return null;
  if (typeof precondition !== "object" || Array.isArray(precondition)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision must be an object`, { field: "if_revision" });
  }
  const kind = precondition.kind;
  if (kind === "single") {
    const id = typeof precondition.id === "string" ? precondition.id : null;
    const expected = Number(precondition.value);
    if (!id || !Number.isInteger(expected)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revision{ single } requires id+integer value`, { field: "if_revision" });
    }
    const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
    const current = node && Number.isInteger(node.revision) ? node.revision : null;
    if (!node || current === null || current !== expected) {
      throwV2(
        "REVISION_CONFLICT",
        `${commandName}: node ${id} changed since revision ${expected}`,
        { id, expected, current },
      );
    }
    return { kind: "single", id, value: expected };
  }
  if (kind === "multi") {
    const values = precondition.values && typeof precondition.values === "object" && !Array.isArray(precondition.values)
      ? precondition.values
      : null;
    if (!values) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions{ multi } requires a values object`, { field: "if_revisions" });
    }
    const checked = [];
    for (const [id, raw] of Object.entries(values)) {
      const expected = Number(raw);
      if (!Number.isInteger(expected)) {
        throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: if_revisions[${id}] must be an integer`, { field: "if_revisions" });
      }
      const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
      const current = node && Number.isInteger(node.revision) ? node.revision : null;
      if (!node || current === null || current !== expected) {
        throwV2(
          "REVISION_CONFLICT",
          `${commandName}: node ${id} changed since revision ${expected}`,
          { id, expected, current },
        );
      }
      checked.push(id);
    }
    return { kind: "multi", values, ids: checked };
  }
  if (kind === "none") {
    // Explicit "no precondition" — reserved for trusted internals
    // (migrations, restore). The caller is responsible for documenting
    // why the agent-facing CAS is intentionally absent.
    return { kind: "none" };
  }
  throwV2(
    "INVALID_EXECUTION_CONTRACT",
    `${commandName}: if_revision.kind must be one of single|multi|none`,
    { field: "if_revision.kind", value: kind },
  );
}

// Assign the next revision per node: new → 1; modified → prev + 1;
// unchanged → keep prev (but apply the draft to drop the revision
// field, since draft nodes never carry it). Returns the diff shape used
// by tests for the acceptance (`created`/`updated`) plus the removed
// nodes (snapshot ids not present in the draft view).
function assignRevisionsAndDiff(snapshot, draftView) {
  const snapNodes = (snapshot && snapshot.nodes) || {};
  const next = {};
  const created = [];
  const updated = [];
  for (const [id, draft] of Object.entries(draftView.nodes || {})) {
    const prev = snapNodes[id];
    const draftStrip = stripRevision(draft);
    if (!prev) {
      next[id] = { ...draftStrip, revision: 1 };
      created.push({ id, node: next[id] });
      continue;
    }
    const prevStrip = stripRevision(prev);
    if (deepEqualNodes(prevStrip, draftStrip)) {
      next[id] = { ...draftStrip, revision: Number.isInteger(prev.revision) ? prev.revision : 1 };
    } else {
      next[id] = { ...draftStrip, revision: (Number.isInteger(prev.revision) ? prev.revision : 0) + 1 };
      updated.push({ id, node: next[id] });
    }
  }
  const removed = [];
  for (const id of Object.keys(snapNodes)) {
    if (!Object.prototype.hasOwnProperty.call(draftView.nodes || {}, id)) {
      removed.push(id);
    }
  }
  return { next, removed, created, updated };
}

function computeEdgeDiff(snapshotEdges, draftEdges) {
  const snapMap = snapshotEdgeMap(snapshotEdges);
  const draftMap = draftEdgeMap(draftEdges);
  const added = [];
  const removed = [];
  for (const [k, e] of draftMap) {
    if (!snapMap.has(k)) added.push(e);
  }
  for (const [k, e] of snapMap) {
    if (!draftMap.has(k)) removed.push(e);
  }
  return { added, removed };
}

// Compare two v2 initiative entries by their JSON-serializable fields.
// We only persist primitives (desc: string, created_at?: string), so a
// shallow key-by-key comparison is sufficient and avoids surprises if a
// future plugin extends the shape with non-JSON values.
function initiativesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// computeInitiativeDiff — the snapshot-vs-draft delta on the initiatives
// map. Returns `{ created, updated }` mirroring the node-level diff shape
// (created carries the new initiative; updated carries { previous, name,
// initiative } so callers can see what changed). Note: the kernel does
// NOT delete initiatives in B1b (registration is monotonic, matching the
// historical add-initiative contract). Removing an existing initiative
// has no provider seam yet.
function computeInitiativeDiff(snapshotInitiatives, draftInitiatives) {
  const snap = snapshotInitiatives && typeof snapshotInitiatives === "object" ? snapshotInitiatives : {};
  const draft = draftInitiatives && typeof draftInitiatives === "object" ? draftInitiatives : {};
  const created = [];
  const updated = [];
  for (const [name, draftInit] of Object.entries(draft)) {
    const prev = snap[name];
    if (!prev) {
      created.push({ name, initiative: { ...draftInit } });
      continue;
    }
    if (!initiativesEqual(prev, draftInit)) {
      updated.push({ name, initiative: { ...draftInit }, previous: { ...prev } });
    }
  }
  return { created, updated };
}

function nextRevisionFor(diffCreated, diffUpdated, snapshot, targetId) {
  if (!targetId) return null;
  for (const c of diffCreated) if (c.id === targetId) return c.node.revision;
  for (const u of diffUpdated) if (u.id === targetId) return u.node.revision;
  const prev = snapshot.nodes ? snapshot.nodes[targetId] : null;
  if (prev && Number.isInteger(prev.revision)) return prev.revision;
  return null;
}

function buildLogEntry(request, plan, diffCreated, diffUpdated, edgesAdded, edgesRemoved, removedNodes, targetNextRevision, pluginId, initiativeDiff) {
  const base = {
    action: request.action,
    agent: request.actor,
    node: plan.target.id,
  };
  if (targetNextRevision !== null && targetNextRevision !== undefined) base.revision = targetNextRevision;
  if (removedNodes.length > 0) base.removed_nodes = removedNodes.slice().sort();
  if (edgesAdded.length > 0 || edgesRemoved.length > 0) {
    base.edges = {
      added: edgesAdded.slice(),
      removed: edgesRemoved.slice(),
    };
  }
  if (initiativeDiff && (initiativeDiff.created.length > 0 || initiativeDiff.updated.length > 0)) {
    base.initiatives = {
      created: initiativeDiff.created.map((c) => c.name).sort(),
      updated: initiativeDiff.updated.map((u) => u.name).sort(),
    };
  }
  return prepareLogEntry(base, { pluginId });
}

// validateDraftStructural — last line of defence after provider.apply.
// Today this is a sanity check on the draft (no revision field on
// nodes; edges key shape); the transaction layer already enforces the
// major structural errors (SELF_EDGE / INVALID_EDGE_* / DUPLICATE_EDGE).
// Kept here so future kernels can tighten the contract without touching
// the tx module.
function validateDraftStructural(draftView, commandName) {
  const nodes = draftView && draftView.nodes;
  if (!nodes || typeof nodes !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft view missing nodes`, { field: "draft" });
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node && typeof node === "object" && "revision" in node && node.revision !== undefined) {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        `${commandName}: draft node ${id} unexpectedly carries 'revision'`,
        { id },
      );
    }
  }
  const edges = Array.isArray(draftView.edges) ? draftView.edges : [];
  for (const e of edges) {
    if (!EDGE_TYPE_FIELD_RE.test(e.type)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft edge has invalid type`, { edge: e });
    }
    if (!Object.prototype.hasOwnProperty.call(nodes, e.from) || !Object.prototype.hasOwnProperty.call(nodes, e.to)) {
      throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: draft edge references missing draft node`, { edge: e });
    }
  }
}

async function runPolicy(policyAction, snapshot, plan, request, commandName) {
  if (!policyAction || typeof policyAction !== "object") return;
  if (typeof policyAction.decide !== "function") return;
  const action = typeof policyAction.action === "string" && policyAction.action.length > 0
    ? policyAction.action
    : request.action;
  let decision;
  try {
    decision = await policyAction.decide({ snapshot, target: plan.target, request, action });
  } catch (err) {
    // The decision function itself failed; surface as INVALID_EXECUTION_CONTRACT
    // (the kernel does not import src/policy.mjs — B5 wires that in and
    // upgrades malformed responses to POLICY_ERROR there). For now the
    // kernel surfaces the raw cause as details so callers can branch.
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: policyAction.decide threw: ${err && err.message ? err.message : String(err)}`,
      { action, cause: err && err.code ? err.code : null },
    );
  }
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: policyAction.decide must return an object`, { field: "policyAction" });
  }
  if (decision.decision === "deny") {
    throwV2(
      "POLICY_DENIED",
      `${commandName}: action ${action} denied by policy: ${decision.reason || "(no reason)"}`,
      {
        policy_id: policyAction.pluginId || null,
        action,
        reason: decision.reason || null,
      },
    );
  }
  // 'allow' and 'abstain' proceed with the kernel mutation.
}

function deriveTargetRevision(snapshot, plan, created, updated) {
  const targetId = plan.target.id;
  for (const c of created) if (c.id === targetId) return c.node.revision;
  for (const u of updated) if (u.id === targetId) return u.node.revision;
  const prev = snapshot && snapshot.nodes ? snapshot.nodes[targetId] : null;
  return prev && Number.isInteger(prev.revision) ? prev.revision : null;
}

/**
 * kernel.mutate — single mutation frontier.
 *
 * @param {object} args
 * @param {string} args.projectDir - Project directory (also the state
 *   scope; the lock file lives next to the project's tasks.json).
 * @param {object} args.request - Caller payload. MUST contain
 *   `{ action: string, actor: string, input?: object }`. May also
 *   carry `if_revision` (single|multi|none) or `if_revisions` (multi).
 * @param {object} args.provider - Provider with `prepare` and
 *   `apply`. `prepare({ snapshot, input, request }) → plan` runs once
 *   under the lock against the fresh snapshot. `apply({ tx, plan,
 *   input, request, snapshot }) → { result?, effects? }` mutates the tx
 *   only; effects is optional and not persisted.
 * @param {object} [args.policyAction] - Optional authorization step.
 *   Shape: `{ decide({ snapshot, target, request, action }) →
 *     { decision: 'allow'|'deny'|'abstain', reason?: string } | throws,
 *     action?: string, pluginId?: string }`. deny throws POLICY_DENIED.
 * @param {string} [args.pluginId] - Optional plugin identifier; if
 *   non-empty, the log entry carries `plugin_id`.
 *
 * @returns {Promise<{
 *   result: any,
 *   effects: object|null,
 *   log_entry: object|null,
 *   idempotent: boolean,
 *   diff: {
 *     created: { id, node }[],
 *     updated: { id, node }[],
 *     added_edges: Edge[],
 *     removed_edges: Edge[],
 *     removed_nodes: string[],
 *     target_revision: number|null,
 *     initiatives: { created: { name, initiative }[], updated: { name, initiative, previous }[] }
 *   }
 * }>}
 *
 * Throws `INVALID_EXECUTION_CONTRACT` for contract violations
 * (nested mutate, malformed request/provider/plan/decision). Throws
 * `REVISION_CONFLICT` if if_revision/if_revisions do not match the
 * snapshot under the lock. Throws `POLICY_DENIED` when the policy
 * denies the operation. Errors from provider.prepare and
 * provider.apply propagate verbatim.
 */
export async function mutate({ projectDir, request, provider, policyAction, pluginId }) {
  validateRequest(request);
  validateProvider(provider);

  const commandName = commandLabel(request);

  if (nestedDepth > 0) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: nested kernel.mutate is rejected (the kernel is single-entry; providers must not mutate)`,
      { field: "mutate", depth: nestedDepth + 1 },
    );
  }
  nestedDepth += 1;

  try {
    return await withLock(projectDir, async () => {
      const snapshot = await readState(projectDir);
      if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 2) {
        // The kernel does not bootstrap; the caller (CLI handler,
        // plugin-core-adapter, internals) is responsible for ensuring
        // the state has been initialised. Be loud — this is a contract
        // violation, not a recoverable error.
        throw new Error(`${commandName}: state file missing or not v2 (run init first)`);
      }

      // 1) prepare — exactly once, inside the lock, against the snapshot
      //    we are about to mutate. The plan is frozen below so neither
      //    provider nor apply can mutate it.
      const prepareResult = await provider.prepare({ snapshot, input: request.input, request });
      validatePlan(prepareResult, commandName);
      const plan = Object.freeze({
        target: Object.freeze({ ...prepareResult.target }),
        policyAction: planPolicyAction(prepareResult, request),
        // Other plan fields are pass-through for the provider's apply.
        ...Object.fromEntries(
          Object.entries(prepareResult).filter(([k]) => k !== "target" && k !== "policyAction"),
        ),
      });
      // The spread above loses frozenness on inner objects; let apply
      // get a frozen copy of any extra fields too.
      const frozenExtras = {};
      for (const [k, v] of Object.entries(plan)) {
        if (k === "target") continue; // already frozen
        frozenExtras[k] = (v && typeof v === "object") ? Object.freeze(v) : v;
      }
      const frozenPlan = Object.freeze({ ...frozenExtras, target: plan.target });

      // 2) if_revision validation, under the lock, AFTER the snapshot.
      //    The kernel accepts the precondition either on the request
      //    (agent-facing CAS) or on the plan (provider-declared CAS);
      //    the request takes precedence.
      const requestedIf = request.if_revision !== undefined
        ? request.if_revision
        : (request.if_revisions !== undefined ? request.if_revisions : undefined);
      const planIf = frozenPlan.if_revision !== undefined
        ? frozenPlan.if_revision
        : (frozenPlan.if_revisions !== undefined ? frozenPlan.if_revisions : undefined);
      const precondition = requestedIf !== undefined ? requestedIf : planIf;
      checkPrecondition(precondition, snapshot, commandName);

      // 3) policy authorize — fresh snapshot + plan, no double lock.
      await runPolicy(policyAction, snapshot, frozenPlan, request, commandName);

      // 4) tx + apply. Provider.apply is the only mutation surface
      //    beyond the lock — it touches the draft only.
      const tx = createTransaction(snapshot);
      const applyResult = await provider.apply({
        tx,
        plan: frozenPlan,
        input: request.input,
        request,
        snapshot,
      });
      let result = null;
      let effects = null;
      if (applyResult !== undefined && applyResult !== null) {
        if (typeof applyResult !== "object" || Array.isArray(applyResult)) {
          throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply must return an object`, { field: "apply" });
        }
        if ("result" in applyResult) result = applyResult.result;
        if ("effects" in applyResult) {
          if (applyResult.effects !== undefined && applyResult.effects !== null && (typeof applyResult.effects !== "object" || Array.isArray(applyResult.effects))) {
            throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: apply.effects must be an object when present`, { field: "effects" });
          }
          effects = applyResult.effects === null ? null : applyResult.effects;
        }
      }

      // 5) final draft validation + diff + revisions + idempotency.
      const draftView = tx.view();
      validateDraftStructural(draftView, commandName);
      const { next: nextNodes, removed: removedNodes, created, updated } = assignRevisionsAndDiff(snapshot, draftView);
      const { added: addedEdges, removed: removedEdges } = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
      const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});

      const isIdempotent =
        created.length === 0 &&
        updated.length === 0 &&
        addedEdges.length === 0 &&
        removedEdges.length === 0 &&
        removedNodes.length === 0 &&
        initiativeDiff.created.length === 0 &&
        initiativeDiff.updated.length === 0;

      let persistedState = null;
      let logEntry = null;

      if (!isIdempotent) {
        const targetNextRevision = deriveTargetRevision(snapshot, frozenPlan, created, updated);
        // Preserve all snapshot keys (initiatives etc.); replace nodes
        // and edges entirely with the draft; append exactly one log
        // entry. Single atomic writeState call — state + log in one
        // write, no second route.
        const finalNodes = {};
        for (const [id, node] of Object.entries(snapshot.nodes || {})) {
          if (Object.prototype.hasOwnProperty.call(nextNodes, id)) {
            finalNodes[id] = nextNodes[id];
          }
          // Removed nodes are excluded from the persisted state by
          // omission (snapshot keys not in nextNodes are dropped).
        }
        // Add brand-new nodes that don't exist in the snapshot at all.
        for (const [id, node] of Object.entries(nextNodes)) {
          if (!Object.prototype.hasOwnProperty.call(finalNodes, id)) {
            finalNodes[id] = node;
          }
        }

        // Merge initiatives: the draft wins per-name. Snapshot names not
        // in the draft are kept (registration is monotonic — the kernel
        // does not delete initiatives in B1b, matching add-initiative).
        const snapInits = snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
        const draftInits = draftView.initiatives || {};
        const finalInitiatives = {};
        for (const [name, init] of Object.entries(snapInits)) {
          if (Object.prototype.hasOwnProperty.call(draftInits, name)) {
            finalInitiatives[name] = draftInits[name];
          } else {
            finalInitiatives[name] = init;
          }
        }
        for (const [name, init] of Object.entries(draftInits)) {
          if (!Object.prototype.hasOwnProperty.call(finalInitiatives, name)) {
            finalInitiatives[name] = init;
          }
        }

        const logPayload = buildLogEntry(
          request,
          frozenPlan,
          created,
          updated,
          addedEdges,
          removedEdges,
          removedNodes,
          targetNextRevision,
          pluginId,
          initiativeDiff,
        );

        persistedState = {
          ...snapshot,
          nodes: finalNodes,
          edges: draftView.edges,
          initiatives: finalInitiatives,
          log: [...(Array.isArray(snapshot.log) ? snapshot.log : []), logPayload],
        };
        logEntry = logPayload;

        await writeState(projectDir, persistedState);
      } else {
        // Idempotent: no write, no log entry. We still surface a
        // consistent shape so callers can rely on `log_entry === null`
        // and `idempotent === true`.
      }

      return {
        result,
        effects,
        log_entry: logEntry,
        idempotent: isIdempotent,
        diff: {
          created,
          updated,
          added_edges: addedEdges,
          removed_edges: removedEdges,
          removed_nodes: removedNodes,
          target_revision: deriveTargetRevision(snapshot, frozenPlan, created, updated),
          initiatives: initiativeDiff,
        },
      };
    });
  } finally {
    nestedDepth -= 1;
    if (nestedDepth < 0) nestedDepth = 0;
  }
}

export const __kernelInternals = Object.freeze({
  checkPrecondition,
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  validateDraftStructural,
  validateRequest,
  validateProvider,
  validatePlan,
  deepEqualNodes,
  buildLogEntry,
});
