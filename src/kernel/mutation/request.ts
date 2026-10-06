

import { throwV2 } from "../../contracts/errors.ts";


export function operationLabel(request) {
  return request && typeof request.action === "string" && request.action.length > 0
    ? `kernel.mutate(${request.action})`
    : "kernel.mutate";
}


export const commandLabel = operationLabel;

function validateRequestFields(request) {
  if (typeof request.action !== "string" || request.action.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.action is required", { field: "action" });
  }
  if (typeof request.actor !== "string" || request.actor.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.actor is required", { field: "actor" });
  }
}

function validateRequestInput(input) {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request.input must be an object when present", { field: "input" });
  }
}

function validateStateRevisionDeclaration(revision) {
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
    throwV2(
      "INVALID_EXECUTION_CONTRACT",
      "kernel.mutate: if_state_revision must be a non-negative integer",
      { field: "if_state_revision", value: revision },
    );
  }
}

export function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throwV2("INVALID_EXECUTION_CONTRACT", "kernel.mutate: request must be an object", { field: "request" });
  }
  validateRequestFields(request);
  validateRequestInput(request.input);
  validateStateRevisionDeclaration(request.if_state_revision);
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

function validatePlanTarget(plan, commandName) {
  if (!plan.target || typeof plan.target !== "object" || Array.isArray(plan.target)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target must be an object`, { field: "target" });
  }
  if (typeof plan.target.id !== "string" || plan.target.id.length === 0) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: plan.target.id must be a non-empty string`, { field: "target.id" });
  }
}

export function validatePlan(plan, commandName) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${commandName}: prepare must return a plan object`, { field: "plan" });
  }
  validatePlanTarget(plan, commandName);
}
