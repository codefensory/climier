// add-task: append a new task node to the v2 state.
//
// The id is either explicit (positional) or auto-allocated as
// `T-xxxxxxxx` (8-char random suffix). Required fields:
// --initiative, --title, --body, --acceptance, --blocked-by.
import { addV2Node, requireFields } from "../v2-add-node.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = [
  "initiative",
  "title",
  "body",
  "acceptance",
  "blocked-by",
  "supersedes",
  "derived-from",
  "domain",
  "tags",
  "refs",
  "meta",
  "allow-unregistered-initiative",
  "as",
];

export default async function addTask({ statePath, flags, positional, projectDir }) {
  if (flags.supersedes !== undefined) {
    throwV2(
      "INVALID_EDGE_KIND",
      "add-task: --supersedes is only valid for gates and knowledge",
      { type: "SUPERSEDES", fromKind: "task" },
    );
  }
  // Resolve here so MISSING_AGENT surfaces as `add-task:`, not as the
  // underlying add-node's name (the wrapper delegates through add-node).
  resolveAgent(flags, "add-task");
  requireFields(
    "add-task",
    flags,
    ["initiative", "title", "body", "acceptance", "blocked-by"],
    ["blocked-by"],
  );
  return addV2Node(
    "add-task",
    "T",
    { kind: "resolvable", subkind: "task" },
    { statePath, flags, positional, projectDir },
  );
}
