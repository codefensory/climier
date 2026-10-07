// Shared imports and pure state fixtures for knowledge provider contract tests.

import { importFresh } from "../helpers.ts";

export async function importProviders() {
  return importFresh("providers/knowledge/index.ts");
}

export async function importKernel() {
  return importFresh("kernel/mutate.ts");
}

export function emptySnapshot(extra = {}) {
  return {
    version: 5,
    revision: 0,
    initiatives: { auth: { desc: "auth", created_at: "2026-01-01T00:00:00.000Z" } },
    nodes: {},
    edges: [],
    log: [],
    ...extra,
  };
}

export function knowledgeNode(id, overrides = {}) {
  return {
    id,
    kind: "knowledge",
    title: `title for ${id}`,
    body: `body for ${id}`,
    initiative: "auth",
    status: "active",
    knowledge_type: "warning",
    revision: 1,
    scope: {},
    ...overrides,
  };
}

export function taskNode(id, overrides = {}) {
  return {
    id,
    kind: "resolvable",
    subkind: "task",
    title: `task ${id}`,
    initiative: "auth",
    status: "open",
    revision: 1,
    domain: "auth",
    tags: ["backend"],
    ...overrides,
  };
}
