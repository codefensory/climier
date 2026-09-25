// add-task: append a new task node to the v2 state.
//
// The id is either explicit (positional) or auto-allocated as
// `T-xxxxxxxx` (8-char random suffix). Required fields:
// --initiative, --title, --body, --acceptance, --blocked-by.
import { randomUUID } from "node:crypto";
import { addV2Node, requireFields } from "./internal/create-node.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteTask, isRemoteBackend } from "./internal/task-routing.mjs";

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

function csv(raw) {
  if (raw === undefined || raw === null || raw === true || raw === "") return [];
  return String(raw).split(",").map((value) => value.trim()).filter(Boolean);
}

function parseMeta(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("add-task: --meta requires a JSON object value");
  let meta;
  try {
    meta = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`add-task: --meta must be valid JSON (${error.message})`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("add-task: --meta must be a JSON object");
  }
  return meta;
}

export default async function addTask({ statePath, flags = {}, positional = [], projectDir, pluginId, backendClient }) {
  if (flags.supersedes !== undefined) {
    throwV2(
      "INVALID_EDGE_KIND",
      "add-task: --supersedes is only valid for gates and knowledge",
      { type: "SUPERSEDES", fromKind: "task" },
    );
  }
  // Resolve here so MISSING_AGENT surfaces as `add-task:`, not as the
  // underlying add-node's name (the wrapper delegates through add-node).
  const actor = resolveAgent(flags, "add-task");
  requireFields(
    "add-task",
    flags,
    ["initiative", "title", "body", "acceptance", "blocked-by"],
    ["blocked-by"],
  );
  if (!isRemoteBackend(backendClient)) {
    return addV2Node(
      "add-task",
      "T",
      { kind: "resolvable", subkind: "task" },
      { statePath, flags, positional, projectDir, pluginId },
    );
  }
  const id = positional[0] || `T-${randomUUID().slice(0, 8)}`;
  if (positional[0] && !/^[A-Za-z0-9_.-]+$/.test(positional[0])) {
    throwV2("INVALID_ID", `add-task: id '${positional[0]}' is invalid (must match /^[A-Za-z0-9_.-]+$/)`, {
      id: positional[0],
      pattern: "^[A-Za-z0-9_.-]+$",
      command: "add-task",
    });
  }
  const remote = isRemoteBackend(backendClient) ? await executeRemoteTask({
    backendClient,
    actor,
    operation: "task.create",
    command: "add-task",
    id,
    collection: "created",
    input: {
      id,
      initiative: flags.initiative,
      title: flags.title,
      body: flags.body,
      acceptance: flags.acceptance,
      blocked_by: csv(flags["blocked-by"]),
      backlog: flags.backlog === true || String(flags.backlog).toLowerCase() === "true",
      domain: typeof flags.domain === "string" && flags.domain.length ? flags.domain : undefined,
      definition: typeof flags.definition === "string" && flags.definition.length ? flags.definition : undefined,
      refs: csv(flags.refs),
      tags: csv(flags.tags),
      meta: parseMeta(flags.meta),
      derived_from: csv(flags["derived-from"]),
    },
  }) : null;
  if (remote) {
    if (!remote.node) throwV2("INVALID_EXECUTION_CONTRACT", `add-task: remote operation did not return node ${id}`, { id });
    return { node: remote.node };
  }
}
