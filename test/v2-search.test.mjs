import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, runCli, writeState } from "./helpers.mjs";

function state(nodes) {
  return { version: 2, nodes, edges: [], initiatives: {}, log: [] };
}

function knowledge(id, overrides = {}) {
  return {
    id,
    kind: "knowledge",
    title: id,
    body: "",
    initiative: "docs",
    status: "active",
    ...overrides,
  };
}

test("search: matches active knowledge by case-insensitive substring", async () => {
  const dir = await createTempProject();
  try {
    const body = "R".repeat(210);
    await writeState(dir, state({
      "K-redis": knowledge("K-redis", { title: "Redis sessions", body, domain: "auth" }),
      "T-redis": { id: "T-redis", kind: "resolvable", title: "Redis task", status: "open" },
    }));

    const result = await runCli(["--project", dir, "search", "rEdIs"]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      matches: [{
        id: "K-redis",
        kind: "knowledge",
        title: "Redis sessions",
        initiative: "docs",
        domain: "auth",
        status: "active",
        matched_fields: ["id", "title"],
        snippet: body.slice(0, 200),
      }],
      count: 1,
    });
  } finally {
    await rmTempProject(dir);
  }
});

test("search: searches every supported field and reports matched_fields", async () => {
  const { default: search } = await importFresh("./commands/search.mjs");
  const dir = await createTempProject();
  try {
    await writeState(dir, state({
      "K-needle": knowledge("K-needle", {
        title: "Needle title",
        body: "Needle body",
        mitigation: "Needle mitigation",
        domain: "needle-domain",
        tags: ["needle-tag"],
        refs: [{ type: "external", target: "docs/needle.md" }],
        meta: { ticket: "NEEDLE-1" },
      }),
    }));

    const result = await search({ statePath: dir, positional: ["NEEDLE"], flags: {} });
    assert.deepEqual(result.matches[0].matched_fields, [
      "id", "title", "body", "mitigation", "domain", "tags", "refs", "meta",
    ]);
  } finally {
    await rmTempProject(dir);
  }
});

test("search: --all includes deprecated knowledge", async () => {
  const { default: search } = await importFresh("./commands/search.mjs");
  const dir = await createTempProject();
  try {
    await writeState(dir, state({
      "K-active": knowledge("K-active", { title: "shared active" }),
      "K-old": knowledge("K-old", { title: "shared deprecated", status: "deprecated" }),
    }));

    const active = await search({ statePath: dir, positional: ["shared"], flags: {} });
    const all = await search({ statePath: dir, positional: ["shared"], flags: { all: true } });
    assert.deepEqual(active.matches.map(({ id }) => id), ["K-active"]);
    assert.deepEqual(all.matches.map(({ id }) => id), ["K-active", "K-old"]);
  } finally {
    await rmTempProject(dir);
  }
});

test("search: empty query returns no matches", async () => {
  const { default: search } = await importFresh("./commands/search.mjs");
  const dir = await createTempProject();
  try {
    await writeState(dir, state({ "K-a": knowledge("K-a", { title: "Anything" }) }));
    assert.deepEqual(
      await search({ statePath: dir, positional: [""], flags: {} }),
      { matches: [], count: 0 },
    );
  } finally {
    await rmTempProject(dir);
  }
});

test("search: returns matches in deterministic id order", async () => {
  const { default: search } = await importFresh("./commands/search.mjs");
  const dir = await createTempProject();
  try {
    await writeState(dir, state({
      "K-z": knowledge("K-z", { body: "common" }),
      "K-a": knowledge("K-a", { body: "common" }),
      "K-m": knowledge("K-m", { body: "common" }),
    }));

    const result = await search({ statePath: dir, positional: ["common"], flags: {} });
    assert.deepEqual(result.matches.map(({ id }) => id), ["K-a", "K-m", "K-z"]);
  } finally {
    await rmTempProject(dir);
  }
});
