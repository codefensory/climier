const operations = Object.freeze([
  Object.freeze({ id: "task.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "acceptance", "blocked_by", "backlog", "domain", "definition", "refs", "tags", "meta", "derived_from"]), batch: true }),
  Object.freeze({ id: "task.update", httpFields: Object.freeze(["id", "changes", "if_revision", "if_revisions"]), batch: true }),
  Object.freeze({ id: "task.take", httpFields: Object.freeze(["id", "at"]), batch: true }),
  Object.freeze({ id: "task.release", httpFields: Object.freeze(["id"]), batch: true }),
  Object.freeze({ id: "task.reopen", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true }),
  Object.freeze({ id: "task.cancel", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true }),
  Object.freeze({ id: "task.submit", httpFields: Object.freeze(["id", "note", "submitted_at", "if_revision"]), batch: true }),
  Object.freeze({ id: "task.accept", httpFields: Object.freeze(["id", "accepted_at", "if_revision"]), batch: true }),
  Object.freeze({ id: "task.reject", httpFields: Object.freeze(["id", "reason", "if_revision"]), batch: true }),
  Object.freeze({ id: "gate.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "purpose", "supersedes", "blocked_by", "derived_from", "backlog", "domain", "definition", "acceptance", "tags", "refs", "meta"]), batch: true }),
  Object.freeze({ id: "gate.update", httpFields: Object.freeze(["id", "changes", "if_revision"]), batch: true }),
  Object.freeze({ id: "gate.resolve", httpFields: Object.freeze(["id", "choice", "rationale", "resolved_at", "if_revision", "if_revisions"]), batch: true }),
  Object.freeze({ id: "gate.reopen", httpFields: Object.freeze(["id", "reason", "if_revisions"]), batch: true }),
  Object.freeze({ id: "gate.cancel", httpFields: Object.freeze(["id", "reason", "if_revisions"]), batch: true }),
  Object.freeze({ id: "knowledge.create", httpFields: Object.freeze(["id", "initiative", "title", "body", "scope", "supersedes", "knowledge_type", "mitigation", "domain", "tags", "refs", "meta"]), batch: true }),
  Object.freeze({ id: "knowledge.update", httpFields: Object.freeze(["id", "changes", "if_revision"]), batch: true }),
  Object.freeze({ id: "knowledge.deprecate", httpFields: Object.freeze(["id", "reason"]), batch: true }),
  Object.freeze({ id: "edge.add", httpFields: Object.freeze(["from", "to", "type"]), batch: true }),
  Object.freeze({ id: "edge.remove", httpFields: Object.freeze(["from", "to", "type"]), batch: true }),
  Object.freeze({ id: "note.add", httpFields: Object.freeze(["id", "text", "if_revision"]), batch: true }),
  Object.freeze({ id: "initiative.create", httpFields: Object.freeze(["name", "desc"]), batch: true }),
]);

export const remoteV1Manifest = Object.freeze({
  version: 1,
  operations,
  batch: Object.freeze({
    id: "core.batch",
    inputFields: Object.freeze(["operations", "if_state_revision"]),
    operationFields: Object.freeze(["op", "input"]),
    nestedBatches: false,
    eligibleOperationIds: Object.freeze(
      operations.filter(({ batch }) => batch).map(({ id }) => id),
    ),
  }),
});
