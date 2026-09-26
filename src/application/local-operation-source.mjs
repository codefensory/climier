// Local operation composition is deliberately lazy so selecting remote does
// not load the kernel, policy implementation, or built-in provider catalog.
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

/** Create a memoized source getter for one selected local backend. */
export function createLocalOperationSource(source) {
  let sourcePromise;
  return () => {
    if (source !== undefined) return Promise.resolve(source);
    if (!sourcePromise) sourcePromise = buildLocalOperationSource();
    return sourcePromise;
  };
}

export default createLocalOperationSource;
