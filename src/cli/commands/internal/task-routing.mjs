import { throwV2 } from "../../../contracts/errors.mjs";
import { isRemoteBackend, locateRemoteNode, readRemoteNode, routeRemoteOperation } from "./domain-routing.mjs";

export { isRemoteBackend };

export function remoteNode(result) {
  return result && result.node ? result.node : null;
}

export { readRemoteNode };

export async function requireRemoteTask(backendClient, id, command) {
  return readRemoteNode(backendClient, id, command, (node) => node.kind === "resolvable" && node.subkind === "task")
    .catch((error) => {
      if (error?.code !== "REMOTE_UNSUPPORTED_OPERATION") throw error;
      throwV2(
        "REMOTE_UNSUPPORTED_OPERATION",
        `${command}: remote ${error.details?.kind ? `${error.details.kind}/${error.details.subkind || "?"}` : "target"} is not a task operation owned by this adapter`,
        { command, id, ...error.details },
      );
    });
}

export async function executeRemoteTask({
  backendClient,
  actor,
  operation,
  input,
  id,
  command,
  inspectTarget = false,
  collection = "updated",
}) {
  const routed = await routeRemoteOperation({
    backendClient,
    actor,
    operation,
    input,
    command,
    targetId: id,
    preReadTarget: inspectTarget,
    acceptsTarget: (node) => node.kind === "resolvable" && node.subkind === "task",
    rejectTarget: (error, targetId) => {
      throwV2(
        "REMOTE_UNSUPPORTED_OPERATION",
        `${command}: remote ${error.details?.kind ? `${error.details.kind}/${error.details.subkind || "?"}` : "target"} is not a task operation owned by this adapter`,
        { command, id: targetId, ...error.details },
      );
    },
    revision: operation === "task.update" ? { field: "if_revision", fallback: 1 } : null,
    collection,
    useTargetFallback: inspectTarget || operation === "task.take" || operation === "task.release",
    fallbackToResult: !["task.create", "task.take", "task.release"].includes(operation),
  });
  return routed && { mutation: routed.mutation, node: routed.node };
}

export function throwMissingRemoteNode(command, id) {
  throwV2("INVALID_EXECUTION_CONTRACT", `${command}: remote operation did not return node ${id}`, { id });
}
