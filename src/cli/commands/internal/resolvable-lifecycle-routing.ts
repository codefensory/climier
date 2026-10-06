import { throwV2 } from "../../../contracts/errors.ts";
import { routeRemoteOperation } from "./domain-routing.ts";

export async function executeRemoteResolvableLifecycle({
  backendClient,
  actor,
  verb,
  input,
  id,
  command,
}) {
  const routed = await routeRemoteOperation({
    backendClient,
    actor,
    operation: `${verb}`,
    selectOperation: (target) => `${target!.subkind}.${verb}`,
    input,
    command,
    targetId: id as string,
    acceptsTarget: (target) => target.kind === "resolvable" && ["task", "gate"].includes(target.subkind || ""),
    rejectTarget: (error, targetId) => {
      throwV2(
        "REMOTE_UNSUPPORTED_OPERATION",
        `${command}: remote ${error.details?.kind ? `${error.details.kind}/${error.details.subkind || "?"}` : "target"} is not a task or gate operation owned by this adapter`,
        { command, id: targetId as string, ...error.details },
      );
    },
    collection: "updated",
    useTargetFallback: true,
  });
  return routed && { mutation: routed.mutation, node: routed.node };
}
