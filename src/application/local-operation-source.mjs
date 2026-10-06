async function buildLocalOperationSource({ registry, mutate, loadApplicablePolicy, authorizeAction, pluginId } = {}) {
  const [builtins, kernel] = await Promise.all([
    import("./operations/builtins.mjs"),
    import("../kernel/mutate.mjs"),
  ]);
  return Object.freeze({
    registry: registry || builtins.createBuiltinOperationRegistry(),
    mutate: mutate || kernel.mutate,
    ...(loadApplicablePolicy ? { loadApplicablePolicy } : {}),
    ...(authorizeAction ? { authorizeAction } : {}),
    ...(pluginId ? { pluginId } : {}),
  });
}

export function createLocalOperationSource(source, dependencies = {}) {
  let sourcePromise;
  return () => {
    if (source !== undefined) {return Promise.resolve(source);}
    if (!sourcePromise) {sourcePromise = buildLocalOperationSource(dependencies);}
    return sourcePromise;
  };
}

export default createLocalOperationSource;
