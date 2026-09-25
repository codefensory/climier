import { randomUUID } from "node:crypto";
import { addV2Node, hasCsvValue, requireFields } from "./internal/create-node.mjs";
import { throwV2 } from "../../contracts/errors.mjs";
import { resolveAgent } from "../actor.mjs";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

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
  const actor = resolveAgent(ctx.flags, "add-knowledge");
  if (ctx.backendClient?.type === "remote") {
    const id = ctx.positional[0] || `K-${randomUUID().slice(0, 8)}`;
    const input = {
      id,
      initiative: ctx.flags.initiative,
      title: ctx.flags.title,
      body: ctx.flags.body,
      knowledge_type: ctx.flags["knowledge-type"],
      mitigation: ctx.flags.mitigation,
      scope: {
        domains: ctx.flags["scope-domains"] ? String(ctx.flags["scope-domains"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
        initiatives: ctx.flags["scope-initiatives"] ? String(ctx.flags["scope-initiatives"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
        tags: ctx.flags["scope-tags"] ? String(ctx.flags["scope-tags"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
        node_ids: ctx.flags["scope-node-ids"] ? String(ctx.flags["scope-node-ids"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
      },
      domain: ctx.flags.domain,
      tags: ctx.flags.tags ? String(ctx.flags.tags).split(",").map((value) => value.trim()).filter(Boolean) : [],
      refs: ctx.flags.refs ? String(ctx.flags.refs).split(",").map((value) => value.trim()).filter(Boolean) : [],
      meta: ctx.flags.meta === undefined ? undefined : JSON.parse(String(ctx.flags.meta)),
      supersedes: ctx.flags.supersedes,
    };
    if (input.knowledge_type === undefined) delete input.knowledge_type;
    if (input.mitigation === undefined) delete input.mitigation;
    if (input.domain === undefined) delete input.domain;
    if (input.meta === undefined) delete input.meta;
    if (input.supersedes === undefined) delete input.supersedes;
    const mutation = await executeRemoteDomain({ backendClient: ctx.backendClient, actor, operation: "knowledge.create", input, command: "add-knowledge" });
    return { node: nodeFromMutation(mutation, id, "created") || mutation.result?.node || null };
  }
  return addV2Node("add-knowledge", "K", { kind: "knowledge" }, ctx);
}
