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
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { readState, writeState, stateFile, createSnapshot, emptyState } from "../storage/state.mjs";
import { withLock } from "../storage/lock.mjs";
import { prepareLogEntry } from "../storage/log.mjs";
import { throwV2 } from "../contracts/errors.mjs";
import { createTransaction } from "./transaction.mjs";
import {
  commandLabel,
  operationLabel,
  validatePlan,
  validateProvider,
  validateRequest,
} from "./mutation/request.mjs";
import { checkPrecondition, selectPrecondition } from "./mutation/preconditions.mjs";
import { freezePlan, validateMutationArguments } from "./mutation/execute.mjs";
import {
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  deepEqualNodes,
} from "./mutation/diff.mjs";
import { deriveTargetRevision } from "./mutation/revisions.mjs";
import { normalizeLogFields, validateDraftStructural } from "./mutation/validation.mjs";
import { buildLogEntry } from "./mutation/log-entry.mjs";

// Module-scoped AsyncLocalStorage for the nested kernel.mutate guard.
//
// Why AsyncLocalStorage instead of a plain `let nestedDepth` counter:
// a module-level counter is shared across every async chain in the
// process, so two independent concurrent `kernel.mutate` calls on the
// same project race on the counter — the second to enter sees
// depth=1 and is rejected as if it were nested, even though the two
// calls are unrelated. That was the regression in
// T-graph-kernel-mutate-concurrency-fix.
//
// AsyncLocalStorage scopes the depth to the current async chain: each
// top-level `kernel.mutate` enters its own context (depth 1), and
// only a `provider.apply` that invokes `kernel.mutate` *within the
// same chain* observes depth=2 and is rejected with
// INVALID_EXECUTION_CONTRACT. Two concurrent independent calls each
// carry their own depth and are unaffected by one another.
//
// Module-scope is intentional: importFresh (used by tests) re-
// evaluates this module, so each test gets a fresh AsyncLocalStorage
// instance and the guard resets per test. Sequential tests never
// share re-entrancy state.
const nestedDepthStorage = new AsyncLocalStorage();

function currentNestedDepth() {
  const store = nestedDepthStorage.getStore();
  return typeof store === "number" ? store : 0;
}


async function runPolicy(policyAction, snapshot, plan, request, commandName) {
  if (!policyAction || typeof policyAction !== "object") return;
  if (typeof policyAction.decide !== "function") return;
  const action = typeof policyAction.action === "string" && policyAction.action.length > 0
    ? policyAction.action
    : request.action;
  const actor = typeof request.actor === "string" ? request.actor : "";
  const pluginId = policyAction.pluginId || null;
  let decision;
  try {
    decision = await policyAction.decide({ snapshot, target: plan.target, request, action });
  } catch (err) {
    // POLICY_* errors raised by decide() (typically the PolicyError /
    // PolicyDenied / PolicyConflict classes thrown from src/plugins/policy.mjs
    // authorizeAction) are policy-domain errors and must propagate with
    // their original code and details — they are NOT contract
    // violations of decide() itself. Anything else (a bare Error /
    // TypeError, a non-POLICY_* code, a callback crash) is a real
    // contract failure and is reported as INVALID_EXECUTION_CONTRACT.
    if (err && typeof err.code === "string" && err.code.startsWith("POLICY_") && err.details !== undefined) {
      throw err;
    }
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
    // POLICY_DENIED is the canonical contract for a deny decision;
    // the mutation does not run and no log entry is produced
    // (deny throws before tx is created). The details carry the
    // four fields the seam contract requires — `plugin_id`, `action`,
    // `actor`, `reason` — so handlers and tests can branch without
    // re-reading the thrown message. `policy_id` is kept as a
    // backward-compatible alias of `plugin_id` for older callers
    // that were written against the previous (incorrect) field name.
    throwV2(
      "POLICY_DENIED",
      `${commandName}: action ${action} denied by policy for actor '${actor}': ${typeof decision.reason === "string" ? decision.reason : "(no reason)"}`,
      {
        plugin_id: pluginId,
        policy_id: pluginId,
        action,
        actor,
        reason: typeof decision.reason === "string" ? decision.reason : null,
      },
    );
  }
  if (decision.decision !== "allow" && decision.decision !== "abstain") {
    // Any value other than the three allowed decisions is a contract
    // violation of the decide callback, not a policy-domain outcome.
    // The kernel refuses to interpret it; handlers see
    // INVALID_EXECUTION_CONTRACT and operators can investigate.
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: policyAction.decide returned an unknown decision: ${JSON.stringify(decision.decision)}`,
      { field: "policyAction.decision", value: decision.decision },
    );
  }
  // 'allow' and 'abstain' proceed with the kernel mutation.
}

async function runStateMutation({ projectDir, request, stateOperation, policyAction, pluginId }) {
  const commandName = commandLabel(request);
  const statePath = stateFile(projectDir);
  let currentRaw = null;
  let currentState = null;
  let exists = false;
  try {
    currentRaw = await fs.readFile(statePath);
    exists = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let stateError = null;
  if (exists) {
    try {
      currentState = await readState(projectDir);
    } catch (err) {
      // State recovery is an explicitly trusted internal operation. Keep the
      // raw bytes available for a snapshot while exposing no parsed state to
      // policy or the operation provider. Version errors are included here
      // for the same narrow recovery path: state.init_force and
      // state.restore may preserve/replace the raw bytes, while ordinary
      // providers still go through readState below and reject them.
      if (![
        "CLIMIER_CORRUPT_STATE",
        "STATE_V1_UNSUPPORTED",
        "CLIMIER_INCOMPATIBLE_VERSION",
      ].includes(err.code)) throw err;
      stateError = err;
    }
  }
  const snapshot = Object.freeze({
    state: currentState,
    raw: currentRaw,
    exists,
    stateError,
    nodes: currentState && currentState.nodes ? { ...currentState.nodes } : {},
    edges: currentState && Array.isArray(currentState.edges) ? currentState.edges.slice() : [],
    initiatives: currentState && currentState.initiatives ? { ...currentState.initiatives } : {},
    // Root plugin data is an optional v2 keyspace. Preserve its absence for
    // older states while exposing it to the transaction when present.
    ...(currentState && Object.prototype.hasOwnProperty.call(currentState, "plugins")
      ? { plugins: currentState.plugins }
      : {}),
  });
  const prepared = await stateOperation.prepare({ projectDir, snapshot, input: request.input, request });
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || !prepared.target || typeof prepared.target.id !== "string") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation prepare must return a plan with target`, { field: "plan" });
  }
  const plan = Object.freeze({ ...prepared, target: Object.freeze({ ...prepared.target }) });
  await runPolicy(policyAction, snapshot, plan, request, commandName);
  const applied = await stateOperation.apply({ snapshot, plan, input: request.input, request });
  if (!applied || typeof applied !== "object" || !applied.state || typeof applied.state !== "object" || Array.isArray(applied.state)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: state operation apply must return a state object`, { field: "state" });
  }
  let snapshotMeta = null;
  if (plan.snapshotReason) {
    if (!exists) {
      throwV2("INVALID_STATUS", `${commandName}: cannot snapshot a missing current state`, { state_file: statePath });
    }
    snapshotMeta = await createSnapshot(projectDir, plan.snapshotReason);
  }
  const nextState = { ...applied.state };
  let logEntry = null;
  if (plan.log) {
    logEntry = prepareLogEntry({ action: plan.logAction || request.action, agent: request.actor, ...plan.log }, { pluginId });
    nextState.log = [...(Array.isArray(nextState.log) ? nextState.log : []), logEntry];
  }
  await writeState(projectDir, nextState);
  let result = applied.result === undefined ? null : applied.result;
  if (snapshotMeta && result && typeof result === "object" && !Array.isArray(result) && result.snapshot === undefined) {
    result = { ...result, snapshot: snapshotMeta };
  }
  return {
    result,
    effects: applied.effects === undefined ? null : applied.effects,
    log_entry: logEntry,
    idempotent: false,
    diff: { created: [], updated: [], added_edges: [], removed_edges: [], removed_nodes: [], target_revision: null, initiatives: { created: [], updated: [] } },
  };
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
 *   only; effects is optional and not persisted. The built-in
 *   `initiative.create` provider may additionally set
 *   `bootstrapMissingState: true` to opt into an absent-state snapshot.
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
export async function mutate({ projectDir, request, provider, policyAction, pluginId, stateOperation }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation });

  // Nested-mutation guard, scoped per async chain via AsyncLocalStorage.
  // Two independent concurrent mutate() calls each have their own
  // context (depth 1) and are not flagged as nested; only a
  // provider.apply that calls mutate() within the same chain sees
  // depth ≥ 1 and is rejected.
  const parentDepth = currentNestedDepth();
  if (parentDepth > 0) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      `${commandName}: nested kernel.mutate is rejected (the kernel is single-entry; providers must not mutate)`,
      { field: "mutate", depth: parentDepth + 1 },
    );
  }

  // als.run establishes a fresh depth for the current chain. When the
  // returned promise settles, the previous depth (if any) is restored
  // automatically — no manual decrement required.
  return nestedDepthStorage.run(parentDepth + 1, () =>
    withLock(projectDir, async () => {
      if (stateOperation !== undefined) {
        return runStateMutation({ projectDir, request, stateOperation, policyAction, pluginId });
      }
      const loadedState = await readState(projectDir);
      // Missing state is a deliberately narrow capability. Only the built-in
      // initiative provider opts into it, and only for the matching operation;
      // every other provider still receives the established "run init first"
      // contract. The empty v2 state is kept in memory until the normal
      // transaction path writes the initiative and its log atomically.
      const mayBootstrap =
        loadedState === null &&
        request.action === "initiative.create" &&
        provider.bootstrapMissingState === true;
      const snapshot = loadedState ?? (mayBootstrap ? emptyState() : null);
      if (!snapshot || typeof snapshot !== "object" || snapshot.version !== 2) {
        // The kernel does not bootstrap arbitrary operations; the caller
        // (CLI handler, plugin-core-adapter, internals) is responsible for
        // ensuring the state has been initialised. Be loud — this is a
        // contract violation, not a recoverable error.
        throw new Error(`${commandName}: state file missing or not v2 (run init first)`);
      }

      // 1) prepare — exactly once, inside the lock, against the snapshot
      //    we are about to mutate. The plan is frozen below so neither
      //    provider nor apply can mutate it.
      const prepareResult = await provider.prepare({ snapshot, input: request.input, request, pluginId });
      const frozenPlan = freezePlan(prepareResult, commandName);
      // Validate before policy/apply so malformed provider audit fields can
      // never reach the draft or cause a partial mutation.
      normalizeLogFields(frozenPlan.logFields, commandName);

      // 2) if_revision validation, under the lock, AFTER the snapshot.
      //    The kernel accepts the precondition either on the request
      //    (agent-facing CAS) or on the plan (provider-declared CAS);
      //    the request takes precedence.
      const precondition = selectPrecondition(request, frozenPlan);
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
      const draftView = tx.view({ includePlugins: true });
      validateDraftStructural(draftView, commandName);
      const { next: nextNodes, removed: removedNodes, created, updated } = assignRevisionsAndDiff(snapshot, draftView);
      const { added: addedEdges, removed: removedEdges } = computeEdgeDiff(snapshot.edges || [], draftView.edges || []);
      const initiativeDiff = computeInitiativeDiff(snapshot.initiatives || {}, draftView.initiatives || {});
      // Node-scoped plugin data is already covered by the node diff above;
      // project-scoped data lives outside nodes and must participate directly
      // in idempotency so it is not silently dropped or treated as a no-op.
      const pluginsBefore = snapshot.plugins && typeof snapshot.plugins === "object" && !Array.isArray(snapshot.plugins)
        ? snapshot.plugins
        : {};
      const pluginsAfter = draftView.plugins && typeof draftView.plugins === "object" && !Array.isArray(draftView.plugins)
        ? draftView.plugins
        : {};
      const pluginsChanged = !deepEqualNodes(pluginsBefore, pluginsAfter);

      const isIdempotent =
        created.length === 0 &&
        updated.length === 0 &&
        addedEdges.length === 0 &&
        removedEdges.length === 0 &&
        removedNodes.length === 0 &&
        initiativeDiff.created.length === 0 &&
        initiativeDiff.updated.length === 0 &&
        !pluginsChanged;

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
        // Keep the optional collection absent for legacy states until a
        // provider actually creates root plugin data. Existing plugin data is
        // always replaced with the complete isolated draft to preserve every
        // plugin namespace and its metadata in the same atomic write.
        if (Object.prototype.hasOwnProperty.call(snapshot, "plugins") || Object.keys(pluginsAfter).length > 0) {
          persistedState.plugins = pluginsAfter;
        } else {
          delete persistedState.plugins;
        }
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
    }),
  );
}

export const __kernelInternals = Object.freeze({
  commandLabel,
  operationLabel,
  checkPrecondition,
  selectPrecondition,
  assignRevisionsAndDiff,
  computeEdgeDiff,
  computeInitiativeDiff,
  validateDraftStructural,
  validateRequest,
  validateProvider,
  validatePlan,
  deepEqualNodes,
  deriveTargetRevision,
  normalizeLogFields,
  buildLogEntry,
});
