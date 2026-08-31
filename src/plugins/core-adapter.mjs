// src/plugins/core-adapter.mjs — V2 plugin core surface (ADR-006 §API y
// compatibilidad + ADR-012 §2 + plan §B6B).
//
// `createCore({ projectDir, agent, pluginId })` returns
// `{ version: 2, run }`. `run({ op, input })` is the SINGLE mutation
// frontier for plugin-issued core actions: it routes every call
// through the canonical registry built by `bootstrapBuiltins()` (17
// op ids, see ADR-012 §2) and a single `kernel.mutate` invocation
// per op. The adapter is intentionally a thin mapper:
//   - no argv, no `commands/*`, no `readState`, no `withLock`,
//     no `updateState`, no `append`, no CORE_REGISTRY;
//   - actor and pluginId are fixed by the host (`createCore` args)
//     and cannot be overridden through `input.as` / `input._as`
//     (rejected before any state mutation);
//   - policy selection happens OUTSIDE the lock
//     (`loadApplicablePolicy`); policy decide happens INSIDE the lock
//     (`kernel.mutate`'s `policyAction.decide`);
//   - errors propagate with their structured envelopes:
//       * POLICY_*  (POLICY_DENIED / POLICY_ERROR / POLICY_CONFLICT)
//         surfaced verbatim — the kernel and the seam guarantee shape;
//       * PLUGIN_*  (PLUGIN_CORE_*, PLUGIN_HANDLER_FAILED, …) surfaced
//         verbatim — `isPluginError` short-circuits rewrap;
//       * anything else is wrapped via `wrapCoreError` into
//         PLUGIN_CORE_ACTION_FAILED with the cause envelope.
//
// The contract test (test/plugin-core-adapter.test.mjs) pins every
// behavior listed above and is the single source of truth for
// acceptance. Fixture-migration parity for the legacy `{ node }` /
// `{ edge }` envelopes lives in the daughter fixture task.

import { bootstrapBuiltins } from "../application/operations/index.mjs";
import { mutate } from "../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction, isPolicyError } from "./policy.mjs";
import {
  PluginCoreInvalidOperation,
  isPluginError,
  PolicyError,
  wrapCoreError,
} from "./errors.mjs";

// Build the registry once at module load. The registry is
// `Object.freeze`-d and only carries `{ id, kind, provider }`
// entries; no filesystem, lock, state, log, policy, commands or
// bin references leak in (ADR-012 §5).
const REG = bootstrapBuiltins();

function supportedOps() {
  // Return a fresh slice so callers cannot mutate the registry's
  // frozen `ops` array through the supported list.
  return REG.ops.slice();
}

// validateOp — op must be a non-empty string registered in the
// built-in registry. Anything else (undefined, null, number, unknown
// string) is the same "unknown operation" branch; the rejection
// happens before any state mutation and carries the full supported
// list so callers can recover without scanning the source.
function validateOp(pluginId, op) {
  if (typeof op !== "string" || !op) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      typeof op === "string" ? op : "",
      supportedOps(),
      "unknown operation",
    );
  }
  if (!REG.has(op)) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "unknown operation",
    );
  }
}

// validateInput — input must be a non-null, non-array object;
// `as` / `_as` are forbidden because the actor is fixed by the host
// (api.runtime.agent) and must never be substituted through plugin
// input.
function validateInput(pluginId, op, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "input must be an object",
    );
  }
  if ("as" in input || "_as" in input) {
    throw new PluginCoreInvalidOperation(
      pluginId,
      op,
      supportedOps(),
      "input.as is forbidden",
    );
  }
}

// buildRequest — translate the host-facing input into the kernel
// request shape. `request.action` is the op id; `request.actor` is
// the host-fixed agent; `request.input` is the typed input the
// provider receives. When the input declares `if_revision` AND
// targets a node (`input.id` is a string), the request carries the
// single-CAS precondition so `kernel.mutate` validates it under the
// lock; the provider's `prepare` independently rejects inputs
// without `if_revision` (provider-level MISSING_FIELD) so the
// kernel-level precondition is purely a safety net.
function buildRequest(op, agent, input) {
  const request = {
    action: op,
    actor: agent,
    input,
  };
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof input.id === "string" &&
    input.id.length > 0 &&
    Number.isInteger(input.if_revision) &&
    input.if_revision >= 1
  ) {
    request.if_revision = {
      kind: "single",
      id: input.id,
      value: input.if_revision,
    };
  }
  return request;
}

// buildPolicyAction — turn a `loadApplicablePolicy` result into the
// `{ decide, action, pluginId }` shape the kernel expects. With no
// installed policy, return `undefined` so `kernel.mutate` short-
// circuits the policy step (default abstain — see ADR-008 §"Seam por
// handler"). The wrapper here is the only place authorizeAction is
// invoked; the kernel never reaches into the loader directly.
function buildPolicyAction(policy, op, projectDir) {
  if (!policy) return undefined;
  return {
    action: op,
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return await authorizeAction({
        policy,
        action: action || op,
        actor: request.actor,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig,
      });
    },
  };
}

// selectPolicy — load the applicable policy outside the lock and
// normalize its errors. `loadApplicablePolicy` throws
// `PolicyError(action="applies")` when the policy's `applies()`
// raises; the adapter re-wraps that error with the caller's op id
// (`task.create`, `task.update`, …) so POLICY_ERROR surfaces with
// `details.action === <op>`, matching the contract pinned by the
// adapter tests. Any other error propagates unchanged.
async function selectPolicy({ projectDir, op, pluginId }) {
  let policy;
  try {
    policy = await loadApplicablePolicy({ projectDir });
  } catch (err) {
    if (
      isPolicyError(err) &&
      err.code === "POLICY_ERROR" &&
      err.details &&
      err.details.action === "applies"
    ) {
      throw new PolicyError(
        err.details.plugin_id || "(unknown)",
        op,
        err,
      );
    }
    throw err;
  }
  return policy;
}

/**
 * createCore — exposes `api.core` as `{ version: 2, run }`.
 *
 * @param {object} args
 * @param {string} args.projectDir - Project directory (the same
 *   directory the bin resolves; the lock and state files live under
 *   `$CLIMIER_HOME/projects/<project_id>/` keyed by `.climier.json`).
 * @param {string} args.agent - Host agent identity; every mutation
 *   is stamped with this actor and overrides any `input.as`.
 * @param {string} args.pluginId - Host plugin id; tagged on log
 *   entries via `plugin_id`; cannot be substituted by input.
 *
 * @returns {{ version: 2, run: function }}
 */
export function createCore({ projectDir, agent, pluginId }) {
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("createCore: projectDir required");
  }
  if (typeof pluginId !== "string" || !pluginId) {
    throw new Error("createCore: pluginId required");
  }

  return {
    version: 2,

    /**
     * run — the single mutation frontier for plugin core actions.
     *
     * @param {object} args
     * @param {string} args.op - One of the 18 op ids in `bootstrapBuiltins()`.
     * @param {object} args.input - Typed input; shape per provider.
     *   `as` / `_as` are forbidden.
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
     *     initiatives: { created: { name, initiative }[], updated: { name, initiative, previous }[] },
     *   },
     * }>}
     */
    async run({ op, input } = {}) {
      // 1. Reject before any I/O. Unknown op / non-object input /
      // `as` / `_as` produce a `PLUGIN_CORE_INVALID_OPERATION`
      // envelope that lists the full supported set so callers can
      // recover without parsing the message.
      validateOp(pluginId, op);
      validateInput(pluginId, op, input);

      // 2. Policy selection — OUTSIDE the lock. The host pays the
      // plugin import / descriptor read cost only when a plugin is
      // installed; without any, loadApplicablePolicy returns null
      // and the kernel skips the policy step.
      const policy = await selectPolicy({ projectDir, op, pluginId });

      // 3. Build the kernel request (typed mapping + optional CAS
      // precondition) and the policy action (decide wrapper).
      const request = buildRequest(op, agent, input);
      const policyAction = buildPolicyAction(policy, op, projectDir);

      // 4. ONE `kernel.mutate` call. The kernel owns the lock, the
      // snapshot read, the precondition validation, the policy
      // decide (under the lock), the tx, the apply, the diff, the
      // revision assignment, the log entry, and the single atomic
      // state+log write.
      try {
        return await mutate({
          projectDir,
          request,
          provider: REG.lookup(op).provider,
          policyAction,
          pluginId,
        });
      } catch (err) {
        // POLICY_* errors are domain errors — the envelope already
        // carries plugin_id / action / actor / reason (see
        // kernel.mutate's runPolicy and the seam's PolicyDenied /
        // PolicyError classes). Propagate verbatim so dispatch and
        // the bin's catch block do not rewrite them.
        if (isPolicyError(err)) throw err;
        // PLUGIN_* errors (including PLUGIN_CORE_*) bubble up
        // untouched. The dispatch.isPluginError short-circuit lives
        // in bin/climier.mjs and must see the original envelope.
        if (isPluginError(err)) throw err;
        // Anything else is a core-handler failure and gets wrapped
        // with details.op + a normalized cause envelope.
        throw wrapCoreError(pluginId, op, err);
      }
    },
  };
}
