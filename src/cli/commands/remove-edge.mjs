// remove-edge: idempotently remove one exact edge triple.
//
// This adapter parses the CLI shape and delegates the canonical edge.remove
// operation to Application Operations. The provider and kernel own exact
// matching, policy timing, locking, diffing and the no-op persistence rule.
import {
  bootstrapBuiltins,
  executeOperation,
} from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";

export const knownFlags = ["type", "as"];

const REG = bootstrapBuiltins();

export default async function removeEdge({ statePath, positional, flags = {} }) {
  const [from, to] = positional;
  if (!from || !to) {
    throwV2("MISSING_FIELD", "remove-edge: from and to ids required", { field: "from,to" });
  }
  if (!flags.type) {
    throwV2("MISSING_FIELD", "remove-edge: --type required", { field: "type" });
  }

  const actor = resolveAgent(flags, "remove-edge");
  const projectDir = statePath;
  const policy = await loadApplicablePolicy({ projectDir });
  const input = { from, to, type: flags.type };
  const source = {
    registry: REG,
    mutate,
    selectPolicy: async () => policy,
    authorizeAction,
  };
  const outcome = await executeOperation({
    projectDir,
    actor,
    operation: "edge.remove",
    input,
    source,
  });
  return outcome.result;
}
