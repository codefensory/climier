// Pure provider for node-scoped plugin data writes.

// this provider only validates the typed request and mutates its draft
// keyspace through setNodePluginData.
import { throwV2 } from "../../contracts/errors.ts";
import { cloneValue, nonEmpty, pluginIdFrom, planPolicyAction, validateValue } from "./common.ts";

const OP = "plugin-data.node.set";
const LOG_ACTION = "plugin-data-set";
type NodePlan = {
  target: Readonly<{ id: string; kind: "plugin-data-node"; log_node: false }>;
  policyAction: object;
  logAction: string;
  logFields: Readonly<{ scope: "node"; node_id: string; key: null }>;
  pluginId: string;
  nodeId: string;
  value: unknown;
  if_revision?: Readonly<{ kind: string; id: string; value: number }>;
};

function inputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  return input;
}

function nodeIdFrom(input) {
  const id = nonEmpty(input.id || input.node_id);
  if (!id) {
    throwV2("MISSING_FIELD", `${OP}: node id is required`, { field: "id" });
  }
  return id;
}

function revisionPlan(id, input) {
  if (input.if_revision === undefined || input.if_revision === null) {
    return undefined;
  }
  const value = Number(input.if_revision);
  if (!Number.isInteger(value) || value < 1) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: if_revision must be a positive integer`, {
      field: "if_revision",
      value: input.if_revision,
    });
  }
  return Object.freeze({ kind: "single", id, value });
}

function validateTarget(snapshot, id) {
  const nodes = snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
  if (!nodes[id]) {
    throwV2("NODE_NOT_FOUND", `${OP}: node '${id}' not found`, { id });
  }
}

async function prepare({ snapshot, input, request, pluginId }) {
  const source = inputObject(input);
  const id = nodeIdFrom(source);
  validateTarget(snapshot, id);
  const value = validateValue(source, OP);
  const identity = pluginIdFrom(request, pluginId, OP);
  const ifRevision = revisionPlan(id, source);
  const plan: NodePlan = {
    target: Object.freeze({ id, kind: "plugin-data-node", log_node: false }),
    policyAction: planPolicyAction(OP, identity),
    logAction: LOG_ACTION,
    logFields: Object.freeze({ scope: "node", node_id: id, key: null }),
    pluginId: identity,
    nodeId: id,
    value,
  };
  if (ifRevision) {
    plan.if_revision = ifRevision;
  }
  return Object.freeze(plan);
}

async function apply({ tx, plan }) {
  if (!tx || typeof tx.setNodePluginData !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: apply requires setNodePluginData accessor`, { field: "tx" });
  }
  const value = tx.setNodePluginData(plan.pluginId, plan.nodeId, plan.value);
  return {
    result: Object.freeze({ id: plan.nodeId, value: cloneValue(value, OP) }),
    effects: null,
  };
}

export const pluginDataNodeSetProvider = Object.freeze({ prepare, apply });
export const nodeSetProvider = pluginDataNodeSetProvider;
