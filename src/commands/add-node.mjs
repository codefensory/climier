// add-node: low-level escape hatch for creating v2 nodes.
//
// T-graph-kernel-adapters-wave1 — the handler is now a thin adapter
// over the kernel mutation frontier (`kernel.mutate` + the relevant
// create provider). The adapter parses argv, resolves the policy
// outside the lock, and hands control to the kernel, which owns the
// lock, the snapshot read, the precondition check, the policy
// authorize, the draft mutation, the diff/revision computation and
// the single atomic state + log write. The handler itself never
// imports withLock, updateState, appendWithContext, or edits
// `revision` directly; the only mutating call is `kernel.mutate`.
//
// Provider routing:
//   - kind=resolvable + subkind=task  → taskCreateProvider
//   - kind=resolvable + subkind=gate  → gateCreateProvider
//   - kind=knowledge                  → knowledgeCreateProvider
//
// Internal capability (ADR-008 §"Capacidad interna"):
//   addNodeInternal({ allowUnregisteredInitiative: true }) sets
//   `allow_unregistered_initiative: true` on the provider input so
//   recovery / migration tooling can seed nodes before the matching
//   initiative exists. The flag is NOT in `knownFlags`, so the CLI
//   surface rejects it as unknown. The flag IS forwarded by
//   `addNodeInternal` (src/commands/internal/create-node.mjs) which is the only
//   sanctioned caller.
//
// Defaults:
//   add-node is a low-level adapter; the public contract accepts a
//   minimal flag set (title + initiative + edges). The strict built-in
//   providers require body / acceptance / purpose, so the adapter fills
//   those with non-empty placeholders derived from the title when the
//   caller omits them. The high-level wrappers `add-task`, `add-gate`
//   and `add-knowledge` enforce their own required-field contract via
//   `requireFields` before reaching this handler.
//
// Errors (`MISSING_FIELD`, `INVALID_ID`, `ID_CONFLICT`,
// `INITIATIVE_NOT_FOUND`, `REVISION_CONFLICT`, `POLICY_DENIED`,
// `INVALID_EXECUTION_CONTRACT`, `INVALID_EDGE_KIND`,
// `INVALID_EDGE_TARGET`, `DUPLICATE_EDGE`, `SELF_EDGE`, …) propagate
// verbatim from the provider / kernel so existing consumers and tests
// keep their structured error envelopes.

import { mutate } from "../kernel/mutate.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { validateExecution } from "../execution-contract.mjs";
import { taskCreateProvider } from "../providers/task/create.mjs";
import { gateCreateProvider } from "../providers/gate/create.mjs";
import { createProvider as knowledgeCreateProviderFactory } from "../providers/knowledge/create.mjs";

export const knownFlags = [
  "kind",
  "subkind",
  "title",
  "body",
  "refs",
  "meta",
  "initiative",
  "domain",
  "tags",
  "status",
  "resolution-mode",
  "purpose",
  "definition",
  "acceptance",
  "choice",
  "rationale",
  "knowledge-type",
  "mitigation",
  "scope-domains",
  "scope-initiatives",
  "scope-tags",
  "scope-node-ids",
  "backlog",
  "blocked-by",
  "derived-from",
  "supersedes",
  "as",
];

function csv(raw) {
  if (!raw || raw === true) return [];
  return String(raw).split(",").map((x) => x.trim()).filter(Boolean);
}

// refs — the strict built-in providers expect a CSV string (or array of
// strings) and wrap each target as `{ type: "external", target }` inside
// `buildNode`. The adapter forwards the raw flag value so the provider
// owns the normalisation.
function refs(raw) {
  return raw;
}

function parseMeta(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("add-node: --meta requires a JSON object value");
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`add-node: --meta must be valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("add-node: --meta must be a JSON object");
  }
  // Validate meta.execution when present. validateExecution re-throws
  // with INVALID_EXECUTION_CONTRACT so callers can branch on it;
  // other top-level keys are preserved unchanged so historical meta
  // round-trips.
  return validateExecution(parsed);
}

function parseBacklog(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("add-node: --backlog requires a value (true or false)");
  const value = String(raw).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`add-node: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return value === "true";
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// nonEmptyString — returns the value when it's a non-empty string,
// otherwise the supplied default. Used to default body/acceptance/
// purpose to non-empty placeholders before delegating to the strict
// built-in providers (the providers reject empty strings as
// MISSING_FIELD; the wrappers enforce richer requirements before
// reaching this handler).
function nonEmptyString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function policyAdapter(policy, projectDir, actor) {
  if (!policy) return null;
  return {
    pluginId: policy.pluginId,
    decide: async ({ snapshot, target, request, action }) => {
      const decision = await authorizeAction({
        policy,
        action,
        actor,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
      return decision;
    },
  };
}

function pickProviderAndInput(id, kind, subkind, flags, { allowUnregistered }) {
  if (kind === "resolvable" && subkind === "task") {
    const title = flags.title;
    const input = {
      id,
      title,
      body: nonEmptyString(flags.body, title),
      acceptance: nonEmptyString(flags.acceptance, "(acceptance TBD)"),
      status: optionalString(flags.status),
      initiative: optionalString(flags.initiative),
      domain: optionalString(flags.domain),
      tags: csv(flags.tags),
      refs: refs(flags.refs),
      definition: optionalString(flags.definition),
      blocked_by: typeof flags["blocked-by"] === "string" ? flags["blocked-by"] : "",
      derived_from: typeof flags["derived-from"] === "string" ? flags["derived-from"] : "",
      backlog: parseBacklog(flags.backlog) === true,
      allow_unregistered_initiative: allowUnregistered === true,
      // F9: meta is the TDD pin for fix9 — add-node task input
      // includes meta and the task provider preserves it on the seed.
      meta: parseMeta(flags.meta),
    };
    return { provider: taskCreateProvider, input, policyActionName: "task.create" };
  }
  if (kind === "resolvable" && subkind === "gate") {
    const title = flags.title;
    const status = optionalString(flags.status);
    // The gate provider requires a complete (choice, rationale) pair
    // when choice is provided OR when status='resolved'. The low-level
    // add-node adapter defaults both when missing so the public CLI
    // escape hatch stays usable without forcing callers to spell out
    // every half of a resolution. Defaults are derived from the title
    // so the persisted node never carries a literal placeholder that
    // could be mistaken for a real decision.
    const choice = optionalString(flags.choice)
      || (status === "resolved" ? title : undefined);
    const rationale = optionalString(flags.rationale)
      || (choice ? "(rationale TBD)" : undefined);
    const input = {
      id,
      initiative: optionalString(flags.initiative),
      title,
      body: nonEmptyString(flags.body, title),
      purpose: nonEmptyString(flags.purpose, "decision"),
      resolution_mode: optionalString(flags["resolution-mode"]),
      status,
      domain: optionalString(flags.domain),
      tags: csv(flags.tags),
      refs: refs(flags.refs),
      meta: parseMeta(flags.meta),
      definition: optionalString(flags.definition),
      acceptance: optionalString(flags.acceptance),
      choice,
      rationale,
      blocked_by: csv(flags["blocked-by"]),
      derived_from: csv(flags["derived-from"]),
      supersedes: optionalString(flags.supersedes),
      backlog: parseBacklog(flags.backlog) === true,
      allow_unregistered_initiative: allowUnregistered === true,
    };
    return { provider: gateCreateProvider, input, policyActionName: "gate.create" };
  }
  // knowledge
  const title = flags.title;
  // The strict knowledge provider rejects empty scopes. The low-level
  // add-node adapter is a documented escape hatch and historically
  // tolerated an unscoped knowledge node; the wrapper `add-knowledge`
  // still enforces the contract via `requireFields` before reaching
  // this handler. Default to a single placeholder tag when the
  // caller omits every scope-* flag so the node can still be created
  // (e.g. for low-level edge-validation scenarios).
  const scope = {
    domains: csv(flags["scope-domains"]),
    initiatives: csv(flags["scope-initiatives"]),
    tags: csv(flags["scope-tags"]),
    node_ids: csv(flags["scope-node-ids"]),
  };
  const scopeHasAny =
    scope.domains.length > 0
    || scope.initiatives.length > 0
    || scope.tags.length > 0
    || scope.node_ids.length > 0;
  if (!scopeHasAny) scope.tags = ["(uncategorized)"];
  const input = {
    id,
    initiative: optionalString(flags.initiative),
    title,
    body: nonEmptyString(flags.body, title),
    status: optionalString(flags.status),
    knowledge_type: optionalString(flags["knowledge-type"]),
    mitigation: optionalString(flags.mitigation),
    scope,
    domain: optionalString(flags.domain),
    tags: csv(flags.tags),
    refs: refs(flags.refs),
    meta: parseMeta(flags.meta),
    supersedes: optionalString(flags.supersedes),
    allow_unregistered_initiative: allowUnregistered === true,
  };
  return {
    provider: knowledgeCreateProviderFactory(),
    input,
    policyActionName: "knowledge.create",
  };
}

export default async function addNode({ statePath, flags, positional, pluginId }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "add-node: node id required", { field: "id" });
  if (!flags.kind) throwV2("MISSING_FIELD", "add-node: --kind required", { field: "kind" });
  if (!flags.title) throwV2("MISSING_FIELD", "add-node: --title required", { field: "title" });
  const projectDir = statePath;
  const kind = String(flags.kind);
  const subkind = flags.subkind ? String(flags.subkind) : undefined;

  if (kind === "resolvable") {
    if (!subkind || !["task", "gate"].includes(subkind)) {
      throwV2("MISSING_FIELD", "add-node: resolvable nodes require --subkind task|gate", { field: "subkind" });
    }
  } else if (kind !== "knowledge") {
    throw new Error(`add-node: --kind must be 'resolvable' or 'knowledge' (got '${kind}')`);
  }

  // Reject --supersedes on task subkind early so MISSING_FIELD /
  // INVALID_EDGE_KIND surface before the kernel opens the lock.
  if (flags.supersedes !== undefined && subkind === "task") {
    throwV2(
      "INVALID_EDGE_KIND",
      "add-node: --supersedes is only valid for gates and knowledge",
      { from: id, to: String(flags.supersedes).trim(), type: "SUPERSEDES", fromKind: "task" },
    );
  }

  // F8: resolve the agent AFTER data validation but BEFORE the seam,
  // so MISSING_AGENT surfaces after MISSING_FIELD / INVALID_EDGE_KIND.
  const agent = resolveAgent(flags, "add-node");

  // Internal capability flag (only settable by `addNodeInternal` in
  // src/commands/internal/create-node.mjs, which is the sole sanctioned caller).
  const allowUnregistered =
    flags["allow-unregistered-initiative"] === true ||
    flags["allow-unregistered-initiative"] === "true";

  // Public path: kernel adapter. The strict built-in providers own
  // validation; this handler never falls back to a local withLock
  // path. pickProviderAndInput defaults empty body/acceptance/purpose
  // to non-empty placeholders derived from the title.
  const { provider, input, policyActionName } = pickProviderAndInput(
    id,
    kind,
    subkind,
    flags,
    { allowUnregistered },
  );

  // Load policy outside the lock (ADR-008 §"Seam por handler").
  const policy = await loadApplicablePolicy({ projectDir });

  // Log action matches the legacy surface: `add-node` for plain
  // creates, `supersede` when the new node replaces an existing one.
  const logAction = input.supersedes ? "supersede" : "add-node";

  const policyAction = policy
    ? { ...policyAdapter(policy, projectDir, agent), action: policyActionName }
    : null;

  const result = await mutate({
    projectDir,
    request: { action: logAction, actor: agent, input },
    provider,
    policyAction,
    pluginId,
  });

  // Map the kernel response to the legacy `{ node }` envelope. The
  // diff carries the persisted node (with revision assigned); if the
  // provider also returned a `node` in `result`, prefer that for
  // projection consistency with the gate provider's contract.
  let node = null;
  if (Array.isArray(result.diff.created) && result.diff.created.length > 0) {
    node = result.diff.created[0].node;
  } else if (result.result && result.result.node) {
    node = result.result.node;
  } else if (result.result && typeof result.result.id === "string") {
    node = result.result;
  }
  return { node };
}
