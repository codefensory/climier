import { readState, updateState, assertStateVersion } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { EDGE_TYPES, blocksEdge, validateEdge } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = [
  "kind",
  "subkind",
  "title",
  "body",
  "refs",
  "meta",
  "initiative",
  "allow-unregistered-initiative",
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
  return parsed;
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

function edgeTargets(id, flags) {
  // Each entry is [type, targetList]; the edge shape is produced below.
  // BLOCKS is phrased from the dependent's POV ("I am blocked by X") so the
  // edge's `from` (blocker) is the flag value and `to` (blocked) is `id`.
  // DERIVED_FROM keeps the new node as `from`; the user picks its source.
  return [
    ["BLOCKS", csv(flags["blocked-by"])],
    ["DERIVED_FROM", csv(flags["derived-from"])],
  ];
}

export default async function addNode({ statePath, flags, positional }) {
  const [id] = positional;
  if (!id) throwV2("MISSING_FIELD", "add-node: node id required", { field: "id" });
  if (!flags.kind) throwV2("MISSING_FIELD", "add-node: --kind required", { field: "kind" });
  if (!flags.title) throwV2("MISSING_FIELD", "add-node: --title required", { field: "title" });
  const projectDir = statePath;

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) throw new Error("add-node: state file missing");
    assertStateVersion(s, 2, "add-node");
    if (s.nodes[id]) throwV2("ID_CONFLICT", `add-node: ${id} already exists`, { id });

    // v2 mandates a registered --initiative on every node (F3).
    // The escape hatch --allow-unregistered-initiative is for v1-compat
    // scenarios only — tests, recovery imports, bulk migration tooling.
    const initiative = flags.initiative;
    if (!initiative) {
      throwV2(
        "MISSING_FIELD",
        "add-node: --initiative is required for v2 (run `climier add-initiative <name> --desc \"...\"` first)",
        { field: "initiative" },
      );
    }
    const allowUnregistered = flags["allow-unregistered-initiative"] === true || flags["allow-unregistered-initiative"] === "true";
    const registered = s.initiatives && Object.prototype.hasOwnProperty.call(s.initiatives, initiative);
    if (!registered && !allowUnregistered) {
      throwV2(
        "INITIATIVE_NOT_FOUND",
        `add-node: initiative '${initiative}' is not registered`,
        {
          initiative,
          existing: Object.keys(s.initiatives || {}).sort(),
        },
      );
    }

    const kind = String(flags.kind);
    const subkind = flags.subkind ? String(flags.subkind) : undefined;
    const node = {
      id,
      kind,
      title: flags.title,
      // F6: every node carries a revision counter. update bumps it; --if-revision
      // lets callers detect concurrent edits. Initialized on creation so the
      // first update goes 1 -> 2 without a special-case.
      revision: 1,
      body: flags.body || undefined,
      refs: refs(flags.refs),
      meta: parseMeta(flags.meta),
      initiative: flags.initiative || undefined,
      domain: flags.domain || undefined,
      tags: csv(flags.tags),
      status: flags.status || undefined,
    };

    if (kind === "resolvable") {
      if (!subkind || !["task", "gate"].includes(subkind)) {
        throwV2("MISSING_FIELD", "add-node: resolvable nodes require --subkind task|gate", { field: "subkind" });
      }
      node.subkind = subkind;
      node.resolution_mode = flags["resolution-mode"] || (subkind === "task" ? "labor" : "choice");
      node.status = flags.status || "open";
      node.purpose = flags.purpose || undefined;
      node.definition = flags.definition || undefined;
      node.acceptance = flags.acceptance || undefined;
      const backlog = parseBacklog(flags.backlog);
      if (backlog === true) node.backlog = true;
      if (flags.choice || flags.rationale) {
        node.resolution = {
          choice: flags.choice || undefined,
          rationale: flags.rationale || undefined,
        };
      }
    } else if (kind === "knowledge") {
      node.status = flags.status || "active";
      node.knowledge_type = flags["knowledge-type"] || "warning";
      node.mitigation = flags.mitigation || undefined;
      node.scope = {
        domains: csv(flags["scope-domains"]),
        initiatives: csv(flags["scope-initiatives"]),
        tags: csv(flags["scope-tags"]),
        node_ids: csv(flags["scope-node-ids"]),
      };
    } else {
      throw new Error(`add-node: --kind must be 'resolvable' or 'knowledge' (got '${flags.kind}')`);
    }

    const edges = [];
    const supersedes = flags.supersedes === undefined ? null : String(flags.supersedes).trim();
    if (flags.supersedes === true || supersedes === "") {
      throwV2("MISSING_FIELD", "add-node: --supersedes requires a node id", { field: "supersedes" });
    }
    if (supersedes && node.subkind === "task") {
      throwV2(
        "INVALID_EDGE_KIND",
        "add-node: --supersedes is only valid for gates and knowledge",
        { from: id, to: supersedes, type: "SUPERSEDES", fromKind: "task" },
      );
    }
    // Validate edges against a working state that already includes the new
    // node — the validator expects both `from` and `to` to exist.
    const workingState = { ...s, nodes: { ...s.nodes, [id]: node } };
    if (supersedes) {
      const edge = { from: id, to: supersedes, type: "SUPERSEDES" };
      validateEdge(workingState, edge, "add-node");
      if (node.subkind === "gate" && workingState.nodes[supersedes].subkind !== "gate") {
        throwV2(
          "INVALID_EDGE_KIND",
          `add-node: SUPERSEDES requires gate -> gate (got gate -> ${workingState.nodes[supersedes].subkind || workingState.nodes[supersedes].kind})`,
          { from: id, to: supersedes, type: "SUPERSEDES", fromKind: "gate", toKind: workingState.nodes[supersedes].subkind || workingState.nodes[supersedes].kind },
        );
      }
      edges.push(edge);
    }
    for (const [type, targets] of edgeTargets(id, flags)) {
      if (targets.length === 0) continue;
      if (!EDGE_TYPES.includes(type)) {
        throwV2(
          "INVALID_EDGE_TYPE",
          `add-node: edge type ${type} is not allowed (allowed: ${EDGE_TYPES.join(", ")})`,
          { type, allowed: EDGE_TYPES },
        );
      }
      for (const target of targets) {
        const edge = type === "BLOCKS" ? blocksEdge(target, id) : { from: id, to: target, type };
        validateEdge(workingState, edge, "add-node");
        edges.push(edge);
      }
    }

    // F8: resolveAgent runs after all data validation but BEFORE updateState,
    // so a missing agent rejects without leaving an orphan node / log entry.
    const agent = resolveAgent(flags, "add-node");
    await updateState(projectDir, (st) => {
      st.nodes[id] = node;
      if (supersedes) {
        st.nodes[supersedes].status = "superseded";
        st.nodes[supersedes].revision = (st.nodes[supersedes].revision || 0) + 1;
        st.edges = st.edges.map((edge) =>
          edge.type === "BLOCKS" && edge.to === supersedes
            ? { ...edge, to: id }
            : edge
        );
      }
      st.edges.push(...edges);
      return st;
    });
    await append(projectDir, {
      agent,
      action: supersedes ? "supersede" : "add-node",
      note: supersedes ? `${id} supersedes ${supersedes}` : id,
    });
    return { node };
  });
}
