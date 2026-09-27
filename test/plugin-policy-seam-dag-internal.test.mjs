import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { importFresh, installPolicyFixture } from "./helpers.mjs";
import { baseClimierJson, buildEnvNamespace, cli, initProject, missingInitiativeError, recorded, registerInitiative, runCliRaw, withFreshEnv } from "./plugin-policy-seam-dag-helpers.mjs";

test("seam-dag: deprecate-knowledge with policy=deny returns POLICY_DENIED without mutating state", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    // Seed the project with mode=allow so the bootstrap add-knowledge
    // is not denied, then switch to mode=deny for the deprecate under test.
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-knowledge", "K-1",
       "--initiative", "alpha", "--title", "t", "--body", "b",
       "--scope-domains", "core"],
    );
    await baseClimierJson(projectDir, buildEnvNamespace("deny", { reason: "no deprecate" }));

    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "deprecate-knowledge", "K-1", "--reason", "obsolete",
    ]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "POLICY_DENIED");
    assert.equal(body.error.details.action, "knowledge.deprecate");

    const show = await cli(["--project", projectDir, "show", "K-1"]);
    assert.equal(show.node.status, "active");
  });
});

test("seam-dag: deprecate-knowledge adapter uses the kernel knowledge provider frontier", async () => {
  const source = await fs.readFile(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli", "commands", "deprecate-knowledge.mjs"),
    "utf8",
  );
  assert.match(source, new RegExp(String.raw`from ["']\.\.\/\.\.\/kernel\/mutate\.mjs["']`));
  assert.match(source, new RegExp(String.raw`from ["']\.\.\/\.\.\/providers\/knowledge\/deprecate\.mjs["']`));
  assert.match(source, /\bmutate\(/);
  for (const forbidden of ["../state.mjs", "../storage/lock.mjs", "../storage/log.mjs"]) {
    const importPattern = new RegExp(`from ["']${forbidden.replaceAll("/", "\\/")}["']`);
    assert.doesNotMatch(source, importPattern);
  }
});

test("seam-dag: addNodeInternal({ allowUnregisteredInitiative: true }) bypasses INITIATIVE_NOT_FOUND", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    const { addNodeInternal } = await importFresh("../src/cli/commands/internal/create-node.mjs");
    const out = await addNodeInternal({
      statePath: projectDir,
      projectDir,
      positional: ["T-ghost"],
      flags: {
        kind: "resolvable",
        subkind: "task",
        title: "ghost task",
        body: "body",
        acceptance: "acc",
        "blocked-by": "",
        as: "internal",
      },
      pluginId: null,
      allowUnregisteredInitiative: true,
    });
    assert.equal(out.node.id, "T-ghost");
    assert.equal(out.node.initiative, undefined);
  });
});

test("seam-dag: addNodeInternal without the flag still enforces INITIATIVE_NOT_FOUND", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    const { addNodeInternal } = await importFresh("../src/cli/commands/internal/create-node.mjs");
    await assert.rejects(
      addNodeInternal({
        statePath: projectDir,
        projectDir,
        positional: ["T-ghost"],
        flags: {
          kind: "resolvable",
          subkind: "task",
          title: "ghost",
          body: "b",
          acceptance: "a",
          "blocked-by": "",
          as: "internal",
        },
        pluginId: null,
      }),
      missingInitiativeError,
    );
  });
});

test("seam-dag: CLI add-task rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-task", "T-z",
      "--initiative", "alpha",
      "--title", "t", "--body", "b",
      "--acceptance", "a", "--blocked-by", "",
      "--allow-unregistered-initiative",
    ]);
    assert.equal(r.code, 2);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "CLI_USAGE_ERROR");
    assert.equal(body.error.details.command, "add-task");
    assert.equal(body.error.details.flag, "allow-unregistered-initiative");
  });
});

test("seam-dag: CLI add-node rejects --allow-unregistered-initiative as unknown flag", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    const r = await runCliRaw([
      "--project", projectDir, "--as", "agent-a",
      "add-node", "T-z",
      "--kind", "resolvable", "--subkind", "task",
      "--title", "t",
      "--allow-unregistered-initiative",
    ]);
    assert.equal(r.code, 2);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "CLI_USAGE_ERROR");
    assert.equal(body.error.details.command, "add-node");
    assert.equal(body.error.details.flag, "allow-unregistered-initiative");
  });
});

test("seam-dag: snapshot passed to authorize reflects the live state under the lock", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await initProject(projectDir);
    await registerInitiative(projectDir, "alpha");
    await installPolicyFixture(projectDir);
    await baseClimierJson(projectDir, buildEnvNamespace("allow"));
    // Pre-seed another task so the snapshot under the lock is not empty.
    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-pre",
       "--initiative", "alpha", "--title", "pre", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    await cli(
      ["--project", projectDir, "--as", "agent-a",
       "add-task", "T-post",
       "--initiative", "alpha", "--title", "post", "--body", "b",
       "--acceptance", "a", "--blocked-by", ""],
    );

    const rec = await recorded(projectDir);
    assert.equal(rec.recorded.received.action, "task.create");
    // projectConfig was frozen before being passed.
    assert.equal(rec.recorded.received.projectConfig_frozen, true);
    assert.deepEqual(rec.recorded.received.snapshot_keys.toSorted(), [
      "edges", "initiatives", "log", "nodes", "revision", "version",
    ], "public policy snapshots do not expose internal fence metadata");
    // The recorded payload exposes a target fingerprint (id/kind/subkind)
    // so the policy can branch on what's being created.
    assert.equal(rec.recorded.received.target.id, "T-post");
    assert.equal(rec.recorded.received.target.subkind, "task");
  });
});
