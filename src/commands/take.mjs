// `take <id>` idempotently claims exactly one v2 task.
// Legacy selection flags remain accepted but are ignored.

import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { blockingForNode, statusOfV2 } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["as", "initiative", "domain", "tag"];

function buildContext(state, id) {
  const node = state.nodes[id];
  return {
    derived_status: statusOfV2(state, id),
    revision: node.revision,
    claim: node.claim || null,
    blocking: blockingForNode(state, id),
    knowledge: [],
  };
}

export default async function take({ positional = [], flags = {}, projectDir, statePath }) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "take: node id required", { field: "id" });
  const agent = resolveAgent(flags, "take");
  const dir = projectDir || statePath;

  return withLock(dir, async () => {
    const state = await readState(dir);
    if (!state) {
      throwV2("NODE_NOT_FOUND", "take: state file missing; run `climier init --v2` first", { projectDir: dir });
    }
    if (state.version !== 2) {
      throwV2("NODE_NOT_FOUND", "take: requires a v2 state (run `climier init --v2`)", { version: state.version });
    }

    const node = state.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `take: node ${id} not found`, { id });
    if (node.kind !== "resolvable" || node.subkind !== "task") {
      throwV2("NOT_CLAIMABLE", `take: node ${id} is not a task`, {
        id,
        kind: node.kind,
        subkind: node.subkind,
      });
    }

    const status = statusOfV2(state, id);
    const owner = node.claim && node.claim.by;
    if (status === "in_progress" && owner === agent) {
      return { node, context: buildContext(state, id), freshly_claimed: false };
    }
    if (owner && owner !== agent && agent !== "orchestrator") {
      throwV2("ALREADY_CLAIMED", `take: node ${id} is claimed by ${owner}`, { id, owner });
    }

    const takeover = owner && owner !== agent && agent === "orchestrator";
    if (status !== "ready" && !(status === "in_progress" && takeover)) {
      throwV2("NOT_READY", `take: node ${id} is ${status}, not ready`, { id, status });
    }

    const at = new Date().toISOString();
    const updated = await updateState(dir, (next) => {
      const target = next.nodes[id];
      target.claim = { by: agent, at };
      target.status = "in_progress";
      target.revision = (target.revision || 0) + 1;
      return next;
    });
    await append(dir, {
      agent,
      action: "take",
      node: id,
      ...(takeover ? { previous_owner: owner } : {}),
    });

    return {
      node: updated.nodes[id],
      context: buildContext(updated, id),
      freshly_claimed: true,
    };
  });
}
