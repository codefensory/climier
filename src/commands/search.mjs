import { assertStateVersion, readState } from "../state.mjs";

export const knownFlags = ["all"];

function searchableFields(node) {
  return [
    ["id", node.id],
    ["title", node.title],
    ["body", node.body],
    ["mitigation", node.mitigation],
    ["domain", node.domain],
    ["tags", node.tags],
    ["refs", (node.refs || []).map((ref) => ref && ref.target)],
    ["meta", node.meta],
  ];
}

function includes(value, query) {
  if (value == null) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? text.toLowerCase().includes(query) : false;
}

export default async function search({ statePath, positional, flags }) {
  const query = String(positional[0] ?? "").toLowerCase();
  if (!query) return { matches: [], count: 0 };

  const state = await readState(statePath);
  if (!state) throw new Error("search: state file missing");
  assertStateVersion(state, 2, "search");
  const all = flags.all === true || flags.all === "true";
  const matches = Object.values(state.nodes)
    .filter((node) => node.kind === "knowledge" && (all || (node.status || "active") === "active"))
    .map((node) => ({
      node,
      matched_fields: searchableFields(node)
        .filter(([, value]) => includes(value, query))
        .map(([field]) => field),
    }))
    .filter(({ matched_fields }) => matched_fields.length)
    .sort((a, b) => a.node.id.localeCompare(b.node.id))
    .map(({ node, matched_fields }) => ({
      id: node.id,
      kind: node.kind,
      title: node.title,
      initiative: node.initiative,
      domain: node.domain,
      status: node.status || "active",
      matched_fields,
      snippet: String(node.body || "").slice(0, 200),
    }));

  return { matches, count: matches.length };
}
