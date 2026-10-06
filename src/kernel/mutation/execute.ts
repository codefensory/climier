
import { validateMutationArguments, commandLabel, operationLabel, freezePlan } from "./execute/shared.ts";
import { executeBatchMutation } from "./execute/batch.ts";
import { executeStateMutation } from "./execute/state.ts";
import { executeProviderMutation } from "./execute/provider.ts";

/**
 * Run the complete mutation pipeline. The caller must hold the project lock.
 * This facade intentionally performs no lock acquisition.
 */
export async function executeMutation({ projectDir, lockContext, request, provider, policyAction, pluginId, stateOperation, batch }) {
  const commandName = validateMutationArguments({ request, provider, stateOperation, batch });
  if (batch !== undefined) {
    return executeBatchMutation({ projectDir, lockContext, request, batch, policyAction, pluginId });
  }
  if (stateOperation !== undefined) {
    return executeStateMutation({ projectDir, lockContext, request, stateOperation, policyAction, pluginId });
  }
  return executeProviderMutation({ projectDir, lockContext, request, provider, policyAction, pluginId, commandName });
}


export { commandLabel, operationLabel, executeBatchMutation, freezePlan, validateMutationArguments };
