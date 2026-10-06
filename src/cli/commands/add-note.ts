
// domain operation; kernel.mutate owns the lock, snapshot, CAS, revisions,
// audit log and atomic persistence. The request action remains `add-note` so

import { executeOperation } from "../../application/operations/index.ts";
import { getOperationSource } from "../../operation-source.ts";
import { noteAddProvider } from "../../providers/core/note.ts";
import { throwV2 } from "../../contracts/errors.ts";
import { resolveAgent } from "../actor.ts";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.ts";

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

async function prepareCliNote({ snapshot, input, request }) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[input.id] : null;

  // surface, derive the CAS from the fresh kernel snapshot. This remains
  // atomic because prepare and apply execute under the same lock. A few

  // by allowing that one case to use the trusted no-CAS path.
  const providerInput = { ...input, if_revision: providerRevision(input, node) };

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

async function localNoteSource({ source, pluginId }) {
  const operationSource = source || await getOperationSource();
  return withCliProvider({ ...operationSource, ...(pluginId ? { pluginId } : {}) });
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
  const result = await executeOperation({
    projectDir,
    actor,
    operation: "note.add",
    input,
    source: await localNoteSource({ source, pluginId }),
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
