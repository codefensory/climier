// F11 — v2 cancel: terminate a node without resolving it.
//
// Behaviour:
//   - Allowed when node.status is "open" or "in_progress".
//   - Authority: claim owner OR orchestrator/recovery. For an unclaimed
//     node (status=open) only orchestrator/recovery can cancel.
//   - status -> "canceled", claim cleared, revision++. Log with reason.
//   - Anything else (done, resolved, canceled, superseded, deprecated,
//     backlog): INVALID_STATUS with allowed=["open","in_progress"].
//   - Non-resolvable nodes: INVALID_STATUS.
//
// bin/climier.mjs routes to this module when state.version === 2.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = ["as", "reason"];

const ALLOWED_STATUSES = ["open", "in_progress"];

function readReason(flags, positional) {
  if (typeof flags.reason === "string" && flags.reason.trim()) return flags.reason.trim();
  return positional.slice(1).join(" ").trim();
}

export default async function cancelV2({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "cancel: node id required", { field: "id" });
  const reason = readReason(flags, positional);
  if (!reason) throwV2("MISSING_FIELD", "cancel: --reason required", { field: "reason" });
  const projectDir = statePath;
  const as = resolveAgent(flags, "cancel");

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("cancel: state file missing");
    if (!isV2State(s)) {
      throw new Error("cancel: v1 state is not supported by v2 cancel");
    }
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `cancel: node ${id} not found`, { id });
    if (node.kind !== "resolvable") {
      throwV2(
        "INVALID_STATUS",
        `cancel: node ${id} is not resolvable (kind=${node.kind})`,
        { id, kind: node.kind },
      );
    }
    const status = node.status || "open";
    if (!ALLOWED_STATUSES.includes(status)) {
      throwV2(
        "INVALID_STATUS",
        `cancel: node ${id} cannot be canceled from status ${status}`,
        { id, current: status, allowed: ALLOWED_STATUSES },
      );
    }
    const isOrchestrator = as === "orchestrator" || as === "recovery";
    const ownerBy = node.claim && node.claim.by;
    const isOwner = ownerBy === as;
    if (!isOrchestrator && !isOwner) {
      throwV2(
        "NOT_OWNER",
        `cancel: node ${id} is not yours (no claim by ${as})`,
        { id, owner: ownerBy || null },
      );
    }
    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      target.status = "canceled";
      target.claim = null;
      target.revision = (target.revision || 0) + 1;
      return st;
    });
    await append(projectDir, { agent: as, action: "cancel", node: id, note: reason });
    return { node: updated.nodes[id] };
  });
}