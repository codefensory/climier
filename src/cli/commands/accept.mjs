// `accept <id>` CLI adapter for the canonical task.accept operation.
// Application Operations selects the provider from the built-in registry; the
// kernel remains the sole mutation frontier for locking, revisions and logs.
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";

const REGISTRY = bootstrapBuiltins();

export const knownFlags = ["as"];

export default async function accept({ statePath, projectDir, flags = {}, positional = [] } = {}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "accept: node id required", { field: "id" });
  const agent = resolveAgent(flags, "accept");
  const dir = projectDir || statePath;
  const policy = await loadApplicablePolicy({ projectDir: dir });

  const mutation = await executeOperation({
    projectDir: dir,
    actor: agent,
    operation: "task.accept",
    input: { id, actor: agent },
    source: {
      registry: REGISTRY,
      mutate,
      selectPolicy: async () => policy,
      authorizeAction,
    },
  });

  const updated = mutation.diff.updated.find((entry) => entry.id === id);
  if (!updated || !updated.node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `accept: kernel did not return node ${id}`, { id });
  }
  return {
    node: updated.node,
    newly_ready: mutation.effects && Array.isArray(mutation.effects.newly_ready)
      ? mutation.effects.newly_ready
      : [],
  };
}
