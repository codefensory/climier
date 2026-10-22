
import { validateMutationArguments, commandLabel, operationLabel, freezePlan } from "./execute/shared.ts";
import { executeBatchMutation } from "./execute/batch.ts";
import { executeStateMutation } from "./execute/state.ts";
import { executeProviderMutation } from "./execute/provider.ts";

/**
 * Run the complete mutation pipeline inside its SQLite transaction.
 */
export async function executeMutation({ projectDir, request, provider, policyAction, pluginId, stateOperation, snapshotClosure, batch }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation, batch });
  if (batch !== undefined) {
    return executeBatchMutation({ projectDir, request, batch, policyAction, pluginId });
  }
  if (stateOperation !== undefined) {
    return executeStateMutation({ projectDir, request, stateOperation, policyAction, pluginId });
  }
  return executeProviderMutation({ projectDir, request, provider, policyAction, pluginId, snapshotClosure, commandName });
}


export { commandLabel, operationLabel, executeBatchMutation, freezePlan, validateMutationArguments };
