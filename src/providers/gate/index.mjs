// src/providers/gate/index.mjs — public surface of the gate provider.
//
// ADR-012 §3: `src/providers/gate/*` owns gate resolution and supersedence.
// This slice (plan §B4-gate-core + §B4-gate-lifecycle) ships `gate.create`
// (including multi-node supersede) and the lifecycle operations
// `gate.resolve`, `gate.reopen`, `gate.cancel`.
//
// The registry builder (B6A) consumes `gateProviders` to produce entries
// shaped `{ id, provider, kind }`; nothing here imports the registry, the
// kernel mutation frontier, adapters, commands, the CLI or the UI.

import {
  gateCreateProvider,
  prepare as prepareGateCreate,
  apply as applyGateCreate,
  GATE_STATUSES,
  GATE_CREATE_POLICY_ACTION,
  GATE_CREATE_LOG_ACTION,
  GATE_SUPERSEDE_LOG_ACTION,
} from "./create.mjs";

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
  isSatisfiedByGraph,
  diffReadyByGate,
} from "./lifecycle.mjs";

export {
  gateCreateProvider,
  prepareGateCreate,
  applyGateCreate,
  gateResolveProvider,
  gateReopenProvider,
  gateCancelProvider,
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
};

export const GATE_PROVIDER_KIND = "gate";

// Operation id -> provider. Frozen so consumers cannot register extra
// operations at runtime (ADR-012 §5: the registry is process configuration
// built from versioned code, not project state). `gate.create` was shipped
// in §B4-gate-core; lifecycle operations land in §B4-gate-lifecycle and
// continue to share the same `gateProviders` map.
export const gateProviders = Object.freeze({
  "gate.create": gateCreateProvider,
  [GATE_RESOLVE_OP]: gateResolveProvider,
  [GATE_REOPEN_OP]: gateReopenProvider,
  [GATE_CANCEL_OP]: gateCancelProvider,
});
