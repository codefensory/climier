// F6 — v2 update: edit a v2 node's fields, incrementing its revision counter.
// Supports --if-revision for optimistic-concurrency control: if the caller's
// expected revision doesn't match the stored one, REVISION_CONFLICT is thrown
// and nothing is written.
//
// v1 has its own update.mjs (this file deliberately does not touch it).
// The CLI entry dispatches to v2-update.mjs when the state is version 2.
import { isV2State, readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

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
  return String(raw).split(",").map((x) => x.trim()).filter(Boolean);
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
  } catch (err) {
    throw new Error(`update: --meta must be valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("update: --meta must be a JSON object");
  }
  return parsed;
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
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`update: --if-revision must be a positive integer (got '${raw}')`);
  }
  return n;
}

// Flag name -> path to the field within the node. `meta` is special-cased
// (replaces the object), `tags`/`refs` replace the array wholesale, `scope-*`
// lives under node.scope.
const SCALAR_FIELDS = ["title", "body", "initiative", "domain", "definition", "acceptance", "purpose", "resolution-mode", "knowledge-type", "mitigation"];
const ARRAY_FIELDS = ["tags", "refs"];

export default async function updateV2({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "update: node id required", { field: "id" });
  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("update: state file missing");
    if (!isV2State(s)) {
      throw new Error("update: v1 state is not supported by v2 update (use `update` without --v2)");
    }
    const node = s.nodes[id];
    if (!node) throwV2("NODE_NOT_FOUND", `update: node ${id} not found`, { id });

    const expectedRevision = parseIfRevision(flags["if-revision"]);
    if (expectedRevision !== undefined && node.revision !== expectedRevision) {
      throwV2(
        "REVISION_CONFLICT",
        `update: node ${id} changed since revision ${expectedRevision}`,
        { expected: expectedRevision, current: node.revision },
      );
    }

    const changes = {};
    const patch = (path) => (value) => { changes[path] = value; };

    // Scalar fields. Use `?? undefined` to allow clearing by passing an empty
    // string — but only when the flag is explicitly provided (undefined check).
    for (const field of SCALAR_FIELDS) {
      if (flags[field] === undefined) continue;
      if (flags[field] === true) throw new Error(`update: --${field} requires a value`);
      changes[field] = flags[field];
    }

    if (flags.tags !== undefined) {
      if (flags.tags === true) throw new Error("update: --tags requires a value");
      changes.tags = csv(flags.tags);
    }
    if (flags.refs !== undefined) {
      if (flags.refs === true) throw new Error("update: --refs requires a value");
      changes.refs = refs(flags.refs);
    }

    if (flags.meta !== undefined) {
      changes.meta = parseMeta(flags.meta);
    }

    const backlog = parseBacklog(flags.backlog);
    if (backlog !== undefined) changes.backlog = backlog;

    // scope-* replace the matching sub-array on node.scope.
    const scopePatch = {};
    for (const f of ["scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids"]) {
      if (flags[f] === undefined) continue;
      if (flags[f] === true) throw new Error(`update: --${f} requires a value`);
      const key = f.replace(/^scope-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      // scope-node-ids -> node_ids
      const scopeKey = key === "nodeIds" ? "node_ids" : key;
      scopePatch[scopeKey] = csv(flags[f]);
    }
    if (Object.keys(scopePatch).length > 0) changes.scope = scopePatch;

    if (Object.keys(changes).length === 0) {
      throw new Error("update: at least one field required (e.g. --title X)");
    }

    const as = resolveAgent(flags, "update");
    const updated = await updateState(projectDir, (st) => {
      const target = st.nodes[id];
      for (const [field, value] of Object.entries(changes)) {
        if (field === "scope") {
          target.scope = { ...(target.scope || {}), ...value };
        } else if (field === "backlog" && value === false) {
          // Mirror add-node behaviour: false means "remove the flag", so the
          // task drops back into the ready/blocked pool.
          delete target.backlog;
        } else {
          target[field] = value;
        }
      }
      target.revision = (target.revision || 0) + 1;
      return st;
    });

    await append(projectDir, {
      agent: as,
      action: "update",
      node: id,
      revision: updated.nodes[id].revision,
      changes,
    });

    return { node: updated.nodes[id] };
  });
}