import { loadInstalledPolicyPlugins, readProjectConfig } from "./loader.ts";
import type { InstalledPolicyPlugin } from "./loader.ts";
import type { PluginPolicy } from "./descriptor.ts";
import { PolicyError, PolicyConflict } from "./errors.ts";
import { isRecord } from "../application/types.ts";

type SelectedPolicy = InstalledPolicyPlugin & { projectConfig: Record<string, unknown> };
type PolicyDecision = { decision: "allow" | "deny" | "abstain"; reason?: string };

export async function loadApplicablePolicy({ projectDir }: { projectDir: string }): Promise<SelectedPolicy | null> {
  const projectConfig = await readProjectConfig(projectDir);
  const installed = await loadInstalledPolicyPlugins();

  const applicable: InstalledPolicyPlugin[] = [];
  for (const candidate of installed) {
    const { policy, pluginId } = candidate;
    if (typeof policy.applies !== "function") {
      applicable.push(candidate);
      continue;
    }
    let result: unknown;
    try {
      result = await policy.applies(projectConfig);
    } catch (err: unknown) {
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

function policyError(policy: unknown, action: string, reason: unknown): never {
  const pluginId = isRecord(policy) && typeof policy.pluginId === "string" ? policy.pluginId : "(unknown)";
  throw new PolicyError(pluginId, action, reason);
}

function validateSelectedPolicy(policy: unknown, action: string): PluginPolicy["authorize"] {
  if (!isRecord(policy) || !isRecord(policy.policy)) {
    policyError(policy, action, "policy selector returned a non-policy object");
  }
  const authorize = policy.policy.authorize;
  if (typeof authorize !== "function") {
    policyError(policy, action, "policy.authorize is not a function");
  }
  return authorize as PluginPolicy["authorize"];
}

async function invokePolicy(
  authorize: PluginPolicy["authorize"],
  policy: SelectedPolicy,
  action: string,
  context: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await authorize(context);
  } catch (err: unknown) {
    throw new PolicyError(policy.pluginId, action, err);
  }
}

function invalidPolicyResponse(policy: unknown, action: string, result: unknown): never {
  policyError(policy, action, `authorize returned a non-object: ${JSON.stringify(result)}`);
}

function normalizedDecision(result: Record<string, unknown>): PolicyDecision {
  if (result.decision === "deny") {
    const reason = typeof result.reason === "string"
      ? result.reason
      : result.reason ?? "(no reason provided by policy)";
    return { decision: "deny", reason: String(reason) };
  }
  return { decision: result.decision as "allow" | "abstain" };
}

function validatePolicyResult(policy: unknown, action: string, result: unknown): PolicyDecision {
  if (!isRecord(result)) {
    invalidPolicyResponse(policy, action, result);
  }
  if (["allow", "deny", "abstain"].includes(String(result.decision))) {
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
}: {
  policy: SelectedPolicy;
  action: string;
  actor: string;
  target?: unknown;
  snapshot: unknown;
  projectDir: string;
  projectConfig?: Record<string, unknown>;
}): Promise<PolicyDecision> {
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

export function isPolicyError(err: unknown): err is Error & { code: string; details: Record<string, unknown> } {
  return Boolean(
    isRecord(err) &&
    typeof err.code === "string" &&
    err.code.startsWith("POLICY_") &&
    err.details !== undefined,
  );
}
