// Canonical read-only projections over a v2 snapshot.
//
// This layer is the only place that composes graph semantics with domain
// providers. It has no filesystem, argv, mutation, or logging concerns. The
// object-shaped arguments are the canonical API; the positional form is kept
// solely so read consumers can use a stable object-shaped API.

import { incoming } from "../kernel/graph.mjs";
import {
  deriveV2,
  statusOfV2 as taskStatusOfV2,
  isSatisfiedV2,
} from "../providers/task/derivation.mjs";
import {
  gateProjection,
  isCurrent,
  supersededBy,
} from "../providers/gate/semantics.mjs";
import {
  knowledgeForNode as providerKnowledgeForNode,
  informingForNode as providerInformingForNode,
} from "../providers/knowledge/index.mjs";

function projectionArgs(input, id) {
  if (input && typeof input === "object" && Object.prototype.hasOwnProperty.call(input, "snapshot")) {
    return { snapshot: input.snapshot, id: input.id };
  }
  return { snapshot: input, id };
}

/**
 * Derive the read-model task and gate pools from an explicit snapshot.
 *
 * @param {{snapshot: object}} args
 */
export function derive({ snapshot } = {}) {
  return deriveV2(snapshot);
}

/**
 * Return the externally visible status for a node.
 *
 * Open gates are a read-model status, rather than task readiness. The task
 * provider intentionally only derives task lifecycle and readiness.
 */
export function statusOf(input, id) {
  const args = projectionArgs(input, id);
  const { snapshot } = args;
  const node = snapshot && snapshot.nodes ? snapshot.nodes[args.id] : null;
  if (node && node.kind === "resolvable" && node.subkind === "gate" && (node.status || "open") === "open") {
    return "open";
  }
  return taskStatusOfV2(snapshot, args.id);
}

/**
 * Project BLOCKS dependencies, combining kernel traversal, gate projection,
 * and task satisfaction into one read-model result.
 */
export function blockingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return incoming(snapshot, targetId, "BLOCKS").map((edge) => ({
    edge_type: edge.type,
    node: gateProjection(snapshot, edge.from),
    satisfied: isSatisfiedV2(snapshot, edge.from),
  }));
}

/** Project knowledge matching the target node's explicit scopes. */
export function knowledgeForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerKnowledgeForNode({ snapshot, id: targetId });
}

/** Project INFORMS relations as inline nodes. */
export function informingForNode(input, id) {
  const { snapshot, id: targetId } = projectionArgs(input, id);
  return providerInformingForNode({ snapshot, id: targetId });
}

// Descriptive aliases for new consumers. The V2 names are retained only as
// compatibility aliases for callers that use the versioned state vocabulary.
export const deriveReadModel = derive;
export const statusOfV2 = statusOf;
export const projectStatus = statusOf;
export const projectBlocking = blockingForNode;
export const projectKnowledge = knowledgeForNode;
export const projectInforming = informingForNode;

function compareText(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Project one serialized state read for a public plugin query.
 *
 * The state is deliberately passed in by the caller so all fields in the
 * result are derived from the same read. Core nodes are copied without other
 * plugins' node namespaces; the selected plugin namespace is exposed in the
 * root and on the nodes that contain it. Rebuilding records in sorted order
 * and sorting edge triples makes JSON output repeatable for the same state.
 */
export function projectSnapshot({ snapshot, pluginId } = {}) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const sourceNodes = source.nodes && typeof source.nodes === "object" ? source.nodes : {};
  const nodes = {};
  const nodeIds = Object.keys(sourceNodes).sort(compareText);

  for (const id of nodeIds) {
    const sourceNode = sourceNodes[id];
    if (!sourceNode || typeof sourceNode !== "object" || Array.isArray(sourceNode)) continue;
    const node = clone(sourceNode);
    const nodePlugins = node.plugins;
    delete node.plugins;
    if (pluginId && nodePlugins && typeof nodePlugins === "object" &&
        Object.prototype.hasOwnProperty.call(nodePlugins, pluginId)) {
      node.plugins = { [pluginId]: clone(nodePlugins[pluginId]) };
    }
    nodes[id] = node;
  }

  const edges = (Array.isArray(source.edges) ? source.edges : [])
    .filter((edge) => edge && typeof edge === "object" && !Array.isArray(edge))
    .map(clone)
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.type, b.type));

  const derived = {};
  for (const id of nodeIds) {
    if (Object.prototype.hasOwnProperty.call(nodes, id)) {
      derived[id] = statusOf({ snapshot: source, id });
    }
  }

  const plugins = {};
  const sourcePlugins = source.plugins && typeof source.plugins === "object" ? source.plugins : {};
  if (pluginId && Object.prototype.hasOwnProperty.call(sourcePlugins, pluginId)) {
    plugins[pluginId] = clone(sourcePlugins[pluginId]);
  }

  return {
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    nodes,
    edges,
    derived,
    plugins,
  };
}

export { deriveV2, isSatisfiedV2 };
export {
  gateProjection,
  isCurrent,
  supersededBy,
};
