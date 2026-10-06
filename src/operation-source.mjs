import { createLocalOperationSource } from "./application/local-operation-source.mjs";
import {
  authorizeAction as defaultAuthorizeAction,
  loadApplicablePolicy as defaultLoadApplicablePolicy,
} from "./plugins/policy.mjs";

export function createOperationSource({ source, registry, mutate, loadPolicy, authorize, pluginId } = {}) {
  return createLocalOperationSource(source, {
    registry,
    mutate,
    loadApplicablePolicy: loadPolicy ?? defaultLoadApplicablePolicy,
    authorizeAction: authorize ?? defaultAuthorizeAction,
    pluginId,
  });
}

export const getOperationSource = createOperationSource();
