// `update <id>` CLI adapter for the canonical task/gate/knowledge providers.
//
// The CLI keeps its historical flags and envelopes. This module only parses
// those flags into typed provider input, selects the provider from the fresh
// kernel snapshot, and delegates the mutation to kernel.mutate. Locking,
// persistence, revision assignment, logging and policy execution remain
// kernel responsibilities.
import { mutate } from "../kernel/mutate.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";
import { validateExecution } from "../execution-contract.mjs";
import { loadApplicablePolicy, authorizeAction } from "../plugins/policy.mjs";
import { PolicyDenied } from "../plugins/errors.mjs";
import { taskUpdateProvider } from "../providers/task/update.mjs";
import { gateUpdateProvider } from "../providers/gate/update.mjs";
import { updateProvider as knowledgeUpdateProvider } from "../providers/knowledge/update.mjs";

export const knownFlags = [
  "title",
  "body",
  "initiative",
  "domain",
  "tags",
  "refs",
  "meta",
  "definition",
  "acceptance",
  "backlog",
  "purpose",
  "resolution-mode",
  "knowledge-type",
  "mitigation",
  "scope-domains",
  "scope-initiatives",
  "scope-tags",
  "scope-node-ids",
  "if-revision",
  "as",
];

function csv(raw) {
  if (!raw || raw === true) return [];
  return String(raw).split(",").map((value) => value.trim()).filter(Boolean);
}

function refs(raw) {
  return csv(raw).map((target) => ({ type: "external", target }));
}

function parseMeta(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --meta requires a JSON object value");
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`update: --meta must be valid JSON (${error.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("update: --meta must be a JSON object");
  }
  return validateExecution(parsed);
}

function parseBacklog(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --backlog requires a value (true or false)");
  const value = String(raw).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`update: --backlog must be 'true' or 'false' (got '${raw}')`);
  }
  return value === "true";
}

function parseIfRevision(raw) {
  if (raw === undefined) return undefined;
  if (raw === true) throw new Error("update: --if-revision requires a numeric value");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`update: --if-revision must be a positive integer (got '${raw}')`);
  }
  return value;
}

const SCALAR_FLAGS = [
  "title",
  "body",
  "initiative",
  "domain",
  "definition",
  "acceptance",
  "purpose",
  "mitigation",
];

function buildChanges(flags) {
  const changes = {};
  for (const field of SCALAR_FLAGS) {
    if (flags[field] === undefined) continue;
    if (flags[field] === true) throw new Error(`update: --${field} requires a value`);
    changes[field] = flags[field];
  }

  if (flags["resolution-mode"] !== undefined) {
    if (flags["resolution-mode"] === true) throw new Error("update: --resolution-mode requires a value");
    changes.resolution_mode = flags["resolution-mode"];
  }
  if (flags["knowledge-type"] !== undefined) {
    if (flags["knowledge-type"] === true) throw new Error("update: --knowledge-type requires a value");
    changes.knowledge_type = flags["knowledge-type"];
  }
  if (flags.tags !== undefined) {
    if (flags.tags === true) throw new Error("update: --tags requires a value");
    changes.tags = csv(flags.tags);
  }
  if (flags.refs !== undefined) {
    if (flags.refs === true) throw new Error("update: --refs requires a value");
    changes.refs = refs(flags.refs);
  }
  if (flags.meta !== undefined) changes.meta = parseMeta(flags.meta);

  const backlog = parseBacklog(flags.backlog);
  if (backlog !== undefined) changes.backlog = backlog;

  const scope = {};
  for (const flag of ["scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids"]) {
    if (flags[flag] === undefined) continue;
    if (flags[flag] === true) throw new Error(`update: --${flag} requires a value`);
    const key = flag === "scope-node-ids"
      ? "node_ids"
      : flag.slice("scope-".length);
    scope[key] = csv(flags[flag]);
  }
  if (Object.keys(scope).length > 0) changes.scope = scope;

  if (Object.keys(changes).length === 0) {
    throw new Error("update: at least one field required (e.g. --title X)");
  }
  return changes;
}

function providerFor(snapshot, id) {
  const node = snapshot && snapshot.nodes ? snapshot.nodes[id] : null;
  if (node && node.kind === "knowledge") return knowledgeUpdateProvider();
  if (node && node.kind === "resolvable" && node.subkind === "gate") return gateUpdateProvider;
  return taskUpdateProvider;
}

// The typed providers intentionally expose their own domain-specific patch
// contracts. The historical CLI accepted the complete flag set for any v2
// node, so retain that compatibility at this adapter boundary: supported
// fields go through the canonical provider and the remaining known CLI fields
// are applied to the same kernel transaction after the provider validates the
// target and CAS. No direct persistence or logging is introduced here.
const PROVIDER_PATCH_KEYS = Object.freeze({
  task: new Set(["title", "body", "acceptance", "definition", "domain", "initiative", "tags", "refs"]),
  gate: new Set(["title", "body", "initiative", "domain", "tags", "refs", "meta", "definition", "acceptance", "backlog", "purpose", "resolution_mode"]),
  knowledge: new Set(["title", "body", "mitigation", "knowledge_type", "scope", "status", "domain", "tags", "refs", "meta"]),
});

function typedChanges(node, changes) {
  const key = node && node.kind === "knowledge"
    ? "knowledge"
    : node && node.subkind === "gate"
      ? "gate"
      : "task";
  const allowed = PROVIDER_PATCH_KEYS[key];
  const typed = {};
  const legacy = {};
  for (const [field, value] of Object.entries(changes)) {
    (allowed.has(field) ? typed : legacy)[field] = value;
  }
  return { typed, legacy };
}

function actionForTarget(target) {
  if (target && target.kind === "knowledge") return "knowledge.update";
  if (target && target.kind === "resolvable" && target.subkind === "gate") return "gate.update";
  return "task.update";
}

// The kernel receives this action only to label the outer request. The
// policy seam must still see the typed action selected from the target, so
// decide derives that action from the provider plan and throws the canonical
// deny error itself (rather than allowing kernel.mutate to label it `update`).
function policyAction({ policy, projectDir, agent }) {
  return {
    action: "update",
    pluginId: policy && policy.pluginId ? policy.pluginId : null,
    async decide({ snapshot, target }) {
      const action = actionForTarget(target);
      if (!policy) return { decision: "abstain" };
      const decision = await authorizeAction({
        policy,
        action,
        actor: agent,
        target,
        snapshot,
        projectDir,
        projectConfig: policy.projectConfig || {},
      });
      if (decision.decision === "deny") {
        throw new PolicyDenied(
          policy.pluginId || "(unknown)",
          action,
          agent,
          decision.reason || "denied by policy",
        );
      }
      return decision;
    },
  };
}

export default async function update({
  statePath,
  projectDir,
  flags = {},
  positional = [],
  pluginId,
}) {
  const id = positional[0];
  if (!id) throwV2("MISSING_FIELD", "update: node id required", { field: "id" });

  const dir = projectDir || statePath;
  const agent = resolveAgent(flags, "update");
  const changes = buildChanges(flags);
  const expectedRevision = parseIfRevision(flags["if-revision"]);
  const policy = await loadApplicablePolicy({ projectDir: dir });

  // `update` remains the historical audit action in the CLI log. The policy
  // seam receives the typed operation (task.update/gate.update/
  // knowledge.update) through `policyAction` below; keeping this request
  // action stable preserves the public CLI history contract.
  const request = {
    action: "update",
    actor: agent,
    input: { id, changes, if_revision: expectedRevision },
  };

  const adapterProvider = {
    async prepare(args) {
      const provider = providerFor(args.snapshot, id);
      const node = args.snapshot && args.snapshot.nodes ? args.snapshot.nodes[id] : null;
      const current = node;
      // Older direct callers did not pass --if-revision. Keep that CLI
      // compatibility while still declaring a kernel CAS from the fresh
      // snapshot; callers that provide the flag get the strict value they
      // requested and stale edits fail with REVISION_CONFLICT.
      const revision = expectedRevision ?? (current && Number.isInteger(current.revision) ? current.revision : 1);
      // The task provider's historical plan uses a plain if_revisions map,
      // while kernel.mutate accepts the structured precondition. Supplying it
      // on the request gives every provider one canonical single-node CAS.
      request.if_revision = { kind: "single", id, value: revision };
      const { typed, legacy } = typedChanges(node, changes);
      // Scope flags historically patched only the named arrays. Expand the
      // partial CLI scope against the current node before handing it to a
      // provider (knowledge.update replaces scope wholesale) or the legacy
      // compatibility patch below.
      if (typed.scope) typed.scope = { ...(current && current.scope ? current.scope : {}), ...typed.scope };
      if (legacy.scope) legacy.scope = { ...(current && current.scope ? current.scope : {}), ...legacy.scope };
      if (legacy.backlog === false) legacy.backlog = undefined;
      // A CLI-only field may be the complete patch. Give the provider an
      // idempotent typed field so it still validates target and revision;
      // legacy is then applied in the same tx by `apply` below.
      const providerChanges = Object.keys(typed).length > 0
        ? typed
        : { title: current && typeof current.title === "string" ? current.title : "" };
      const input = {
        ...args.input,
        changes: providerChanges,
        if_revision: revision,
      };
      const plan = await provider.prepare({ ...args, input });
      // Keep the historical policy target projection available in addition
      // to the typed provider target fields.
      return {
        ...plan,
        target: { ...plan.target, status: current && current.status },
        legacy_patch: legacy,
      };
    },
    async apply(args) {
      const provider = providerFor(args.snapshot, id);
      const applied = await provider.apply(args);
      if (args.plan.legacy_patch && Object.keys(args.plan.legacy_patch).length > 0) {
        args.tx.updateNode(id, args.plan.legacy_patch);
      }
      // Providers may return a compact result (knowledge.update returns only
      // id/kind). The CLI envelope has always returned the complete node, so
      // project the transaction's post-patch node while still letting the
      // provider supply operation-specific effects.
      return { ...applied, result: args.tx.getNode(id) };
    },
  };

  const mutation = await mutate({
    projectDir: dir,
    request,
    provider: adapterProvider,
    policyAction: policyAction({ policy, projectDir: dir, agent }),
    pluginId,
  });

  let node = mutation.diff.updated.find((entry) => entry.id === id)?.node;
  if (!node && mutation.result && typeof mutation.result === "object") {
    node = {
      ...mutation.result,
      revision: mutation.diff.target_revision,
    };
    delete node.added_edges;
  }
  if (!node) {
    throwV2("INVALID_EXECUTION_CONTRACT", `update: kernel did not return node ${id}`, { id });
  }
  return { node };
}
