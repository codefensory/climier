
// core.batch is a protocol envelope, not a provider-backed operation.
export const remoteV1CapabilityInventory = Object.freeze({
  operations: Object.freeze([
    { id: "task.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "acceptance", "blocked_by", "backlog", "domain", "definition", "refs", "tags", "meta", "derived_from"]), batch: true },
    { id: "task.update", httpFields: Object.freeze(["id", "changes", "if_revision", "if_revisions"]), batch: true },
    { id: "task.take", httpFields: Object.freeze(["id", "at"]), batch: true },
    { id: "task.release", httpFields: Object.freeze(["id"]), batch: true },
    { id: "task.reopen", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true },
    { id: "task.cancel", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true },
    { id: "task.submit", httpFields: Object.freeze(["id", "note", "submitted_at", "if_revision"]), batch: true },
    { id: "task.accept", httpFields: Object.freeze(["id", "accepted_at", "if_revision"]), batch: true },
    { id: "task.reject", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true },
    { id: "gate.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "purpose", "supersedes", "blocked_by", "derived_from", "backlog", "domain", "definition", "acceptance", "tags", "refs", "meta"]), batch: true },
    { id: "gate.update", httpFields: Object.freeze(["id", "changes", "if_revision"]), batch: true },
    { id: "gate.resolve", httpFields: Object.freeze(["id", "choice", "rationale", "resolved_at", "if_revision", "if_revisions"]), batch: true },
    { id: "gate.reopen", httpFields: Object.freeze(["id", "reason", "if_revisions"]), batch: true },
    { id: "gate.cancel", httpFields: Object.freeze(["id", "reason", "if_revisions"]), batch: true },
    { id: "knowledge.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "scope", "supersedes", "knowledge_type", "mitigation", "domain", "tags", "refs", "meta"]), batch: true },
    { id: "knowledge.update", httpFields: Object.freeze(["id", "changes", "if_revision"]), batch: true },
    { id: "knowledge.deprecate", httpFields: Object.freeze(["id", "reason"]), batch: true },
    { id: "edge.add", httpFields: Object.freeze(["from", "to", "type"]), batch: true },
    { id: "edge.remove", httpFields: Object.freeze(["from", "to", "type"]), batch: true },
    { id: "note.add", httpFields: Object.freeze(["id", "text", "if_revision"]), batch: true },
    { id: "initiative.create", httpFields: Object.freeze(["name", "desc"]), batch: true },
  ]),
  batch: Object.freeze({
    id: "core.batch",
    inputFields: Object.freeze(["operations", "if_state_revision"]),
    operationFields: Object.freeze(["op", "input"]),
    nestedBatches: false,
    eligibleOperationIds: Object.freeze([
      "task.create", "task.update", "task.take", "task.release", "task.reopen", "task.cancel", "task.submit", "task.accept", "task.reject",
      "gate.create", "gate.update", "gate.resolve", "gate.reopen", "gate.cancel",
      "knowledge.create", "knowledge.update", "knowledge.deprecate",
      "edge.add", "edge.remove", "note.add", "initiative.create",
    ]),
  }),
});
