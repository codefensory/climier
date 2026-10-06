
import { addV2Node, requireFields } from "./internal/create-node.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";

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
  "as",
];

export default async function addTask({ statePath, flags = {}, positional = [], projectDir, pluginId, backendClient }) {
  if (flags.supersedes !== undefined) {
    throwV2(
      "INVALID_EDGE_KIND",
      "add-task: --supersedes is only valid for gates and knowledge",
      { type: "SUPERSEDES", fromKind: "task" },
    );
  }

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
    { statePath, flags, positional, projectDir, pluginId, backendClient },
  );
}
