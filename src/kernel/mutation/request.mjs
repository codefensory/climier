// Kernel mutation request contracts.
//
// This module owns the small, shared validation boundary at the kernel entry
// point. It deliberately has no filesystem or provider dependencies: callers
// can validate requests and plans before entering the mutation coordinator.

import { throwV2 } from "../../contracts/errors.mjs";

/** Return the stable operation label used in kernel errors. */
export function operationLabel(request) {
  return request && typeof request.action === "string" && request.action.length > 0
    ? `kernel.mutate(${request.action})`
    : "kernel.mutate";
}

// Compatibility alias for callers using the earlier helper name.
export const commandLabel = operationLabel;

export function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request must be an object", { field: "request" });
  }
  if (typeof request.action !== "string" || request.action.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.action is required", { field: "action" });
  }
  if (typeof request.actor !== "string" || request.actor.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.actor is required", { field: "actor" });
  }
  if (request.input !== undefined && (request.input === null || typeof request.input !== "object" || Array.isArray(request.input))) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.input must be an object when present", { field: "input" });
  }
}

export function validateProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider must be an object", { field: "provider" });
  }
  if (typeof provider.prepare !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider.prepare must be a function", { field: "prepare" });
  }
  if (typeof provider.apply !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: provider.apply must be a function", { field: "apply" });
  }
}

export function validatePlan(plan, commandName) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: prepare must return a plan object`, { field: "plan" });
  }
  if (!plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target must be an object`, { field: "target" });
  }
  if (typeof plan.target.id !== "string" || plan.target.id.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target.id must be a non-empty string`, { field: "target.id" });
  }
}
