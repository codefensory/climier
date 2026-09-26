// add-note: append a timestamped comment to a node's notes thread.
//
// This command is a CLI adapter. The note provider validates and applies the
// domain operation; kernel.mutate owns the lock, snapshot, CAS, revisions,
// audit log and atomic persistence. The request action remains `add-note` so
// the historical CLI log contract is preserved (the plugin API uses
// `note.add`).
import { bootstrapBuiltins, executeOperation } from "../../application/operations/index.mjs";
import { mutate } from "../../kernel/mutate.mjs";
import { noteAddProvider } from "../../providers/core/note.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { loadApplicablePolicy, authorizeAction } from "../../plugins/policy.mjs";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

function withCliProvider(source) {
  return {
    ...source,
    registry: {
      ...source.registry,
      lookup(id) {
        const entry = source.registry.lookup(id);
        return id === "note.add" && entry ? { ...entry, provider: cliNoteProvider() } : entry;
      },
    },
  };
}

const REGISTRY = bootstrapBuiltins();

export const knownFlags = ["as", "if-revision"];

function noteProviderSnapshot(snapshot, node, id) {
  if (!node || Number.isInteger(node.revision)) {return snapshot;}
  return {
    ...snapshot,
    nodes: { ...snapshot.nodes, [id]: { ...node, revision: 1 } },
  };
}

function noteProviderTarget(plan, node, text) {
  if (!node) {return plan.target;}
  return {
    ...plan.target,
    kind: node.kind,
    subkind: node.subkind,
    status: node.status,
    note_length: text.length,
  };
}

function hasNodeRevision(node) {
  return Number.isInteger(node && node.revision);
}

function providerRevision(input, node) {
  if (input.if_revision !== undefined) {return input.if_revision;}
  return hasNodeRevision(node) ? node.revision : 1;
}

function noteCompatibilityPlan(node, hasExplicitRevision) {
  if (hasNodeRevision(node) || hasExplicitRevision) {return {};}
  return { if_revision: undefined };
}

async function prepareCliNote({ snapshot, input, request }) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[input.id] : null;
  const hasExplicitRevision = input.if_revision !== undefined;
  // The public CLI historically had no revision flag. For that legacy
  // surface, derive the CAS from the fresh kernel snapshot. This remains
  // atomic because prepare and apply execute under the same lock. A few
  // old v2 fixtures predate node revisions; preserve their compatibility
  // by allowing that one case to use the trusted no-CAS path.
  const providerInput = { ...input, if_revision: providerRevision(input, node) };
  // Some pre-revision v2 fixtures are still valid state files. Give the
  // provider the compatibility revision only for its local validation;
  // the real snapshot remains the one passed to kernel.mutate/apply.
  const providerSnapshot = noteProviderSnapshot(snapshot, node, input.id);
  const plan = await noteAddProvider.prepare({
    snapshot: providerSnapshot,
    input: providerInput,
    request: { ...request, input: providerInput },
  });
  request.action = "add-note";
  return {
    ...plan,
    target: noteProviderTarget(plan, node, input.text),
    logAction: "add-note",
    // Legacy fixtures without a revision cannot satisfy the kernel CAS
    // check. Their provider validation still checks the target, and the
    // kernel assigns the first revision when the note is persisted.
    ...noteCompatibilityPlan(node, hasExplicitRevision),
    logFields: { note: input.text },
  };
}

function cliNoteProvider() {
  return {
    prepare: prepareCliNote,
    apply(args) {
      return noteAddProvider.apply(args);
    },
  };
}

function notePolicyAction(policy, projectDir) {
  if (!policy) {return null;}
  return {
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
  };
}

function localNoteSource({ source, policy, projectDir, pluginId }) {
  return withCliProvider(source || {
    registry: REGISTRY,
    mutate,
    selectPolicy: async () => policy,
    policyAction: notePolicyAction(policy, projectDir),
    authorizeAction,
    pluginId,
  });
}

async function addRemoteNote(backendClient, actor, input, id) {
  const mutation = await executeRemoteDomain({ backendClient, actor, operation: "note.add", input, command: "add-note" });
  return { node: nodeFromMutation(mutation, id) || mutation.result?.node || null };
}

function noteEnvelope(result, id) {
  const updated = result.diff.updated.find((entry) => entry.id === id);
  return { node: updated ? updated.node : null };
}

function noteInput(id, text, flags) {
  const input = { id, text };
  if (flags["if-revision"] !== undefined) {input.if_revision = flags["if-revision"];}
  return input;
}

function validateNoteArgs(positional) {
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
  return { id, text };
}

function requiredNoteActor(flags) {
  const actor = resolveAgent(flags, "add-note");
  if (typeof flags.as !== "string" || !flags.as.trim()) {
    throw new Error("add-note: --as <agent> required");
  }
  return actor;
}

async function addLocalNote({ projectDir, actor, input, id, source, pluginId }) {
  const policy = source ? null : await loadApplicablePolicy({ projectDir });
  const result = await executeOperation({
    projectDir,
    actor,
    operation: "note.add",
    input,
    source: localNoteSource({ source, policy, projectDir, pluginId }),
  });
  return noteEnvelope(result, id);
}

export default async function addNote({ statePath, projectDir: suppliedProjectDir, flags = {}, positional = [], pluginId, backendClient, source }) {
  const { id, text } = validateNoteArgs(positional);
  const actor = requiredNoteActor(flags);
  const projectDir = suppliedProjectDir || statePath;
  const input = noteInput(id, text, flags);
  if (backendClient?.type === "remote") {return addRemoteNote(backendClient, actor, input, id);}
  return addLocalNote({ projectDir, actor, input, id, source, pluginId });
}