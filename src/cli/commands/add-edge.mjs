// add-edge: append a new edge to the v2 state.
//
// T-graph-kernel-adapters-wave1 — this handler is now a thin adapter
// over the kernel mutation frontier (`kernel.mutate` + the `edge.add`
// provider). The adapter parses argv, resolves the policy outside
// the lock, and hands control to the kernel, which owns the lock,
// the snapshot read, the precondition check, the policy authorize,
// the draft mutation, the diff/revision computation and the single
// atomic state + log write. The handler itself no longer imports
// withLock, updateState, appendWithContext or edit `revision`
// directly; the only mutating call is `kernel.mutate`.
//
// Errors (`SELF_EDGE`, `INVALID_EDGE_TARGET`, `INVALID_EDGE_TYPE`,
// `MISSING_FIELD`, `POLICY_DENIED`, `REVISION_CONFLICT`,
// `INVALID_EXECUTION_CONTRACT`, …) propagate verbatim from the
// provider / kernel so existing consumers and tests keep their
// structured error envelopes.

import { mutate } from "../../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { edgeAddProvider } from "../../providers/core/edge.mjs";

export const knownFlags = ["type", "as"];

const POLICY_ACTION = "edge.add";
const LOG_ACTION = "add-edge";

export default async function addEdge({ statePath, positional, flags, pluginId }) {
  const [from, to] = positional;
  if (!from || !to) {
    throwV2("MISSING_FIELD", "add-edge: from and to ids required", { field: "from,to" });
  }
  if (!flags.type) {
    throwV2("MISSING_FIELD", "add-edge: --type required", { field: "type" });
  }
  const projectDir = statePath;

  // F8: resolve the agent BEFORE building the request so the seam
  // sees the real caller. MISSING_AGENT still surfaces after data
  // validation but before the kernel opens the lock.
  const agent = resolveAgent(flags, "add-edge");

  // T-plugin-policy-seam-dag — ADR-008 §"Seam por handler": policy
  // selection runs OUTSIDE the lock; the authorize step runs INSIDE
  // the lock via `policyAction.decide` against the snapshot the
  // kernel reads under the same lock.
  const policy = await loadApplicablePolicy({ projectDir });

  const input = {
    from,
    to,
    // The provider normalizes the type to the canonical uppercase
    // whitelist, so the adapter passes the raw flag value as-is.
    type: flags.type,
  };

  // policyAction is the in-lock authorize step the kernel evaluates
  // against the fresh snapshot + plan. With no applicable policy the
  // seam is inert (defaults core: allow/abstain both proceed).
  const policyAction = policy
    ? {
        action: POLICY_ACTION,
        pluginId: policy.pluginId,
        decide: async ({ snapshot, target, request, action }) => {
          const decision = await authorizeAction({
            policy,
            action,
            actor: agent,
            target,
            snapshot,
            projectDir,
            projectConfig: policy.projectConfig || {},
          });
          return decision;
        },
      }
    : null;

  const result = await mutate({
    projectDir,
    request: { action: LOG_ACTION, actor: agent, input },
    provider: edgeAddProvider,
    policyAction,
    pluginId,
  });

  // The provider's apply returns `{ result: { edge } }`. Project the
  // legacy `{ edge }` envelope so existing callers and tests keep
  // working without churn.
  const edge = result.result && result.result.edge ? result.result.edge : null;
  return { edge };
}
