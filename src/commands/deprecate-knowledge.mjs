// `deprecate-knowledge` CLI adapter for the canonical knowledge.deprecate
// provider. The kernel owns locking, state, revisions, policy execution and
// audit persistence; this module only maps the legacy CLI surface.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { deprecateProvider } from "../providers/knowledge/deprecate.mjs";

export const knownFlags = ["reason", "as"];

const knowledgeProvider = deprecateProvider();

// Keep the historical CLI error code for a non-knowledge target while leaving
// domain validation to the provider. Other provider errors, including
// revision/CAS errors, must propagate unchanged.
const cliKnowledgeProvider = Object.freeze({
  async prepare(args) {
    try {
      const plan = await knowledgeProvider.prepare(args);
      const node = args.snapshot.nodes[args.input.id];
      return {
        ...plan,
        // The old policy seam exposed these live-node fields. Preserve that
        // target projection while retaining the provider's CAS revision.
        target: {
          ...plan.target,
          subkind: node.subkind,
          status: node.status,
        },
        // `reason` was part of the historical deprecate-knowledge log entry;
        // the kernel owns the rest of the audit envelope.
        logFields: { reason: plan.reason },
      };
    } catch (error) {
      if (
        error &&
        error.code === "INVALID_PROVIDER_INPUT" &&
        error.details &&
        error.details.id === args.input.id &&
        /not a knowledge node/.test(error.message)
      ) {
        throwV2(
          "INVALID_EDGE_KIND",
          `deprecate-knowledge: ${args.input.id} is not a knowledge node (got kind=${error.details.kind})`,
          { id: args.input.id, kind: error.details.kind },
        );
      }
      throw error;
    }
  },
  apply: knowledgeProvider.apply,
});

function policyAction({ policy, projectDir }) {
  if (!policy) return undefined;
  return {
    action: "knowledge.deprecate",
    pluginId: policy.pluginId || null,
    async decide({ snapshot, target, request, action }) {
      return authorizeAction({
        policy,
        action: action || "knowledge.deprecate",
        actor: request.actor,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
    },
  };
}

export default async function deprecateKnowledge({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
}) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "deprecate-knowledge: node id required", { field: "id" });
  const reason = flags.reason;
  if (reason === true || !reason || !String(reason).trim()) {
    throwV2("MISSING_FIELD", "deprecate-knowledge: --reason is required", { field: "reason" });
  }

  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "deprecate-knowledge");
  const policy = await loadApplicablePolicy({ projectDir: dir });
  const mutation = await mutate({
    projectDir: dir,
    request: {
      // Keep the legacy audit action; the policy seam receives the canonical
      // knowledge.deprecate action through policyAction above.
      action: "deprecate-knowledge",
      actor: agent,
      input: { id, reason: String(reason) },
    },
    provider: cliKnowledgeProvider,
    policyAction: policyAction({ policy, projectDir: dir }),
    pluginId,
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `deprecate-knowledge: kernel did not return node ${id}`, { id });
  }
  return { node: updated.node };
}
