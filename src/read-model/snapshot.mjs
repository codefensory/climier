import { statusOf } from "./core.mjs";

function compareText(a, b) {
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

function clone(value) {
  return structuredClone(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function copyNodePlugin(node, pluginId) {
  const nodePlugins = node.plugins;
  delete node.plugins;
  if (pluginId && isRecord(nodePlugins) && Object.prototype.hasOwnProperty.call(nodePlugins, pluginId)) {
    node.plugins = { [pluginId]: clone(nodePlugins[pluginId]) };
  }
  return node;
}

function copyNode(sourceNode, pluginId) {
  if (!isRecord(sourceNode)) {
    return null;
  }
  return copyNodePlugin(clone(sourceNode), pluginId);
}

function copyNodes(sourceNodes, pluginId) {
  const nodes = {};
  const nodeIds = Object.keys(sourceNodes).toSorted(compareText);
  for (const id of nodeIds) {
    const node = copyNode(sourceNodes[id], pluginId);
    if (node) {
      nodes[id] = node;
    }
  }
  return { nodes, nodeIds };
}

function sourceRecord(value) {
  return isRecord(value) ? value : {};
}

function revisionOf(source) {
  return Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
}

function copyEdges(sourceEdges) {
  return (Array.isArray(sourceEdges) ? sourceEdges : [])
    .filter((edge) => edge && typeof edge === "object" && !Array.isArray(edge))
    .map(clone)
    .toSorted((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.type, b.type));
}

function deriveStatuses(source, nodes, nodeIds) {
  const derived = {};
  for (const id of nodeIds) {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      derived[id] = statusOf({ snapshot: source, id });
    }
  }
  return derived;
}

function copyPlugin(sourcePlugins, pluginId) {
  const plugins = {};
  if (pluginId && Object.prototype.hasOwnProperty.call(sourcePlugins, pluginId)) {
    plugins[pluginId] = clone(sourcePlugins[pluginId]);
  }
  return plugins;
}


export function projectSnapshot({ snapshot, pluginId } = {}) {
  const source = sourceRecord(snapshot);
  const sourceNodes = sourceRecord(source.nodes);
  const { nodes, nodeIds } = copyNodes(sourceNodes, pluginId);
  const edges = copyEdges(source.edges);
  const derived = deriveStatuses(source, nodes, nodeIds);
  const plugins = copyPlugin(sourceRecord(source.plugins), pluginId);
  return { revision: revisionOf(source), nodes, edges, derived, plugins };
}
