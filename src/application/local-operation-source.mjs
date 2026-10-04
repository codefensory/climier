
async function buildLocalOperationSource() {
  const [builtins, kernel, policy] = await Promise.all([
    import("./operations/builtins.mjs"),
    import("../kernel/mutate.mjs"),
    import("../plugins/policy.mjs"),
  ]);
  return Object.freeze({
    registry: builtins.createBuiltinOperationRegistry(),
    mutate: kernel.mutate,
    loadApplicablePolicy: policy.loadApplicablePolicy,
    authorizeAction: policy.authorizeAction,
  });
}


export function createLocalOperationSource(source) {
  let sourcePromise;
  return () => {
    if (source !== undefined) {return Promise.resolve(source);}
    if (!sourcePromise) {sourcePromise = buildLocalOperationSource();}
    return sourcePromise;
  };
}

export default createLocalOperationSource;
