// src/providers/knowledge/create.mjs — `knowledge.create` provider for
// the graph kernel (plan B4-knowledge-core).
//
// Implements the kernel provider contract from ADR-011 §1:
//   - `prepare({ snapshot, input, request }) → plan`
//       read-only; validates domain rules; returns an immutable plan
//       carrying `{ target, policyAction, idempotent, node, supersedes? }`.
//   - `apply({ tx, plan, input, request, snapshot }) → { result }`
//       mutates ONLY the tx draft via `tx.createNode` / `tx.updateNode` /
//       `tx.addEdge`. The kernel owns revision assignment (see
//       `src/kernel/mutate.mjs`); the provider never seeds `revision`.
//
// Scope (this slice):
//   - `knowledge.create` with optional `supersedes`.
//   - No deprecate, no lifecycle (B4-knowledge-lifecycle will cover them).
//
// Pure: no fs, no lock, no state, no log, no policy, no commands, no
// registry, no adapter, no CLI, no UI.

import { throwV2 } from "../../errors.mjs";

const KNOWN_KNOWLEDGE_TYPES = Object.freeze(["warning", "fact", "instruction"]);
const KNOWN_STATUSES = Object.freeze(["active", "deprecated"]); // deprecated cannot be set on create, kept for completeness
const SCOPE_KEYS = Object.freeze(["domains", "initiatives", "tags", "node_ids"]);

function asString(value) {
  return typeof value === "string" ? value : "";
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throwV2("MISSING_FIELD", "knowledge.create: input must be an object", { field: "input" });
  }
  return input;
}

function readScope(rawScope) {
  if (rawScope == null || typeof rawScope !== "object" || Array.isArray(rawScope)) {
    return { domains: [], initiatives: [], tags: [], node_ids: [] };
  }
  return {
    domains: Array.isArray(rawScope.domains) ? rawScope.domains.slice() : [],
    initiatives: Array.isArray(rawScope.initiatives) ? rawScope.initiatives.slice() : [],
    tags: Array.isArray(rawScope.tags) ? rawScope.tags.slice() : [],
    node_ids: Array.isArray(rawScope.node_ids) ? rawScope.node_ids.slice() : [],
  };
}

function scopeHasAnyValue(scope) {
  for (const key of SCOPE_KEYS) {
    if (Array.isArray(scope[key]) && scope[key].length > 0) return true;
  }
  return false;
}

function readSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.create: snapshot must be an object", { field: "snapshot" });
  }
  return snapshot;
}

function readInitiatives(snapshot) {
  return snapshot.initiatives && typeof snapshot.initiatives === "object" ? snapshot.initiatives : {};
}

function readNodes(snapshot) {
  return snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
}

/**
 * knowledge.create provider factory.
 *
 * @returns {{
 *   prepare: (args: { snapshot: object, input: object, request: object }) => Promise<object>,
 *   apply: (args: { tx: object, plan: object }) => Promise<{ result: object }>,
 * }}
 */
export function createProvider() {
  return {
    /**
     * Validate the create request and produce the plan. Read-only.
     *
     * Required input fields: title, body, initiative, scope (at least one
     * non-empty array).
     *
     * Optional: id (auto-generated upstream), status (default "active"),
     * knowledge_type (default "warning"), mitigation, domain, tags, refs,
     * meta, supersedes (knowledge id of the node to supersede).
     */
    async prepare({ snapshot: rawSnapshot, input: rawInput }) {
      const snapshot = readSnapshot(rawSnapshot);
      const input = readInput(rawInput);

      const title = asString(input.title).trim();
      if (!title) {
        throwV2("MISSING_FIELD", "knowledge.create: --title is required", { field: "title" });
      }
      const body = asString(input.body).trim();
      if (!body) {
        throwV2("MISSING_FIELD", "knowledge.create: --body is required", { field: "body" });
      }
      const initiative = asString(input.initiative).trim();
      const allowUnregistered = input.allow_unregistered_initiative === true;
      if (!initiative && !allowUnregistered) {
        throwV2("MISSING_FIELD", "knowledge.create: --initiative is required", { field: "initiative" });
      }
      if (initiative) {
        const initiatives = readInitiatives(snapshot);
        if (!Object.prototype.hasOwnProperty.call(initiatives, initiative)) {
          if (!allowUnregistered) {
            throwV2(
              "INITIATIVE_NOT_FOUND",
              `knowledge.create: initiative '${initiative}' is not registered`,
              { initiative },
            );
          }
        }
      }

      const scope = readScope(input.scope);
      if (!scopeHasAnyValue(scope)) {
        throwV2(
          "MISSING_FIELD",
          "knowledge.create: at least one --scope-* value is required",
          { field: "scope" },
        );
      }

      const status = input.status === undefined ? "active" : asString(input.status);
      if (!KNOWN_STATUSES.includes(status)) {
        throwV2(
          "INVALID_PROVIDER_INPUT",
          `knowledge.create: status '${status}' is not allowed (allowed: ${KNOWN_STATUSES.join(", ")})`,
          { field: "status", value: status, allowed: KNOWN_STATUSES },
        );
      }

      const knowledgeType = input.knowledge_type === undefined
        ? "warning"
        : asString(input.knowledge_type);
      // knowledge_type is a free-form taxonomy string. The provider
      // accepts any non-empty value; the built-in defaults below are
      // kept for documentation but are not a closed set, so callers
      // may seed custom types like `constraint` or `tip`.
      if (knowledgeType.length === 0) {
        throwV2(
          "MISSING_FIELD",
          "knowledge.create: --knowledge-type must be a non-empty string",
          { field: "knowledge_type" },
        );
      }

      // Optional id (auto is upstream). Validate shape defensively so we
      // surface clear errors before the kernel tx would.
      const id = input.id === undefined ? null : asNonEmptyString(input.id);
      if (input.id !== undefined && !id) {
        throwV2("MISSING_FIELD", "knowledge.create: id must be a non-empty string", { field: "id" });
      }

      // Optional supersedes: must point at an existing knowledge node.
      const supersedes = input.supersedes === undefined ? null : asNonEmptyString(input.supersedes);
      if (supersedes !== null) {
        const nodes = readNodes(snapshot);
        const targetNode = nodes[supersedes];
        if (!targetNode) {
          throwV2("NODE_NOT_FOUND", `knowledge.create: supersedes target '${supersedes}' does not exist`, { field: "supersedes", id: supersedes });
        }
        if (targetNode.kind !== "knowledge") {
          throwV2(
            "INVALID_PROVIDER_INPUT",
            `knowledge.create: supersedes target '${supersedes}' is not a knowledge node`,
            { field: "supersedes", id: supersedes, kind: targetNode.kind },
          );
        }
        if (id !== null && id === supersedes) {
          throwV2(
            "INVALID_PROVIDER_INPUT",
            `knowledge.create: supersedes target cannot be the same as the new node id`,
            { field: "supersedes", id },
          );
        }
      }

      const node = {
        id, // left to the upstream / kernel when null; we copy the literal here so the apply can read it.
        kind: "knowledge",
        title,
        body,
        initiative,
        status,
        knowledge_type: knowledgeType,
        scope,
      };
      if (allowUnregistered && !initiative) {
        // Trusted internals (recovery, bulk migration) may seed a
        // knowledge node without registering an initiative first.
        // The CLI surface never passes allow_unregistered_initiative.
        delete node.initiative;
      }
      if (input.mitigation !== undefined) {
        const mitigation = asString(input.mitigation);
        if (mitigation.length > 0) node.mitigation = mitigation;
      }
      if (input.domain !== undefined) {
        const domain = asString(input.domain);
        if (domain.length > 0) node.domain = domain;
      }
      if (Array.isArray(input.tags) && input.tags.length > 0) {
        node.tags = input.tags.slice();
      }
      if (Array.isArray(input.refs) && input.refs.length > 0) {
        node.refs = input.refs.map((ref) => (ref && typeof ref === "object") ? { ...ref } : ref);
      }
      if (input.meta !== undefined && input.meta !== null && typeof input.meta === "object" && !Array.isArray(input.meta)) {
        node.meta = { ...input.meta };
      }

      const plan = {
        target: { id, kind: "knowledge" },
        policyAction: null,
        idempotent: false,
        node,
      };
      if (supersedes !== null) plan.supersedes = supersedes;
      return plan;
    },

    /**
     * Compose the draft via tx.createNode / tx.updateNode / tx.addEdge.
     * Never sets `revision`; the kernel diff bumps it once per node per apply.
     */
    async apply({ tx, plan }) {
      const node = plan.node;
      if (!node || typeof node !== "object") {
        throwV2("INVALID_EXECUTION_CONTRACT", "knowledge.create.apply: plan.node missing", { field: "plan.node" });
      }
      const id = node.id;
      if (typeof id !== "string" || id.length === 0) {
        throwV2(
          "INVALID_EXECUTION_CONTRACT",
          "knowledge.create.apply: node id is required (the upstream caller must supply one)",
          { field: "id" },
        );
      }
      tx.createNode({ ...node, id });
      const supersedes = plan.supersedes;
      if (typeof supersedes === "string" && supersedes.length > 0) {
        // Mark the superseded node. The kernel diff assigns the new
        // revision (prev + 1). No BLOCKS rewrite here: knowledge nodes
        // are never BLOCKS endpoints in v2 semantics (BLOCKS requires
        // both ends to be resolvable), so the existing edge rewrite
        // (originally for task/gate supersede) is a no-op for knowledge.
        tx.updateNode(supersedes, { status: "superseded" });
        tx.addEdge({ from: id, to: supersedes, type: "SUPERSEDES" });
      }
      return { result: { id, kind: "knowledge" }, effects: null };
    },
  };
}
