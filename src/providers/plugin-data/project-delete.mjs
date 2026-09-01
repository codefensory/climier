// Pure provider for deleting one key from project-scoped plugin data.
import { throwV2 } from "../../contracts/errors.mjs";
import { nonEmpty, pluginIdFrom, planPolicyAction } from "./common.mjs";

const OP = "plugin-data.project.delete";
const LOG_ACTION = "plugin-data-delete";

function inputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: input must be an object`, { field: "input" });
  }
  return input;
}

function keyFrom(input) {
  const key = nonEmpty(input.key);
  if (!key) throwV2("MISSING_FIELD", `${OP}: key is required`, { field: "key" });
  return key;
}

async function prepare({ input, request, pluginId }) {
  const source = inputObject(input);
  const key = keyFrom(source);
  const identity = pluginIdFrom(request, pluginId, OP);
  return Object.freeze({
    target: Object.freeze({ id: identity, kind: "plugin-data-project", log_node: false }),
    policyAction: planPolicyAction(OP, identity),
    logAction: LOG_ACTION,
    logFields: Object.freeze({ scope: "project", key }),
    pluginId: identity,
    key,
  });
}

async function apply({ tx, plan }) {
  if (!tx || typeof tx.deleteProjectPluginData !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: apply requires deleteProjectPluginData accessor`, { field: "tx" });
  }
  return {
    result: Object.freeze({ removed: tx.deleteProjectPluginData(plan.pluginId, plan.key) }),
    effects: null,
  };
}

export const pluginDataProjectDeleteProvider = Object.freeze({ prepare, apply });
export const projectDeleteProvider = pluginDataProjectDeleteProvider;
