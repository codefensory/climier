// Pure provider for deleting a plugin's node-scoped data.
import { throwV2 } from "../../contracts/errors.mjs";
import { nonEmpty, pluginIdFrom, planPolicyAction } from "./common.mjs";

const OP = "plugin-data.node.delete";
const LOG_ACTION = "plugin-data-delete";

function inputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  return input;
}

function nodeIdFrom(input) {
  const id = nonEmpty(input.id || input.node_id);
  if (!id) throwV2("MISSING_FIELD", `${OP}: node id is required`, { field: "id" });
  return id;
}

function validateTarget(snapshot, id) {
  const nodes = snapshot && snapshot.nodes && typeof snapshot.nodes === "object" ? snapshot.nodes : {};
  if (!nodes[id]) throwV2("NODE_NOT_FOUND", `${OP}: node '${id}' not found`, { id });
}

async function prepare({ snapshot, input, request, pluginId }) {
  const source = inputObject(input);
  const nodeId = nodeIdFrom(source);
  validateTarget(snapshot, nodeId);
  const identity = pluginIdFrom(request, pluginId, OP);
  return Object.freeze({
    target: Object.freeze({ id: nodeId, kind: "plugin-data-node", log_node: false }),
    policyAction: planPolicyAction(OP, identity),
    logAction: LOG_ACTION,
    logFields: Object.freeze({ scope: "node", node_id: nodeId, key: null }),
    pluginId: identity,
    nodeId,
  });
}

async function apply({ tx, plan }) {
  if (!tx || typeof tx.deleteNodePluginData !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: apply requires deleteNodePluginData accessor`, { field: "tx" });
  }
  return {
    result: Object.freeze({ removed: tx.deleteNodePluginData(plan.pluginId, plan.nodeId) }),
    effects: null,
  };
}

export const pluginDataNodeDeleteProvider = Object.freeze({ prepare, apply });
export const nodeDeleteProvider = pluginDataNodeDeleteProvider;
