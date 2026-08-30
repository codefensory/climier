// add-note: append a timestamped comment to a node's notes thread.
//
// This command is a CLI adapter. The note provider validates and applies the
// domain operation; kernel.mutate owns the lock, snapshot, CAS, revisions,
// audit log and atomic persistence. The request action remains `add-note` so
// the historical CLI log contract is preserved (the plugin API uses
// `note.add`).
import { mutate } from "../kernel/mutate.mjs";
import { noteAddProvider } from "../providers/core/note.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { loadApplicablePolicy, authorizeAction } from "../policy.mjs";

export const knownFlags = ["as", "if-revision"];

function cliNoteProvider() {
  return {
    async prepare({ snapshot, input, request }) {
      const node = snapshot && snapshot.nodes ? snapshot.nodes[input.id] : null;
      const hasExplicitRevision = input.if_revision !== undefined;
      // The public CLI historically had no revision flag. For that legacy
      // surface, derive the CAS from the fresh kernel snapshot. This remains
      // atomic because prepare and apply execute under the same lock. A few
      // old v2 fixtures predate node revisions; preserve their compatibility
      // by allowing that one case to use the trusted no-CAS path.
      const revision = hasExplicitRevision
        ? input.if_revision
        : (Number.isInteger(node && node.revision) ? node.revision : 1);
      const providerInput = { ...input, if_revision: revision };
      // Some pre-revision v2 fixtures are still valid state files. Give the
      // provider the compatibility revision only for its local validation;
      // the real snapshot remains the one passed to kernel.mutate/apply.
      const providerSnapshot = node && !Number.isInteger(node.revision)
        ? {
            ...snapshot,
            nodes: { ...snapshot.nodes, [input.id]: { ...node, revision: 1 } },
          }
        : snapshot;
      const plan = await noteAddProvider.prepare({
        snapshot: providerSnapshot,
        input: providerInput,
        request: { ...request, input: providerInput },
      });
      const target = node
        ? {
            ...plan.target,
            kind: node.kind,
            subkind: node.subkind,
            status: node.status,
            note_length: input.text.length,
          }
        : plan.target;
      return {
        ...plan,
        target,
        // Legacy fixtures without a revision cannot satisfy the kernel CAS
        // check. Their provider validation still checks the target, and the
        // kernel assigns the first revision when the note is persisted.
        ...(Number.isInteger(node && node.revision) || hasExplicitRevision
          ? {}
          : { if_revision: undefined }),
        logFields: { note: input.text },
      };
    },
    apply(args) {
      return noteAddProvider.apply(args);
    },
  };
}

export default async function addNote({ statePath, flags = {}, positional, pluginId }) {
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
  // Preserve the historical explicit --as requirement. CLIMIER_AGENT remains
  // useful to resolve identity for other commands, but add-note's CLI surface
  // intentionally requires the flag.
  const as = resolveAgent(flags, "add-note");
  if (typeof flags.as !== "string" || !flags.as.trim()) {
    throw new Error("add-note: --as <agent> required");
  }

  const projectDir = statePath;
  const input = { id, text };
  if (flags["if-revision"] !== undefined) input.if_revision = flags["if-revision"];
  const policy = await loadApplicablePolicy({ projectDir });
  const policyAction = policy
    ? {
        action: "note.add",
        pluginId: policy.pluginId || null,
        decide: async ({ snapshot, target, request, action }) => authorizeAction({
          policy,
          action,
          actor: request.actor,
          target,
          snapshot,
          projectDir,
          projectConfig: policy.projectConfig || {},
        }),
      }
    : null;

  const result = await mutate({
    projectDir,
    request: { action: "add-note", actor: as, input },
    provider: cliNoteProvider(),
    policyAction,
    pluginId,
  });

  const updated = result.diff.updated.find((entry) => entry.id === id);
  return { node: updated ? updated.node : null };
}
