import test from "node:test";
import assert from "node:assert/strict";

import urlsCommand from "../src/cli/commands/urls.ts";
import { COMMANDS, HELP_TEXT, KNOWN_COMMANDS } from "../src/cli/dispatch.ts";
import { RESERVED_NAMESPACES } from "../src/cli/commands/reserved-namespaces.ts";
import { createTempProject, rmTempProject, writeCanonicalState } from "./helpers.ts";
import { runCliInProcess as runCli } from "./cli-harness.ts";

test("urls returns the local UI links and initiative deep link", async () => {
  const projectDir = await createTempProject();
  try {
    assert.equal((await runCli(["--project", projectDir, "init"])).code, 0);
    await writeCanonicalState(projectDir, {
      version: 1,
      initiatives: { "diseño UI/UX": { desc: "x" } },
      nodes: {},
      edges: [],
      log: [],
    });

    const base = await runCli(["--project", projectDir, "urls"]);
    assert.equal(base.code, 0, base.stderr);
    const baseData = JSON.parse(base.stdout);
    assert.equal(baseData.ui.backend, "local");
    assert.equal(baseData.ui.local_only, true);
    assert.equal(baseData.ui.urls.length, 5);
    assert.ok(baseData.ui.urls.every(({ url }) => url.includes(`?project=${baseData.ui.project_id}`)));

    const filtered = await runCli(["--project", projectDir, "urls", "--initiative", "diseño UI/UX"]);
    assert.equal(filtered.code, 0, filtered.stderr);
    const filteredData = JSON.parse(filtered.stdout);
    assert.equal(filteredData.ui.urls.length, 6);
    assert.equal(filteredData.ui.urls.at(-1).kind, "tasks");
    assert.match(filteredData.ui.urls.at(-1).url, /filter=%7B%22c%22%3A%5B/);
  } finally {
    await rmTempProject(projectDir);
  }
});

test("urls resolves task, gate, and knowledge deep links", async () => {
  const projectDir = await createTempProject();
  try {
    await runCli(["--project", projectDir, "init"]);
    await runCli(["--project", projectDir, "add-initiative", "demo", "--as", "alice"]);
    const task = JSON.parse((await runCli(["--project", projectDir, "add-task", "T-url", "--initiative", "demo", "--title", "t", "--body", "b", "--acceptance", "a", "--blocked-by", "", "--as", "alice"])).stdout).node.id;
    const gate = JSON.parse((await runCli(["--project", projectDir, "add-gate", "G-url", "--initiative", "demo", "--title", "g", "--body", "b", "--purpose", "decision", "--as", "alice"])).stdout).node.id;
    const knowledge = JSON.parse((await runCli(["--project", projectDir, "add-knowledge", "K-url", "--initiative", "demo", "--title", "k", "--body", "b", "--scope-domains", "api", "--as", "alice"])).stdout).node.id;

    for (const [id, kind, path] of [[task, "task", "/#/tasks/T-url"], [gate, "gate", "/#/gates/G-url"], [knowledge, "knowledge", "/#/knowledges?knowledge=K-url"]]) {
      const result = await runCli(["--project", projectDir, "urls", "--id", id]);
      assert.equal(result.code, 0, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.ui.urls.at(-1).kind, kind);
      if (kind === "knowledge") {
        assert.match(data.ui.urls.at(-1).url, /#\/knowledges\?.*knowledge=K-url/);
        assert.match(data.ui.urls.at(-1).label, /selection/);
      } else {
        assert.ok(data.ui.urls.at(-1).url.includes(path));
      }
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

test("urls rejects invalid combinations and missing targets", async () => {
  const projectDir = await createTempProject();
  try {
    await runCli(["--project", projectDir, "init"]);
    for (const args of [["--port", "0"], ["--port", "abc"], ["--origin", "https://example.test", "--port", "7373"], ["--initiative", "x", "--id", "T1"], ["extra"]]) {
      const result = await runCli(["--project", projectDir, "urls", ...args]);
      assert.equal(result.code, 2, args.join(" "));
      assert.equal(JSON.parse(result.stdout).error.code, "CLI_USAGE_ERROR");
    }
    for (const [flag, value, code] of [["--initiative", "missing", "INITIATIVE_NOT_FOUND"], ["--id", "missing", "NODE_NOT_FOUND"]]) {
      const result = await runCli(["--project", projectDir, "urls", flag, value]);
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.stdout).error.code, code);
    }
  } finally {
    await rmTempProject(projectDir);
  }
});

test("urls validates remote targets through the selected backend", async () => {
  const calls: unknown[] = [];
  const client = {
    type: "remote" as const,
    readInitiatives: async (options: unknown) => { calls.push(["initiatives", options]); return { initiatives: [{ name: "remote init" }] }; },
    readNode: async (options: unknown) => { calls.push(["node", options]); return { node: { id: "T-remote", kind: "resolvable", subkind: "task" } }; },
  };
  const context = {
    projectDir: "/not/read/locally",
    statePath: "/not/read/locally",
    projectConfig: { project_id: "remote-project", backend: { type: "remote", url: "https://remote.example.test" } },
    backendClient: client,
    flags: { initiative: "remote init" },
    positional: [],
  };
  const result = await urlsCommand(context as never);
  assert.equal(result.ui.origin, "https://remote.example.test");
  assert.equal(result.ui.local_only, false);
  assert.deepEqual(calls, [["initiatives", { all: true }]]);

  await urlsCommand({ ...context, flags: { id: "T-remote" } } as never);
  assert.deepEqual(calls.at(-1), ["node", { id: "T-remote" }]);
});

test("urls is wired into the public CLI surface", () => {
  assert.ok(Object.hasOwn(COMMANDS, "urls"));
  assert.ok(KNOWN_COMMANDS.includes("urls"));
  assert.ok(RESERVED_NAMESPACES.includes("urls"));
  assert.match(HELP_TEXT, /urls \[--initiative X\]/);
});
