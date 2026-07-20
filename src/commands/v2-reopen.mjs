// F11 — v2 reopen: roll a terminal resolvable back to open.
//
// Behaviour:
//   - task (subkind=task, status=done): status -> "open", claim cleared,
//     done_by/at/note removed, revision++. Log with reason.
//   - gate (subkind=gate, status=resolved): same; resolution stays? No —
//     clearing the gate means re-deciding it, so the previous resolution
//     is removed too.
//   - Authority: original done_by (from the stored node.done_by) OR
//     orchestrator/recovery. Anyone else: NOT_OWNER.
//   - Wrong status: INVALID_STATUS.
//   - Non-resolvable nodes: INVALID_STATUS.
//
// bin/climier.mjs routes to this module when state.version === 2.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["as", "reason"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  // Fallback: accept a trailing positional reason (matches the v1 reopen
  // shape so a careless agent doesn't get a confusing MISSING_FIELD).
  const trailing = positional.slice(1).join(" ").trim();
  return trailing;
}

export default async function reopenV2({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "reopen: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  if (!reason) throwV2("MISSING_FIELD", "reopen: --reason required", { field: "reason" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "reopen");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("reopen: state file missing");
    if (!isV2State(s)) {
      throw new Error("reopen: v1 state is not supported by v2 reopen");
    }
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `reopen: node ${id} not found`, { id });
    if (node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `reopen: node ${id} is not resolvable (kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }
    const terminal = node.subkind === "task" ? "done" : "resolved";
    if (node.status !== terminal) {
      throwV2(
        "INVALID_STATUS",
        `reopen: node ${id} is not ${terminal} (status=${node.status || "open"})`,
        { id, current: node.status || "open", expected: terminal },
      );
    }
    const isOrchestrator = as === "orchestrator" || as === "recovery";
    const isSelf = node.done_by && node.done_by === as;
    if (!isOrchestrator && !isSelf) {
      throwV2(
        "NOT_OWNER",
        `reopen: node ${id} is not authorized (only done_by or orchestrator can reopen; done_by=${node.done_by || "(none)"})`,
        { id, owner: node.done_by },
      );
    }
    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.status = "open";
      target.claim = null;
      delete target.done_by;
      delete target.done_at;
      delete target.note;
      delete target.resolution;
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await append(projectDir, { agent: as, action: "reopen", node: id, note: reason });
    return { node: updated.nodes[id] };
  });
}