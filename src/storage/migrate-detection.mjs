import { classifyStateShape } from "./state.mjs";

export function detectMigrationState(state, { hasLedger = false } = {}) {
  const shape = classifyStateShape(state);
  const version = state?.version ?? null;
  let form;
  let error;

  if (shape.kind === "pre-release") {
    form = "pre-release";
  } else if (shape.kind === "legacy" && [2, 3, 4].includes(version)) {
    form = `legacy-v${version}`;
    if (hasLedger) error = "legacy state unexpectedly has a revision ledger";
  } else if (shape.kind === "fenced-legacy" && version === 5) {
    form = "fenced-legacy";
    if (!hasLedger) error = "fenced state is missing revision-ledger.json";
  } else if (shape.kind === "canonical" && version === 1) {
    form = "canonical";
    if (!hasLedger) error = "canonical state is missing revision-ledger.json";
  } else {
    form = shape.kind;
    error = `unsupported migration source shape: ${shape.kind}`;
  }

  const nodes = state?.nodes && typeof state.nodes === "object" && !Array.isArray(state.nodes)
    ? Object.keys(state.nodes).length
    : 0;
  const logEntries = Array.isArray(state?.log) ? state.log.length : 0;
  return {
    form,
    source_version: version,
    nodes,
    log_entries: logEntries,
    ...(error ? { error } : {}),
  };
}
