
import { loadInstalledPolicyPlugins, readProjectConfig } from "./loader.mjs";
import { PolicyError, PolicyConflict } from "./errors.mjs";

export async function loadApplicablePolicy({ projectDir }) {
  const projectConfig = await readProjectConfig(projectDir);
  const installed = await loadInstalledPolicyPlugins();

  const applicable = [];
  for (const candidate of installed) {
    const { policy, pluginId } = candidate;
    if (typeof policy.applies !== "function") {

      applicable.push(candidate);
      continue;
    }
    let result;
    try {
      result = await policy.applies(projectConfig);
    } catch (err) {

      throw new PolicyError(pluginId, "applies", err);
    }
    if (result) {applicable.push(candidate);}
  }

  if (applicable.length > 1) {
    throw new PolicyConflict(
      applicable.map((c) => c.pluginId),
      applicable.map((c) => c.namespace),
    );
  }
  if (applicable.length === 0) {return null;}
  const [selected] = applicable;
  return {
    pluginId: selected.pluginId,
    descriptor: selected.descriptor,
    policy: selected.policy,
    namespace: selected.namespace,
    entryPath: selected.entryPath,
    installedDir: selected.installedDir,
    projectConfig,
  };
}

function policyError(policy, action, reason) {
  const pluginId = policy?.pluginId || "(unknown)";
  throw new PolicyError(pluginId, action, reason);
}

function validateSelectedPolicy(policy, action) {
  if (!policy || typeof policy.policy !== "object" || policy.policy === null) {
    policyError(policy, action, "policy selector returned a non-policy object");
  }
  const { authorize } = policy.policy;
  if (typeof authorize !== "function") {
    policyError(policy, action, "policy.authorize is not a function");
  }
  return authorize;
}

async function invokePolicy(authorize, policy, action, context) {
  try {
    return await authorize(context);
  } catch (err) {
    throw new PolicyError(policy.pluginId, action, err);
  }
}

function invalidPolicyResponse(policy, action, result) {
  policyError(policy, action, `authorize returned a non-object: ${JSON.stringify(result)}`);
}

function normalizedDecision(result) {
  if (result.decision === "deny") {
    const reason = typeof result.reason === "string"
      ? result.reason
      : result.reason ?? "(no reason provided by policy)";
    return { decision: "deny", reason };
  }
  return { decision: result.decision };
}

function validatePolicyResult(policy, action, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    invalidPolicyResponse(policy, action, result);
  }
  if (["allow", "deny", "abstain"].includes(result.decision)) {
    return normalizedDecision(result);
  }
  policyError(policy, action, `authorize returned unknown decision: ${JSON.stringify(result.decision)}`);
}

export async function authorizeAction({
  policy,
  action,
  actor,
  target,
  snapshot,
  projectDir,
  projectConfig,
}) {
  if (policy === null || policy === undefined) {
    return { decision: "abstain" };
  }
  const authorize = validateSelectedPolicy(policy, action);
  const result = await invokePolicy(authorize, policy, action, {
    action,
    actor,
    target,
    snapshot,
    projectDir,
    projectConfig,
  });
  return validatePolicyResult(policy, action, result);
}

export function isPolicyError(err) {
  return Boolean(
    err &&
    typeof err.code === "string" &&
    err.code.startsWith("POLICY_") &&
    err.details !== undefined,
  );
}
