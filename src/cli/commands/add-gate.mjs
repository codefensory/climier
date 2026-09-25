import { addV2Node, requireFields } from "./internal/create-node.mjs";
import { resolveAgent } from "../actor.mjs";
import { randomUUID } from "node:crypto";
import { executeRemoteDomain, nodeFromMutation } from "./internal/domain-routing.mjs";

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
  const actor = resolveAgent(ctx.flags, "add-gate");
  if (ctx.backendClient?.type === "remote") {
    const id = ctx.positional[0] || `G-${randomUUID().slice(0, 8)}`;
    const input = {
      id,
      initiative: ctx.flags.initiative,
      title: ctx.flags.title,
      body: ctx.flags.body,
      purpose: ctx.flags.purpose,
      resolution_mode: ctx.flags["resolution-mode"],
      blocked_by: ctx.flags["blocked-by"] ? String(ctx.flags["blocked-by"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
      derived_from: ctx.flags["derived-from"] ? String(ctx.flags["derived-from"]).split(",").map((value) => value.trim()).filter(Boolean) : [],
      supersedes: ctx.flags.supersedes,
      domain: ctx.flags.domain,
      tags: ctx.flags.tags ? String(ctx.flags.tags).split(",").map((value) => value.trim()).filter(Boolean) : [],
      refs: ctx.flags.refs ? String(ctx.flags.refs).split(",").map((value) => value.trim()).filter(Boolean) : [],
      meta: ctx.flags.meta === undefined ? undefined : JSON.parse(String(ctx.flags.meta)),
    };
    if (input.derived_from.length === 0) delete input.derived_from;
    if (input.meta === undefined) delete input.meta;
    if (input.domain === undefined) delete input.domain;
    const mutation = await executeRemoteDomain({ backendClient: ctx.backendClient, actor, operation: "gate.create", input, command: "add-gate" });
    return { node: nodeFromMutation(mutation, id, "created") || mutation.result?.node || null };
  }
  return addV2Node("add-gate", "G", { kind: "resolvable", subkind: "gate" }, ctx);
}
