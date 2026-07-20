import { addV2Node, requireFields } from "../v2-add-node.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = [
  "initiative",
  "title",
  "body",
  "purpose",
  "resolution-mode",
  "blocked-by",
  "supersedes",
  "derived-from",
  "domain",
  "tags",
  "refs",
  "meta",
  "as",
];

export default async function addGate(ctx) {
  requireFields("add-gate", ctx.flags, ["initiative", "title", "body", "purpose"]);
  // F8: resolve here so MISSING_AGENT surfaces as `add-gate:`.
  resolveAgent(ctx.flags, "add-gate");
  return addV2Node("add-gate", "G", { kind: "resolvable", subkind: "gate" }, ctx);
}
