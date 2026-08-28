// add-initiative: register an initiative with description.
// Duplicate names are rejected with ID_CONFLICT (F3 enforces
// pre-registration per the v2 design doc).
//
// T-plugin-policy-seam-lifecycle / ADR-008 §"initiative.create":
//   - Action: `initiative.create`.
//   - The seam runs BEFORE `updateState`. A deny or error short-circuits
//     the registration; no state mutation, no log entry.
//   - allow / abstain → default core (register the initiative; ID_CONFLICT
//     if it already exists; log entry appended on success).
import { updateState, readState, isV2State, emptyState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { appendWithContext } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";
import { PolicyDenied } from "../plugin-errors.mjs";

export const knownFlags = ["desc", "as"];

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function validateName(name) {
  if (!name) {
    throwV2(
      "MISSING_FIELD",
      "add-initiative: name required (e.g. add-initiative migration --desc 'the big move')",
      { field: "name" },
    );
  }
  if (!NAME_RE.test(name)) {
    throwV2(
      "INVALID_NAME",
      `add-initiative: name '${name}' is invalid (must match ${NAME_RE})`,
      { name, pattern: NAME_RE.source },
    );
  }
}

export default async function addInitiative({ statePath, flags, positional, pluginId }) {
  const [name] = positional;
  validateName(name);
  // F8: agent resolution sits at the end of the validation chain so the
  // caller sees bad-data errors (MISSING_FIELD / INVALID_NAME) before identity
  // errors.
  const as = resolveAgent(flags, "add-initiative");
  const projectDir = statePath;
  const desc = typeof flags.desc === "string" ? flags.desc : "";

  const policy = await loadApplicablePolicy({ projectDir });

  return withLock(projectDir, async () => {
    // Snapshot for the policy seam. The handler must NOT throw
    // "state file missing" here: callers that bootstrap an initiative
    // before `climier init` rely on `updateState`'s auto-create path.
    // When no state exists yet we still hand the plugin a v2-shaped
    // empty snapshot so plugins that only inspect shape see a valid
    // input. The snapshot reflects the persisted view so a plugin
    // can detect the name already being registered.
    const persisted = await readState(projectDir);
    const s = persisted || emptyState();

    const target = {
      id: name,
      kind: "initiative",
      desc,
      already_registered: Boolean(s.initiatives && s.initiatives[name]),
    };
    const snapshot = {
      state: s,
      nodes: { ...s.nodes },
      edges: s.edges.slice(),
      initiatives: { ...(s.initiatives || {}) },
    };

    const decision = await authorizeAction({
      policy,
      action: "initiative.create",
      actor: as,
      target,
      snapshot,
      projectDir,
      projectConfig: policy ? policy.projectConfig : {},
    });
    if (decision.decision === "deny") {
      throw new PolicyDenied(
        policy && policy.pluginId ? policy.pluginId : "(unknown)",
        "initiative.create",
        as,
        decision.reason || "denied by policy",
      );
    }
    // allow / abstain → proceed with default core (ID_CONFLICT may
    // still trigger inside updateState, matching the historical path).

    const result = await updateState(projectDir, (st) => {
      st.initiatives = st.initiatives || {};
      if (isV2State(st) && st.initiatives[name]) {
        throwV2(
          "ID_CONFLICT",
          `add-initiative: '${name}' is already registered`,
          {
            name,
            existing: {
              desc: st.initiatives[name].desc || "",
              created_at: st.initiatives[name].created_at,
            },
          },
        );
      }
      st.initiatives[name] = { desc };
      if (isV2State(st)) {
        st.initiatives[name].created_at = new Date().toISOString();
      }
      return st;
    });
    // Log entry on success. ADR-006 §"Locks y logs" / plan §4.3: this
    // closes the parity-slice gap where add-initiative omitted the log.
    // appendWithContext injects plugin_id when ctx.pluginId is set.
    await appendWithContext(
      projectDir,
      { agent: as, action: "add-initiative", node: name, desc },
      { pluginId },
    );
    if (isV2State(result)) {
      return {
        initiative: {
          name,
          desc,
          created_at: result.initiatives[name].created_at,
        },
      };
    }
    return { initiative: { name, desc } };
  });
}
