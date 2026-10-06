

import {
  gateCreateProvider,
  prepare as prepareGateCreate,
  apply as applyGateCreate,
  GATE_STATUSES,
  GATE_CREATE_POLICY_ACTION,
  GATE_CREATE_LOG_ACTION,
  GATE_SUPERSEDE_LOG_ACTION,
} from "./create.ts";

import { gateUpdateProvider } from "./update.ts";

import {
  gateResolveProvider,
  gateReopenProvider,
  gateCancelProvider,
  prepareGateResolve,
  prepareGateReopen,
  prepareGateCancel,
  applyGateResolve,
  applyGateReopen,
  applyGateCancel,
  GATE_RESOLVE_OP,
  GATE_REOPEN_OP,
  GATE_CANCEL_OP,
  GATE_RESOLVE_POLICY_ACTION,
  GATE_REOPEN_POLICY_ACTION,
  GATE_CANCEL_POLICY_ACTION,
  GATE_RESOLVE_LOG_ACTION,
  GATE_REOPEN_LOG_ACTION,
  GATE_CANCEL_LOG_ACTION,
  GATE_RESOLVABLE_STATUSES,
  GATE_CANCELABLE_STATUSES,
} from "./lifecycle.ts";

import {
  gateProjection,
  projectGate,
  supersededBy,
  isCurrent,
  isSatisfied,
  isSatisfiedByGraph,
  diffReadyByGate,
  taskIsReadyByGraph,
} from "./semantics.ts";

export {
  gateCreateProvider,
  prepareGateCreate,
  applyGateCreate,
  gateResolveProvider,
  gateReopenProvider,
  gateCancelProvider,
  gateUpdateProvider,
  prepareGateResolve,
  prepareGateReopen,
  prepareGateCancel,
  applyGateResolve,
  applyGateReopen,
  applyGateCancel,
  GATE_STATUSES,
  GATE_RESOLVABLE_STATUSES,
  GATE_CANCELABLE_STATUSES,
  GATE_CREATE_POLICY_ACTION,
  GATE_CREATE_LOG_ACTION,
  GATE_SUPERSEDE_LOG_ACTION,
  GATE_RESOLVE_POLICY_ACTION,
  GATE_REOPEN_POLICY_ACTION,
  GATE_CANCEL_POLICY_ACTION,
  GATE_RESOLVE_LOG_ACTION,
  GATE_REOPEN_LOG_ACTION,
  GATE_CANCEL_LOG_ACTION,
  isSatisfiedByGraph,
  diffReadyByGate,
  gateProjection,
  projectGate,
  supersededBy,
  isCurrent,
  isSatisfied,
  taskIsReadyByGraph,
};

export const GATE_PROVIDER_KIND = "gate";

// Operation id -> provider. Frozen so consumers cannot register extra

// built from versioned code, not project state). `gate.create` was shipped
// Both core and lifecycle operations share the same `gateProviders` map.
export const gateProviders = Object.freeze({
  "gate.create": gateCreateProvider,
  "gate.update": gateUpdateProvider,
  [GATE_RESOLVE_OP]: gateResolveProvider,
  [GATE_REOPEN_OP]: gateReopenProvider,
  [GATE_CANCEL_OP]: gateCancelProvider,
});
