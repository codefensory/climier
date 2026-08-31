// Mutation execution coordinator helpers.
//
// The public kernel façade owns locking and the mutation algorithm. This
// coordinator keeps entry validation and provider-plan preparation together,
// so the façade does not duplicate the request contract while the execution
// pipeline remains unchanged.

import { throwV2 } from "../../contracts/errors.mjs";
import {
  commandLabel,
  operationLabel,
  validatePlan,
  validateProvider,
  validateRequest,
} from "./request.mjs";

/**
 * Validate the arguments accepted by kernel.mutate before it enters the lock.
 * Returns the operation label used by the rest of the pipeline.
 */
export function validateMutationArguments({ request, provider, stateOperation } = {}) {
  validateRequest(request);
  if (stateOperation !== undefined) {
    if (!stateOperation || typeof stateOperation !== "object" ||
        typeof stateOperation.prepare !== "function" || typeof stateOperation.apply !== "function") {
      throwV2(
        "INVALID_EXECUTION_CONTRACT",
        "kernel.mutate: stateOperation must provide prepare and apply",
        { field: "stateOperation" },
      );
    }
  } else {
    validateProvider(provider);
  }
  return operationLabel(request);
}

/**
 * Freeze a provider plan before policy and apply receive it.
 *
 * The returned object has the same shape and freezing semantics as the
 * historical inlined preparation in kernel/mutate.mjs.
 */
export function freezePlan(prepareResult, commandName) {
  validatePlan(prepareResult, commandName);
  const plan = Object.freeze({
    target: Object.freeze({ ...prepareResult.target }),
    policyAction: prepareResult.policyAction && typeof prepareResult.policyAction === "object" && !Array.isArray(prepareResult.policyAction)
      ? prepareResult.policyAction
      : null,
    ...Object.fromEntries(
      Object.entries(prepareResult).filter(([key]) => key !== "target" && key !== "policyAction"),
    ),
  });

  // The spread above loses frozenness on inner objects; let apply get a
  // frozen copy of any extra fields too.
  const frozenExtras = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === "target") continue;
    frozenExtras[key] = (value && typeof value === "object") ? Object.freeze(value) : value;
  }
  return Object.freeze({ ...frozenExtras, target: plan.target });
}

// Named aliases make the coordinator's boundary explicit while retaining
// concise names for existing internal consumers.
export { commandLabel, operationLabel };
