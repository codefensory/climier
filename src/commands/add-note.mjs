// add-note: append a timestamped comment to a task or v2 node's notes thread. Any status.
// Notes are append-only by design — they are a record, not a state mutation.
//
// T-plugin-policy-seam-lifecycle / ADR-008 §"note.add":
//   - Action: `note.add`.
//   - The seam runs INSIDE the lock and BEFORE the mutation. A deny or
//     error short-circuits the write; no state mutation, no log entry.
//   - allow / abstain → default core (append the note + log entry).
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["as"];

export default async function addNote({ statePath, flags, positional, pluginId }) {
  const [id, ...rest] = positional;
  if (!id) {
    throwV2(
      "MISSING_FIELD",
      "add-note: node id required (e.g. add-note T1 'found a blocker')",
      { field: "id" },
    );
  }
  const text = rest.join(" ").trim();
  if (!text) {
    throwV2(
      "MISSING_FIELD",
      "add-note: note text required (e.g. add-note T1 '...')",
      { field: "text" },
    );
  }
  // F8: agent resolution sits at the end of the validation chain so the
  // caller sees bad-data errors (MISSING_FIELD) before identity errors.
  const as = resolveAgent(flags, "add-note");
  const projectDir = statePath;
  // Preserve historical strict --as requirement: the previous
  // implementation threw when --as was absent regardless of
  // CLIMIER_AGENT. The seam relies on resolveAgent (which honors
  // CLIMIER_AGENT) so callers that want env-based identity on other
  // v2 commands keep working, but add-note's CLI contract still
  // requires --as. The check is duplicated here on purpose — it is
  // a CLI contract, not an identity contract.
  if (!flags || typeof flags.as !== "string" || !flags.as.trim()) {
    throw new Error("add-note: --as <agent> required");
  }

  // ADR-007 §"Discovery global" item 5: re-load policy every call so
  // install/uninstall changes are observed immediately.
  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throwV2("NODE_NOT_FOUND", "add-note: state file missing; run `climier init` first", { projectDir });

    const note = { ts: new Date().toISOString(), agent: as, text };

    if (isV2State(s)) {
      const node = s.nodes[id];
      if (!node) throwV2("NODE_NOT_FOUND", `add-note: node ${id} not found`, { id });

      // Build snapshot + target for the seam. The snapshot is a
      // fresh view over the read state; plugins cannot mutate it.
      const target = {
        id: node.id,
        kind: node.kind,
        subkind: node.subkind,
        status: node.status,
        note_length: text.length,
      };
      const snapshot = {
        state: s,
        nodes: { ...s.nodes },
        edges: s.edges.slice(),
        initiatives: { ...s.initiatives },
      };

      const decision = await authorizeAction({
        policy,
        action: "note.add",
        actor: as,
        target,
        snapshot,
        projectDir,
        projectConfig: policy ? policy.projectConfig : {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy && policy.pluginId ? policy.pluginId : "(unknown)",
          "note.add",
          as,
          decision.reason || "denied by policy",
        );
      }
      // allow / abstain → proceed (default core: append the note).

      const updated = await updateState(projectDir, (st) => {
        st.nodes[id].notes = st.nodes[id].notes || [];
        st.nodes[id].notes.push(note);
        return st;
      });
      await appendWithContext(
        projectDir,
        { agent: as, action: "add-note", node: id, note: text },
        { pluginId },
      );
      return { node: updated.nodes[id] };
    }

    const t = s.tasks[id];
    if (!t) throwV2("NODE_NOT_FOUND", `add-note: task ${id} not found`, { id });

    // Build snapshot + target for the seam (v1 shape is preserved for
    // backwards compatibility; v1 states are rejected at readState but
    // the path still exists in case the project is in a degraded
    // transitional shape).
    const target = {
      id: t.id,
      kind: "task",
      status: t.status,
      note_length: text.length,
    };
    const snapshot = {
      state: s,
      nodes: { ...(s.nodes || {}) },
      edges: s.edges.slice(),
      initiatives: { ...(s.initiatives || {}) },
    };
    const decision = await authorizeAction({
      policy,
      action: "note.add",
      actor: as,
      target,
      snapshot,
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "note.add",
        as,
        decision.reason || "denied by policy",
      );
    }

    const updated = await updateState(projectDir, (st) => {
      st.tasks[id].notes = st.tasks[id].notes || [];
      st.tasks[id].notes.push(note);
      return st;
    });
    await appendWithContext(
      projectDir,
      { agent: as, action: "add-note", task: id, note: text },
      { pluginId },
    );
    return { task: updated.tasks[id] };
  });
}
