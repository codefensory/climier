import type { AuthorizeAction, LoadPolicy, MutateFn, OperationRegistry } from "../contracts/operations.ts";
import type { SourceInput } from "./types.ts";

type LocalSourceDependencies = {
  registry?: OperationRegistry;
  mutate?: MutateFn;
  loadApplicablePolicy?: LoadPolicy;
  authorizeAction?: AuthorizeAction;
  pluginId?: string;
};

async function buildLocalOperationSource({
  registry,
  mutate,
  loadApplicablePolicy,
  authorizeAction,
  pluginId,
}: LocalSourceDependencies = {}): Promise<SourceInput> {
  const [builtins, kernel] = await Promise.all([
    import("./operations/builtins.ts"),
    import("../kernel/mutate.ts"),
  ]);
  return Object.freeze({
    registry: registry || builtins.createBuiltinOperationRegistry(),
    mutate: mutate || (kernel.mutate as unknown as MutateFn),
    ...(loadApplicablePolicy ? { loadApplicablePolicy } : {}),
    ...(authorizeAction ? { authorizeAction } : {}),
    ...(pluginId ? { pluginId } : {}),
  });
}

export function createLocalOperationSource(source?: SourceInput, dependencies: LocalSourceDependencies = {}): () => Promise<SourceInput> {
  let sourcePromise: Promise<SourceInput> | undefined;
  return () => {
    if (source !== undefined) {return Promise.resolve(source);}
    if (!sourcePromise) {sourcePromise = buildLocalOperationSource(dependencies);}
    return sourcePromise;
  };
}

export default createLocalOperationSource;
