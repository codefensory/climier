import type { ReadModelNode, ReadModelSnapshot } from "./types.ts";

const searchableFields = (node: ReadModelNode): Array<[string, unknown]> => [
  ["id", node.id],
  ["title", node.title],
  ["body", node.body],
  ["mitigation", node.mitigation],
  ["domain", node.domain],
  ["tags", node.tags],
  ["refs", (node.refs || []).map((ref) => typeof ref === "object" && ref !== null ? ref.target : undefined)],
  ["meta", node.meta],
];

function includes(value: unknown, textQuery: string): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ? text.toLowerCase().includes(textQuery) : false;
}


interface ProjectSearchArgs {
  snapshot?: ReadModelSnapshot;
  query?: string;
  all?: boolean;
}

export function projectSearchView({ snapshot, query = "", all = false }: ProjectSearchArgs = {}) {
  const textQuery = String(query ?? "").toLowerCase();
  if (!textQuery) {
    return { matches: [], count: 0 };
  }

  const matches = Object.values(snapshot?.nodes || {})
    .filter((node) => node.kind === "knowledge" && (all || (node.status || "active") === "active"))
    .map((node) => ({
      node,
      matched_fields: searchableFields(node).filter(([, value]) => includes(value, textQuery)).map(([field]) => field),
    }))
    .filter(({ matched_fields }) => matched_fields.length)
    .toSorted((left, right) => left.node.id.localeCompare(right.node.id))
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
