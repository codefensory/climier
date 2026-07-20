import { addV2Node, hasCsvValue, requireFields } from "../v2-add-node.mjs";
import { throwV2 } from "../errors.mjs";
import { resolveAgent } from "../agent.mjs";

export const knownFlags = [
  "initiative",
  "title",
  "body",
  "scope-domains",
  "scope-initiatives",
  "scope-tags",
  "scope-node-ids",
  "domain",
  "tags",
  "refs",
  "meta",
  "knowledge-type",
  "mitigation",
  "supersedes",
  "derived-from",
  "as",
];

const SCOPE_FLAGS = ["scope-domains", "scope-initiatives", "scope-tags", "scope-node-ids"];

export default async function addKnowledge(ctx) {
  requireFields("add-knowledge", ctx.flags, ["initiative", "title", "body"]);
  if (!SCOPE_FLAGS.some((field) => hasCsvValue(ctx.flags[field]))) {
    throwV2("MISSING_FIELD", "add-knowledge: at least one --scope-* value is required", {
      field: "scope",
      command: "add-knowledge",
    });
  }
  // F8: resolve here so MISSING_AGENT surfaces as `add-knowledge:`.
  resolveAgent(ctx.flags, "add-knowledge");
  return addV2Node("add-knowledge", "K", { kind: "knowledge" }, ctx);
}
