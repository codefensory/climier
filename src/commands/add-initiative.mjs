// add-initiative: register an initiative with description.
// v1 contract: silent overwrite on duplicate (legacy idempotent use).
// v2 contract: reject duplicate names with ID_CONFLICT (the design doc
// mandates pre-registration; F3 enforces it).
import { updateState, isV2State } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

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

export default async function addInitiative({ statePath, flags, positional }) {
  const [name] = positional;
  validateName(name);
  // F8: agent resolution sits at the end of the validation chain so the
  // caller sees bad-data errors (MISSING_FIELD / INVALID_NAME) before identity
  // errors. Same precedence for v1 and v2 — add-initiative is the only
  // command that mutates the initiatives collection in either version.
  resolveAgent(flags, "add-initiative");
  const projectDir = statePath;
  const desc = typeof flags.desc === "string" ? flags.desc : "";

  return withLock(projectDir, async () => {
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
