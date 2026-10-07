/* eslint-disable max-nested-callbacks -- Wrapper integration tests keep setup and detailed error assertions in one case. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempProject, rmTempProject, importFresh, readState, runCli } from "./helpers.mjs";

type TestError = {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
};

type WrapperFlags = Record<string, string>;
type WrapperFactory = () => WrapperFlags;

const asTestError = (error: unknown): TestError => error as TestError;

const taskFlags = (): WrapperFlags => ({
  initiative: "auth",
  title: "Implement sessions",
  body: "Replace JWT validation",
  acceptance: "Opaque sessions authenticate",
  "blocked-by": "",
});

const gateFlags = (): WrapperFlags => ({
  initiative: "auth",
  title: "Choose session model",
  body: "Pick the canonical model",
  purpose: "decision",
});

const knowledgeFlags = (): WrapperFlags => ({
  initiative: "auth",
  title: "Refresh session TTL",
  body: "Sessions expire unless refreshed",
  "scope-domains": "auth",
});

async function withProject(fn, { register = true } = {}) {
  const dir = await createTempProject();
  try {
    const { default: init } = await importFresh("./cli/commands/init.ts");
    await init({ statePath: dir, positional: [], projectDir: dir });
    if (register) {
      const { default: addInitiative } = await importFresh("./cli/commands/add-initiative.ts");
      await addInitiative({ statePath: dir, flags: { desc: "Auth migration" }, positional: ["auth"] });
    }
    await fn(dir);
  } finally {
    await rmTempProject(dir);
  }
}

async function command(name) {
  return (await importFresh(`./cli/commands/${name}.ts`)).default;
}

function assertMissing(commandName, field) {
  return (err) => {
    assert.equal(err.code, "MISSING_FIELD");
    assert.deepEqual(err.details, { field, command: commandName });
    return true;
  };
}

test("add-task: creates a task through add-node and maps --blocked-by", async () => {
  await withProject(async (dir) => {
    const addNode = await command("add-node");
    await addNode({
      statePath: dir,
      positional: ["G-auth"],
      flags: { kind: "resolvable", subkind: "gate", initiative: "auth", title: "Auth choice" },
    });

    const addTask = await command("add-task");
    const out = await addTask({
      statePath: dir,
      projectDir: dir,
      positional: ["T-auth"],
      flags: { ...taskFlags(), "blocked-by": "G-auth", definition: "Implement middleware", tags: "api,auth" },
    });

    assert.equal(out.node.id, "T-auth");
    assert.equal(out.node.kind, "resolvable");
    assert.equal(out.node.subkind, "task");
    assert.equal(out.node.body, "Replace JWT validation");
    assert.equal(out.node.acceptance, "Opaque sessions authenticate");
    assert.deepEqual(out.node.tags, ["api", "auth"]);
    const state = await readState(dir);
    assert.deepEqual(state.edges, [{ from: "G-auth", to: "T-auth", type: "BLOCKS" }]);
  });
});

test("add-gate: creates a gate through add-node", async () => {
  await withProject(async (dir) => {
    const addGate = await command("add-gate");
    const out = await addGate({
      statePath: dir,
      projectDir: dir,
      positional: ["G-auth"],
      flags: { ...gateFlags(), "resolution-mode": "external", domain: "auth" },
    });

    assert.equal(out.node.id, "G-auth");
    assert.equal(out.node.kind, "resolvable");
    assert.equal(out.node.subkind, "gate");
    assert.equal(out.node.body, "Pick the canonical model");
    assert.equal(out.node.purpose, "decision");
    assert.equal(out.node.resolution_mode, "external");
  });
});

test("add-knowledge: creates scoped knowledge through add-node", async () => {
  await withProject(async (dir) => {
    const addKnowledge = await command("add-knowledge");
    const out = await addKnowledge({
      statePath: dir,
      projectDir: dir,
      positional: ["K-auth"],
      flags: { ...knowledgeFlags(), "knowledge-type": "constraint", mitigation: "Refresh on every request" },
    });

    assert.equal(out.node.id, "K-auth");
    assert.equal(out.node.kind, "knowledge");
    assert.equal(out.node.body, "Sessions expire unless refreshed");
    assert.equal(out.node.knowledge_type, "constraint");
    assert.equal(out.node.mitigation, "Refresh on every request");
    assert.deepEqual(out.node.scope, {
      domains: ["auth"],
      initiatives: [],
      tags: [],
      node_ids: [],
    });
  });
});

for (const field of ["initiative", "title", "body", "acceptance", "blocked-by"]) {
  test(`add-task: missing --${field} emits MISSING_FIELD`, async () => {
    await withProject(async (dir) => {
      const flags = taskFlags();
      delete flags[field];
      const addTask = await command("add-task");
      await assert.rejects(
        addTask({ statePath: dir, projectDir: dir, positional: ["T-auth"], flags }),
        assertMissing("add-task", field),
      );
    });
  });
}

test('add-task: missing --blocked-by explains that --blocked-by "" is valid', async () => {
  await withProject(async (dir) => {
    const flags = taskFlags();
    delete flags["blocked-by"];
    const addTask = await command("add-task");
    await assert.rejects(
      addTask({ statePath: dir, projectDir: dir, positional: ["T-auth"], flags }),
      (err) => {
        const caught = asTestError(err);
        assert.equal(caught.code, "MISSING_FIELD");
        assert.match(caught.message ?? "", /--blocked-by/);
        assert.match(caught.message ?? "", /""/);
        return true;
      },
    );
  });
});

test("add-task: an explicitly empty --blocked-by means no blockers", async () => {
  await withProject(async (dir) => {
    const addTask = await command("add-task");
    const out = await addTask({ statePath: dir, projectDir: dir, positional: ["T-auth"], flags: taskFlags() });
    assert.equal(out.node.id, "T-auth");
    assert.deepEqual((await readState(dir)).edges, []);
  });
});

for (const field of ["initiative", "title", "body", "purpose"]) {
  test(`add-gate: missing --${field} emits MISSING_FIELD`, async () => {
    await withProject(async (dir) => {
      const flags = gateFlags();
      delete flags[field];
      const addGate = await command("add-gate");
      await assert.rejects(
        addGate({ statePath: dir, projectDir: dir, positional: ["G-auth"], flags }),
        assertMissing("add-gate", field),
      );
    });
  });
}

for (const field of ["initiative", "title", "body"]) {
  test(`add-knowledge: missing --${field} emits MISSING_FIELD`, async () => {
    await withProject(async (dir) => {
      const flags = knowledgeFlags();
      delete flags[field];
      const addKnowledge = await command("add-knowledge");
      await assert.rejects(
        addKnowledge({ statePath: dir, projectDir: dir, positional: ["K-auth"], flags }),
        assertMissing("add-knowledge", field),
      );
    });
  });
}

test("add-knowledge: missing every --scope-* emits MISSING_FIELD", async () => {
  await withProject(async (dir) => {
    const flags = knowledgeFlags();
    delete flags["scope-domains"];
    const addKnowledge = await command("add-knowledge");
    await assert.rejects(
      addKnowledge({ statePath: dir, projectDir: dir, positional: ["K-auth"], flags }),
      assertMissing("add-knowledge", "scope"),
    );
  });
});

test("add-knowledge: empty values for every --scope-* emit MISSING_FIELD", async () => {
  await withProject(async (dir) => {
    const flags = {
      ...knowledgeFlags(),
      "scope-domains": "",
      "scope-initiatives": "",
      "scope-tags": "",
      "scope-node-ids": "",
    };
    const addKnowledge = await command("add-knowledge");
    await assert.rejects(
      addKnowledge({ statePath: dir, projectDir: dir, positional: ["K-auth"], flags }),
      assertMissing("add-knowledge", "scope"),
    );
  });
});

for (const [name, id, flags] of [
  ["add-task", "T-auth", taskFlags],
  ["add-gate", "G-auth", gateFlags],
  ["add-knowledge", "K-auth", knowledgeFlags],
] as Array<[string, string, WrapperFactory]>) {
  test(`${name}: rejects an unregistered initiative`, async () => {
    await withProject(async (dir) => {
      const add = await command(name);
      await assert.rejects(
        add({ statePath: dir, projectDir: dir, positional: [id], flags: { ...flags(), initiative: "ghost" } }),
        (err) => {
          const caught = asTestError(err);
          return caught.code === "INITIATIVE_NOT_FOUND" && caught.details?.initiative === "ghost";
        },
      );
    }, { register: false });
  });
}

for (const [name, prefix, flags] of [
  ["add-task", "T-", taskFlags],
  ["add-gate", "G-", gateFlags],
  ["add-knowledge", "K-", knowledgeFlags],
] as Array<[string, string, WrapperFactory]>) {
  test(`${name}: generates an id with the ${prefix} prefix when omitted`, async () => {
    await withProject(async (dir) => {
      const add = await command(name);
      const out = await add({ statePath: dir, projectDir: dir, positional: [], flags: flags() });
      assert.equal(typeof out.node.id, "string");
      assert.ok(out.node.id.startsWith(prefix), out.node.id);
      assert.equal((await readState(dir)).nodes[out.node.id].id, out.node.id);
    });
  });
}

for (const [name, flags] of [
  ["add-task", taskFlags],
  ["add-gate", gateFlags],
  ["add-knowledge", knowledgeFlags],
] as Array<[string, WrapperFactory]>) {
  test(`${name}: rejects a provided id outside the allowed format`, async () => {
    await withProject(async (dir) => {
      const add = await command(name);
      await assert.rejects(
        add({ statePath: dir, projectDir: dir, positional: ["bad/id"], flags: flags() }),
        (err) => {
          const caught = asTestError(err);
          return caught.code === "INVALID_ID"
            && caught.details?.id === "bad/id"
            && caught.details?.pattern === "^[A-Za-z0-9_.-]+$";
        },
      );
    });
  });
}

test("add wrappers route local creates through the operation bridge", async () => {
  await withProject(async (dir) => {
    const calls: Array<{ operation: string; input: { id?: string } }> = [];
    const backendClient = {
      type: "local",
      async executeOperation(args) {
        calls.push(args);
        const node = { id: args.input.id, kind: args.operation === "knowledge.create" ? "knowledge" : "resolvable" };
        return { result: { id: node.id, node }, diff: { created: [{ id: node.id, node }] } };
      },
      async executeBatch() { throw new Error("unexpected batch request"); },
    };
    const context = { statePath: dir, projectDir: dir, backendClient };

    await (await command("add-task"))({
      ...context,
      positional: ["T-bridge"],
      flags: taskFlags(),
    });
    await (await command("add-gate"))({
      ...context,
      positional: ["G-bridge"],
      flags: gateFlags(),
    });
    await (await command("add-knowledge"))({
      ...context,
      positional: ["K-bridge"],
      flags: knowledgeFlags(),
    });
    await (await command("add-node"))({
      ...context,
      positional: ["T-low-bridge"],
      flags: { kind: "resolvable", subkind: "task", initiative: "auth", title: "Low-level" },
    });

    assert.deepEqual(calls.map(({ operation }) => operation), [
      "task.create", "gate.create", "knowledge.create", "task.create",
    ]);
  });
});

test("CLI: add-task, add-gate, and add-knowledge wrappers dispatch end-to-end", async () => {
  const dir = await createTempProject();
  try {
    let r = await runCli(["--project", dir, "init"]);
    assert.equal(r.code, 0, r.stdout);
    r = await runCli(["--project", dir, "add-initiative", "auth", "--desc", "Auth migration"]);
    assert.equal(r.code, 0, r.stdout);
    r = await runCli([
      "--project", dir, "add-gate", "G-auth",
      "--initiative", "auth", "--title", "Choose model", "--body", "Pick one", "--purpose", "decision",
    ]);
    assert.equal(r.code, 0, r.stdout);
    r = await runCli([
      "--project", dir, "add-task",
      "--initiative", "auth", "--title", "Implement", "--body", "Build it",
      "--acceptance", "It works", "--blocked-by", "G-auth",
    ]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(JSON.parse(r.stdout).node.id, /^T-/);
    r = await runCli([
      "--project", dir, "add-knowledge",
      "--initiative", "auth", "--title", "TTL", "--body", "Refresh it", "--scope-domains", "auth",
    ]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(JSON.parse(r.stdout).node.id, /^K-/);
  } finally {
    await rmTempProject(dir);
  }
});
