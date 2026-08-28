// T-plugin-policy-foundation — ADR-007 (contract) + ADR-008 (seam).
//
// This module is the SINGLE source of truth for:
//   - loadApplicablePolicy({ projectDir }) — pick zero or one installed
//     policy plugin for the project, applying `applies()` once per
//     candidate with the projectConfig frozen.
//   - authorizeAction({ policy, action, actor, target, snapshot,
//     projectDir, projectConfig }) — run the selected policy's
//     `authorize()` against the snapshot taken under the handler's
//     lock, returning a structured decision or throwing a POLICY_*
//     error envelope.
//
// The module is intentionally I/O-light: it imports plugins
// (cache-bypassed via the `loadInstalledPolicyPlugins` scan) but does
// NOT touch state. Handlers in `src/commands/*.mjs` own the lock, the
// state mutation, and the log entry; this module only decides whether
// a policy wants to allow/deny/abstain on a given action.
//
// Discovery + selector (loadApplicablePolicy) runs BEFORE the lock —
// importing an entrypoint is allowed outside the lock because plugins
// do not have access to `withLock` or any mutable state during
// `applies`. Authorization (authorizeAction) runs INSIDE the lock,
// receiving the snapshot read under the lock as `snapshot` so the
// plugin can check `target` and the current DAG without observing a
// post-decision race.

import { loadInstalledPolicyPlugins, readProjectConfig } from "./plugin-loader.mjs";
import { PolicyDenied, PolicyError, PolicyConflict } from "./plugin-errors.mjs";

// loadApplicablePolicy — return the unique applicable policy plugin
// for `projectDir`, or `null` when none applies.
//
// Selection algorithm (ADR-007 §"Discovery global"):
//   1. readProjectConfig(projectDir) — frozen, raw .climier.json or {}.
//   2. loadInstalledPolicyPlugins() — installed entries with a valid
//      `default.policy`. NOT cached between calls (ADR-007 §"Discovery
//      global" item 5).
//   3. For each installed candidate:
//        - `applies` absent → candidate is applicable.
//        - `applies(projectConfig)` present → invoke once; truthy
//          result means applicable, falsy means excluded. The host
//          does NOT inspect the return value beyond truthiness.
//   4. More than one applicable → POLICY_CONFLICT (with plugin_ids
//      and namespaces; ADR-007 §"Errores" §POLICY_CONFLICT).
//   5. Zero applicable → return null (defaults core).
//   6. An `applies()` exception is treated as selection failure →
//      POLICY_CONFLICT with `cause_message` carrying the original
//      error so operators can attribute the failure.
//
// Selection does NOT cache. Each call re-reads the install set and
// the project config, so `climier install <plugin>` followed by an
// immediate mutating command observes the new plugin without a
// restart. ADR-007 §"Discovery global" item 5 makes this explicit.
export async function loadApplicablePolicy({ projectDir }) {
  const projectConfig = await readProjectConfig(projectDir);
  const installed = await loadInstalledPolicyPlugins();

  const applicable = [];
  for (const candidate of installed) {
    const { policy, pluginId, namespace } = candidate;
    if (typeof policy.applies !== "function") {
      // No `applies` → always applicable (ADR-007 §"Discovery global"
      // item 2).
      applicable.push(candidate);
      continue;
    }
    let result;
    try {
      result = await policy.applies(projectConfig);
    } catch (err) {
      // Selection failed for this candidate; surface the failure as a
      // POLICY_CONFLICT so the handler aborts the mutation rather than
      // continuing with a partial / unknown set of applicable
      // plugins. The candidate's id and namespace are recorded so the
      // orchestrator can attribute the failure.
      throw new PolicyConflict(
        [pluginId],
        [namespace],
        err && err.message ? err.message : String(err ?? "(unknown)"),
      );
    }
    if (result) applicable.push(candidate);
  }

  if (applicable.length > 1) {
    throw new PolicyConflict(
      applicable.map((c) => c.pluginId),
      applicable.map((c) => c.namespace),
    );
  }
  if (applicable.length === 0) return null;
  const [selected] = applicable;
  return {
    pluginId: selected.pluginId,
    descriptor: selected.descriptor,
    policy: selected.policy,
    namespace: selected.namespace,
    entryPath: selected.entryPath,
    installedDir: selected.installedDir,
    projectConfig,
  };
}

// authorizeAction — invoke the selected policy's `authorize` against
// the snapshot taken under the handler's lock. Returns a structured
// decision or throws a POLICY_* envelope. The function is PURE: it
// does not mutate state, does not call `withLock`, and does not
// import other plugins.
//
// Decision contract (ADR-007 §"Contrato de autorización"):
//   - policy === null → return `{ decision: "abstain" }` (defaults
//     core; the handler applies its own rules without a policy).
//   - policy.policy.authorize throws → throw PolicyError with the
//     original cause's message captured under `cause_message`.
//   - policy.policy.authorize returns an object whose `decision` is
//     `"allow"`, `"deny"`, or `"abstain"` → return the same object
//     (handlers must trust the policy's structure but they should
//     NOT mutate the response).
//   - any other response → throw PolicyError (the policy violated
//     the contract).
//
// The function does NOT translate decisions into errors here:
// handlers do that, because the mapping is action-specific (e.g.
// `task.resolve` evaluates the no-owner invariant BEFORE invoking
// the seam; ADR-008 §"Tabla de resolve" item 1). authorizeAction
// only validates the response shape and propagates exceptions.
export async function authorizeAction({
  policy,
  action,
  actor,
  target,
  snapshot,
  projectDir,
  projectConfig,
}) {
  if (policy === null || policy === undefined) {
    return { decision: "abstain" };
  }
  if (!policy || typeof policy.policy !== "object" || policy.policy === null) {
    throw new PolicyError(
      (policy && policy.pluginId) || "(unknown)",
      action,
      "policy selector returned a non-policy object",
    );
  }
  const { authorize } = policy.policy;
  if (typeof authorize !== "function") {
    throw new PolicyError(
      policy.pluginId || "(unknown)",
      action,
      "policy.authorize is not a function",
    );
  }

  let result;
  try {
    result = await authorize({
      action,
      actor,
      target,
      snapshot,
      projectDir,
      projectConfig,
    });
  } catch (err) {
    throw new PolicyError(policy.pluginId, action, err);
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PolicyError(
      policy.pluginId,
      action,
      `authorize returned a non-object: ${JSON.stringify(result)}`,
    );
  }
  const decision = result.decision;
  if (decision === "allow" || decision === "deny" || decision === "abstain") {
    if (decision === "deny" && typeof result.reason !== "string") {
      // ADR-007 says deny must include a reason; we coerce the
      // missing field into a stable message so the envelope is
      // always JSON-safe. The policy contract was violated, but we
      // surface it as POLICY_DENIED rather than POLICY_ERROR
      // because the operator should still see the action was denied
      // (just without a reason).
      return {
        decision: "deny",
        reason: result.reason ?? "(no reason provided by policy)",
      };
    }
    return decision === "deny"
      ? { decision: "deny", reason: result.reason }
      : { decision };
  }
  throw new PolicyError(
    policy.pluginId,
    action,
    `authorize returned unknown decision: ${JSON.stringify(decision)}`,
  );
}

// isPolicyError — predicate for code paths that must distinguish
// POLICY_* from the PLUGIN_* and PLUGIN_CORE_* families. Mirrors
// `isPluginCoreError` (src/plugin-errors.mjs) and `isPluginError`
// for the policy namespace. Not consulted by the bin's catch (the
// envelope is uniform); useful for handler-side guards and tests.
export function isPolicyError(err) {
  return Boolean(
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("POLICY_") &&
    err.details !== undefined,
  );
}