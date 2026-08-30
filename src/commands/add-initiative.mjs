// add-initiative: register an initiative with description.
// Duplicate names are rejected with ID_CONFLICT (F3 enforces
// pre-registration per the v2 design doc).
//
// This command is an adapter only. The initiative provider owns domain
// validation and the kernel owns locking, revision/diff handling, logging and
// persistence. The historical `add-initiative` action is retained in the
// request so the persisted audit stream remains compatible.
import { mutate } from "../kernel/mutate.mjs";
import { initiativeCreateProvider } from "../providers/core/initiative.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";

// T-plugin-policy-seam-lifecycle / ADR-008 §"initiative.create":
//   - policy selection happens outside the kernel lock;
//   - authorization happens inside the kernel lock against its fresh snapshot;
//   - deny means no state file, mutation or log entry.
//
// The kernel uses request.action to build its audit entry, while the built-in
// initiative provider needs the canonical operation id to opt into bootstrap.
// Restore the legacy CLI action after prepare so bootstrap remains explicit and
// the persisted audit contract stays `add-initiative` without a second write.
const cliInitiativeProvider = Object.freeze({
  ...initiativeCreateProvider,
  async prepare(args) {
    const plan = await initiativeCreateProvider.prepare(args);
    args.request.action = "add-initiative";
    return plan;
  },
});

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

export default async function addInitiative({ statePath, flags = {}, positional, pluginId }) {
  const [name] = positional;
  validateName(name);
  // F8: agent resolution sits at the end of the validation chain so the
  // caller sees bad-data errors (MISSING_FIELD / INVALID_NAME) before identity
  // errors.
  const as = resolveAgent(flags, "add-initiative");
  const projectDir = statePath;
  const desc = typeof flags.desc === "string" ? flags.desc : "";
  const policy = await loadApplicablePolicy({ projectDir });

  const policyAction = policy
    ? {
        action: "initiative.create",
        pluginId: policy.pluginId || null,
        decide: async ({ snapshot, target, request, action }) => authorizeAction({
          policy,
          action,
          actor: request.actor,
          target: {
            ...target,
            desc,
            already_registered: Boolean(snapshot.initiatives && snapshot.initiatives[name]),
          },
          snapshot,
          projectDir,
          projectConfig: policy.projectConfig || {},
        }),
      }
    : null;

  const result = await mutate({
    projectDir,
    request: {
      action: "initiative.create",
      actor: as,
      input: { name, desc },
    },
    provider: cliInitiativeProvider,
    policyAction,
    pluginId,
  });

  const created = result.diff.initiatives.created.find((entry) => entry.name === name);
  const initiative = created ? created.initiative : result.result;
  return {
    initiative: {
      name,
      desc: initiative.desc,
      ...(initiative.created_at ? { created_at: initiative.created_at } : {}),
    },
  };
}
