import { createOperationBridge } from "../../../application/operations/index.mjs";
import { throwV2 } from "../../../contracts/errors.mjs";

export async function executeRemoteResolvableLifecycle({
  backendClient,
  actor,
  verb,
  input,
  id,
  command,
}) {
  if (!backendClient || backendClient.type !== "remote") return null;
  if (typeof backendClient.executeOperation !== "function" || typeof backendClient.executeBatch !== "function") {
    throwV2("INVALID_OPERATION_BRIDGE", `${command}: remote backend client does not support operation execution`);
  }

  const inspected = await backendClient.readNode({ id });
  const target = inspected && inspected.node ? inspected.node : null;
  if (!target || target.kind !== "resolvable" || !["task", "gate"].includes(target.subkind)) {
    throwV2(
      "REMOTE_UNSUPPORTED_OPERATION",
      `${command}: remote ${target ? `${target.kind}/${target.subkind || "?"}` : "target"} is not a task or gate operation owned by this adapter`,
      { command, id, kind: target && target.kind, subkind: target && target.subkind },
    );
  }

  const normalizedInput = { ...input };
  delete normalizedInput.actor;
  const bridge = createOperationBridge({ backendClient });
  const mutation = await bridge.executeOperation({
    actor,
    operation: `${target.subkind}.${verb}`,
    input: normalizedInput,
  });
  const entries = mutation && mutation.diff && Array.isArray(mutation.diff.updated)
    ? mutation.diff.updated
    : [];
  const node = entries.find((entry) => entry.id === id)?.node || target ||
    (mutation && mutation.node) || (mutation && mutation.result && mutation.result.node) || null;
  return { mutation, node };
}
