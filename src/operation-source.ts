import { createLocalOperationSource } from "./application/local-operation-source.ts";
import type { AuthorizeAction, LoadPolicy, MutateFn, OperationRegistry } from "./contracts/operations.ts";
import type { SourceInput } from "./application/types.ts";
import {
  authorizeAction as defaultAuthorizeAction,
  loadApplicablePolicy as defaultLoadApplicablePolicy,
} from "./plugins/policy.ts";

type OperationSourceOptions = {
  source?: SourceInput;
  registry?: OperationRegistry;
  mutate?: MutateFn;
  loadPolicy?: LoadPolicy | typeof defaultLoadApplicablePolicy;
  authorize?: AuthorizeAction | typeof defaultAuthorizeAction;
  pluginId?: string;
};

export function createOperationSource({ source, registry, mutate, loadPolicy, authorize, pluginId }: OperationSourceOptions = {}) {
  return createLocalOperationSource(source, {
    registry,
    mutate,
    loadApplicablePolicy: (loadPolicy ?? defaultLoadApplicablePolicy) as LoadPolicy,
    authorizeAction: (authorize ?? defaultAuthorizeAction) as AuthorizeAction,
    pluginId,
  });
}

export const getOperationSource = createOperationSource();
