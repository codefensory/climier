import { withBodyFile } from "./internal/text-file.mjs";
import { addV2Node, requireFields } from "./internal/create-node.mjs";
import { resolveAgent } from "../actor.mjs";

export const knownFlags = [
  "initiative",
  "title",
  "body",
  "body-file",
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
  ctx = { ...ctx, flags: await withBodyFile("add-gate", ctx.flags) };
  requireFields("add-gate", ctx.flags, ["initiative", "title", "body", "purpose"]);
  // Resolve the agent here so MISSING_AGENT surfaces as `add-gate:`.
  resolveAgent(ctx.flags, "add-gate");
  return addV2Node("add-gate", "G", { kind: "resolvable", subkind: "gate" }, ctx);
}
