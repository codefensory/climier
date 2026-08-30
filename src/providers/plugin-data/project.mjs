// Pure provider for project-scoped plugin data writes.
// It never owns a lock, persistence or logging path.
import { throwV2 } from "../../contracts/errors.mjs";
import { cloneValue, nonEmpty, pluginIdFrom, planPolicyAction, validateValue } from "./common.mjs";

const OP = "plugin-data.project.set";
const LOG_ACTION = "plugin-data-set";

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

async function prepare({ snapshot, input, request, pluginId }) {
  const source = inputObject(input);
  const key = keyFrom(source);
  const value = validateValue(source, OP);
  const identity = pluginIdFrom(request, pluginId, OP);
  // `target.id` is only the policy/log target anchor. The operation's
  // redacted audit fields carry the actual project key; no value enters the
  // plan's logFields.
  return Object.freeze({
    target: Object.freeze({ id: identity, kind: "plugin-data-project", log_node: false }),
    policyAction: planPolicyAction(OP, identity),
    logAction: LOG_ACTION,
    logFields: Object.freeze({ scope: "project", key }),
    pluginId: identity,
    key,
    value,
  });
}

async function apply({ tx, plan }) {
  if (!tx || typeof tx.setProjectPluginData !== "function") {
    throwV2("INVALID_EXECUTION_CONTRACT", `${OP}: apply requires setProjectPluginData accessor`, { field: "tx" });
  }
  const value = tx.setProjectPluginData(plan.pluginId, plan.key, plan.value);
  return {
    result: Object.freeze({ key: plan.key, value: cloneValue(value, OP) }),
    effects: null,
  };
}

export const pluginDataProjectSetProvider = Object.freeze({ prepare, apply });
export const projectSetProvider = pluginDataProjectSetProvider;
