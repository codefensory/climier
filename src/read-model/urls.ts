export type UiUrlKind =
  | "home"
  | "tasks"
  | "gates"
  | "knowledges"
  | "initiatives"
  | "task"
  | "gate"
  | "knowledge";

export interface UiUrl {
  kind: UiUrlKind;
  label: string;
  url: string;
}

export interface UiUrlNode {
  id: string;
  kind: string;
  subkind?: string;
}

export interface BuildUiUrlsArgs {
  origin: string;
  projectId: string;
  initiative?: string;
  node?: UiUrlNode;
}

const LINKED_ROUTES = [
  ["home", "/"],
  ["tasks", "/tasks"],
  ["gates", "/gates"],
  ["knowledges", "/knowledges"],
  ["initiatives", "/initiatives"],
] as const satisfies ReadonlyArray<readonly [UiUrlKind, string]>;

/** Encode the only filter shape emitted by the CLI URL projection. */
export function encodeInitiativeFilter(initiative: string): string {
  return JSON.stringify({
    c: [{ f: "initiative", o: "is", v: [initiative] }],
    g: [],
  });
}

function urlFor(origin: string, projectId: string, route: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ project: projectId, ...extra });
  return `${origin}/#${route}?${params.toString()}`;
}

function baseUrls(origin: string, projectId: string): UiUrl[] {
  return LINKED_ROUTES.map(([kind, route]) => ({
    kind,
    label: kind,
    url: urlFor(origin, projectId, route),
  }));
}

function nodeUrl(origin: string, projectId: string, node: UiUrlNode): UiUrl {
  if (node.kind === "knowledge") {
    return {
      kind: "knowledge",
      label: `knowledge ${node.id} (selection in the knowledges list)`,
      url: urlFor(origin, projectId, "/knowledges", { knowledge: node.id }),
    };
  }

  const kind = node.subkind === "gate" || node.kind === "gate" ? "gate" : "task";
  const route = kind === "gate" ? "/gates" : "/tasks";
  return {
    kind,
    label: `${kind} ${node.id}`,
    url: urlFor(origin, projectId, `${route}/${encodeURIComponent(node.id)}`),
  };
}

/** Build the UI's base links and any requested initiative or node deep link. */
export function buildUiUrls({ origin, projectId, initiative, node }: BuildUiUrlsArgs): UiUrl[] {
  const urls = baseUrls(origin, projectId);
  if (initiative !== undefined) {
    urls.push({
      kind: "tasks",
      label: `tasks of initiative '${initiative}'`,
      url: urlFor(origin, projectId, "/tasks", { filter: encodeInitiativeFilter(initiative) }),
    });
  }
  if (node !== undefined) {
    urls.push(nodeUrl(origin, projectId, node));
  }
  return urls;
}
