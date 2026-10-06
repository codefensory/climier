import { statusOf } from "./core.ts";
import type { ReadModelEdge, ReadModelNode, ReadModelSnapshot } from "./types.ts";

function compareText(a: unknown, b: unknown): number {
  const left = String(a);
  const right = String(b);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function copyNodePlugin(node: ReadModelNode, pluginId: string | undefined): ReadModelNode {
  const nodePlugins = node.plugins;
  delete node.plugins;
  if (pluginId && isRecord(nodePlugins) && Object.prototype.hasOwnProperty.call(nodePlugins, pluginId)) {
    node.plugins = { [pluginId]: clone(nodePlugins[pluginId]) };
  }
  return node;
}

function copyNode(sourceNode: unknown, pluginId: string | undefined): ReadModelNode | null {
  if (!isRecord(sourceNode)) {
    return null;
  }
  return copyNodePlugin(clone(sourceNode) as ReadModelNode, pluginId);
}

function copyNodes(
  sourceNodes: Record<string, ReadModelNode>,
  pluginId: string | undefined,
): { nodes: Record<string, ReadModelNode>; nodeIds: string[] } {
  const nodes: Record<string, ReadModelNode> = {};
  const nodeIds = Object.keys(sourceNodes).toSorted(compareText);
  for (const id of nodeIds) {
    const node = copyNode(sourceNodes[id], pluginId);
    if (node) {
      nodes[id] = node;
    }
  }
  return { nodes, nodeIds };
}

function sourceRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function revisionOf(source: ReadModelSnapshot): number {
  const revision = source.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function copyEdges(sourceEdges: unknown): ReadModelEdge[] {
  return (Array.isArray(sourceEdges) ? sourceEdges : [])
    .filter((edge): edge is ReadModelEdge => isRecord(edge))
    .map((edge) => clone(edge) as ReadModelEdge)
    .toSorted((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.type, b.type));
}

function deriveStatuses(source: ReadModelSnapshot, nodes: Record<string, ReadModelNode>, nodeIds: string[]): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  for (const id of nodeIds) {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      derived[id] = statusOf({ snapshot: source, id });
    }
  }
  return derived;
}

function copyPlugin(sourcePlugins: Record<string, unknown>, pluginId: string | undefined): Record<string, unknown> {
  const plugins: Record<string, unknown> = {};
  if (pluginId && Object.prototype.hasOwnProperty.call(sourcePlugins, pluginId)) {
    plugins[pluginId] = clone(sourcePlugins[pluginId]);
  }
  return plugins;
}


interface ProjectSnapshotArgs {
  snapshot?: ReadModelSnapshot;
  pluginId?: string;
}

export function projectSnapshot({ snapshot, pluginId }: ProjectSnapshotArgs = {}) {
  const source = sourceRecord(snapshot) as ReadModelSnapshot;
  const sourceNodes = sourceRecord(source.nodes) as Record<string, ReadModelNode>;
  const { nodes, nodeIds } = copyNodes(sourceNodes, pluginId);
  const edges = copyEdges(source.edges);
  const derived = deriveStatuses(source, nodes, nodeIds);
  const plugins = copyPlugin(sourceRecord(source.plugins), pluginId);
  return { revision: revisionOf(source), nodes, edges, derived, plugins };
}
