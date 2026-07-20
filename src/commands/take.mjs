// F9 — `take`: idempotently claim a ready v2 task for an agent.
//
// Semantics:
//   - If the agent already has an in_progress v2 task whose node matches
//     the filters, return it with `freshly_claimed: false`.
//   - Otherwise atomically claim the first alphabetically-sorted ready task
//     (filtered) and return it with `freshly_claimed: true`.
//   - If no task is ready and matches, throw NOT_READY.
//
// Filter keys: --initiative, --domain, --tag (each is an exact match;
// multiple filters are AND'd).
//
// Agent resolution: prefer `resolveAgent` from `src/agent.mjs` (added by F8;
// may not yet exist when this command is first run). Fall back to `flags.as`
// when the helper module is absent.

import { existsSync } from "node:fs";
import { readState, updateState } from "../state.mjs";
import { withLock } from "../lock.mjs";
import { append } from "../log.mjs";
import { blockingForNode, deriveV2, statusOfV2 } from "../v2.mjs";
import { throwV2 } from "../errors.mjs";

export const knownFlags = ["as", "initiative", "domain", "tag"];

const AGENT_HELPER_URL = new URL("../agent.mjs", import.meta.url);

// ponytail: F8 may add src/agent.mjs with a richer resolveAgent. We probe at
// module-load time so `take` works whether F8 has shipped or not.
async function loadAgentHelper() {
  if (!existsSync(AGENT_HELPER_URL)) return null;
  try {
    return await import(AGENT_HELPER_URL.href);
  } catch {
    return null;
  }
}

const agentHelper = await loadAgentHelper();

function resolveAgent(flags) {
  if (agentHelper && typeof agentHelper.resolveAgent === "function") {
    return agentHelper.resolveAgent(flags, "take");
  }
  // Fallback when src/agent.mjs is absent (F8 not yet shipped). Behavior
  // mirrors agent.mjs's intent: --as boolean true is rejected, missing
  // --as throws a clear error. Mirroring the env var here would be drift;
  // ship the agent.mjs instead.
  const as = flags.as;
  if (as === true) throw new Error("take: --as requires a value (e.g. --as alice)");
  if (typeof as === "string" && as.trim()) return as.trim();
  throw new Error("take: --as <agent> required");
}

function matchesFilter(node, flags) {
  if (flags.initiative && node.initiative !== flags.initiative) return false;
  if (flags.domain && node.domain !== flags.domain) return false;
  if (flags.tag) {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    if (!tags.includes(flags.tag)) return false;
  }
  return true;
}

function buildContext(state, id) {
  const node = state.nodes[id];
  return {
    derived_status: statusOfV2(state, id),
    revision: node.revision,
    claim: node.claim || null,
    blocking: blockingForNode(state, id),
    knowledge: [],
  };
}

function filterObject(flags) {
  return {
    initiative: flags.initiative || null,
    domain: flags.domain || null,
    tag: flags.tag || null,
  };
}

export default async function take({ statePath, flags }) {
  const projectDir = statePath;
  const agent = resolveAgent(flags);

  return withLock(projectDir, async () => {
    const s = await readState(projectDir);
    if (!s) {
      throwV2("NODE_NOT_FOUND", "take: state file missing; run `climier init --v2` first", { projectDir });
    }
    if (!s.version || s.version !== 2) {
      throwV2("NODE_NOT_FOUND", "take: requires a v2 state (run `climier init --v2`)", { version: s.version });
    }
    const nodes = s.nodes || {};

    // Idempotence: if the agent already has an in_progress task that
    // matches the filters, return it. Select deterministically (alpha).
    const own = Object.values(nodes)
      .filter((node) =>
        node.kind === "resolvable"
        && node.subkind === "task"
        && (node.status || "open") === "in_progress"
        && node.claim && node.claim.by === agent
        && matchesFilter(node, flags)
      )
      .map((node) => node.id)
      .sort();
    if (own.length > 0) {
      const id = own[0];
      return {
        node: nodes[id],
        context: buildContext(s, id),
        freshly_claimed: false,
      };
    }

    // Nothing claimed by this agent: find the first alphabetically-sorted
    // ready task that matches the filters.
    const derived = deriveV2(s);
    const candidates = derived.ready
      .filter((id) => matchesFilter(nodes[id], flags))
      .sort();
    if (candidates.length === 0) {
      throwV2("NOT_READY", "take: no ready task matches the filters", {
        filters: filterObject(flags),
        ready_total: derived.ready.length,
      });
    }

    const targetId = candidates[0];
    const target = nodes[targetId];
    // Defensive: under the file lock deriveV2() can't return a node that is
    // already in_progress by another agent, but guard so a stale read can't
    // silently hijack someone else's claim.
    if (target.claim && target.claim.by && target.claim.by !== agent) {
      throwV2("NOT_OWNER", `take: ${targetId} is claimed by ${target.claim.by}`, {
        id: targetId,
        owner: target.claim.by,
      });
    }

    const at = new Date().toISOString();
    const updated = await updateState(projectDir, (st) => {
      const t = st.nodes[targetId];
      t.claim = { by: agent, at };
      t.status = "in_progress";
      t.revision = (t.revision || 0) + 1;
      return st;
    });

    await append(projectDir, { agent, action: "take", node: targetId });

    const result = updated.nodes[targetId];
    return {
      node: result,
      context: buildContext(updated, targetId),
      freshly_claimed: true,
    };
  });
}
