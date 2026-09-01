// T-plugin-policy-fixture — fixture contract + e2e smoke for the
// V2-policy fixture (ADR-007 §"Discovery global" and §"Contrato de
// autorización").
//
// The fixture at test/fixtures/plugins/policy-fixture/ exposes
// default.policy = { applies, authorize } alongside default.commands.
// Subcommands on the fixture namespace let this test verify
// applies/authorize behavior without depending on src/plugins/policy.mjs
// (which is covered by T-plugin-policy-foundation). The same contract is exercised
// end-to-end by the seam tests in
// T-plugin-policy-seam-lifecycle / T-plugin-policy-seam-dag /
// T-plugin-policy-migration-tests.
//
// What this suite covers:
//   - Fixture contract: descriptor + zero deps + default.commands
//     + default.policy with applies/authorize.
//   - Install: fixture installs under CLIMIER_HOME/plugins/installed/
//     policy-fixture and dispatches by command namespace.
//   - applies: explicit true / false via the namespace; ignores
//     other plugins' namespaces (own namespace only per ADR-007).
//   - authorize: allow / deny / abstain / throw / slow modes; actor
//     and action passed through unchanged; projectConfig is frozen.
//   - recorded: authorize persists its last invocation for audit
//     (used by downstream tests).
//   - Uninstall: cleanup helper removes the installed dir.
//
// All mutations run through helpers.mjs (auto-managed CLIMIER_HOME
// under os.tmpdir()). Each test installs a fresh fixture; nothing
// touches the real ~/.climier tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createTempProject,
  rmTempProject,
  runCli,
  installPolicyFixture,
  uninstallPolicyFixture,
  POLICY_FIXTURE_DIR,
} from "./helpers.mjs";

const FIXTURE_ID = "policy-fixture";
const FIXTURE_COMMAND = "policy";

// ---- Per-test environment wrapper ----------------------------------

async function withFreshEnv(body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "climier-policy-fixture-"));
  const projectDir = await createTempProject();
  const prev = {
    CLIMIER_HOME: process.env.CLIMIER_HOME,
    CLIMIER_AGENT: process.env.CLIMIER_AGENT,
  };
  process.env.CLIMIER_HOME = home;
  // Force every dispatch to pass --as explicitly so the agent identity
  // is reproducible across the plugin and CLI paths.
  delete process.env.CLIMIER_AGENT;
  try {
    return await body({ home, projectDir });
  } finally {
    if (prev.CLIMIER_HOME === undefined) delete process.env.CLIMIER_HOME;
    else process.env.CLIMIER_HOME = prev.CLIMIER_HOME;
    if (prev.CLIMIER_AGENT === undefined) process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    else process.env.CLIMIER_AGENT = prev.CLIMIER_AGENT;
    await fs.rm(home, { recursive: true, force: true });
    await rmTempProject(projectDir);
  }
}

async function cli(args) {
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(
      `climier exited ${result.code}\n` +
        `argv: ${JSON.stringify(args)}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

async function writeClimierJson(projectDir, value) {
  await fs.writeFile(
    path.join(projectDir, ".climier.json"),
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

async function baseClimierJson(projectDir) {
  // A minimal .climier.json the plugin can read raw. The fixture only
  // cares about the `plugins["policy-fixture"]` namespace, so the rest
  // is just enough to keep the project metadata shape valid.
  await writeClimierJson(projectDir, {
    version: 1,
    project_id: "policy-fixture-project",
  });
}

// ---- Fixture contract ----------------------------------------------

test("fixture: package.json declares descriptor, type module, and no runtime dependencies", async () => {
  const pkgRaw = await fs.readFile(path.join(POLICY_FIXTURE_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.climier, {
    id: FIXTURE_ID,
    command: FIXTURE_COMMAND,
    entry: "./climier.mjs",
    api: 3,
  });
  for (const depKey of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    assert.ok(!(depKey in pkg), `fixture package.json must not declare ${depKey}`);
  }
});

test("fixture: default export exposes commands + policy with applies/authorize only", async () => {
  const mod = await import(path.join(POLICY_FIXTURE_DIR, "climier.mjs"));
  assert.ok(mod && typeof mod.default === "object" && mod.default !== null);
  const commands = mod.default.commands;
  assert.ok(commands && typeof commands === "object" && !Array.isArray(commands));
  for (const name of ["applies-check", "authorize-check", "recorded"]) {
    assert.equal(typeof commands[name], "function", `missing command '${name}'`);
  }
  const policy = mod.default.policy;
  assert.ok(policy && typeof policy === "object" && !Array.isArray(policy));
  // ADR-007 §"Entry único": no extra fields allowed inside policy.
  assert.deepEqual(Object.keys(policy).sort(), ["applies", "authorize"]);
  assert.equal(typeof policy.applies, "function");
  assert.equal(typeof policy.authorize, "function");
});

// ---- Install + discovery -------------------------------------------

test("e2e: install — fixture installs under CLIMIER_HOME and dispatches by command namespace", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_ID);
    const installRes = await installPolicyFixture(projectDir);
    assert.equal(installRes.plugin.id, FIXTURE_ID);
    assert.equal(installRes.plugin.command, FIXTURE_COMMAND);
    assert.equal(installRes.plugin.entry, "./climier.mjs");
    assert.equal(installRes.plugin.installed_dir, installedDir);
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed/<id> exists");

    // Dispatch by command namespace (the first non-flag token). The
    // bin's discovery scans installed/*/package.json for
    // descriptor.command === "policy" (no manifest).
    await baseClimierJson(projectDir);
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.command, "applies-check");
    // Without a namespace config, applies returns true (default applicable).
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, false);
  });
});

// ---- applies -------------------------------------------------------

test("e2e: applies — true when no namespace; true when applies=true; false when applies=false", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);

    // Case 1: no namespace at all.
    await baseClimierJson(projectDir);
    let out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, false);
    assert.deepEqual(out.namespace_keys, null);

    // Case 2: namespace present, applies=true (explicit opt-in).
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: true, mode: "allow" } },
    });
    out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, true);
    assert.ok(out.namespace_keys.includes("applies"));
    assert.ok(out.namespace_keys.includes("mode"));

    // Case 3: namespace present, applies=false (explicit opt-out).
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: false, mode: "allow" } },
    });
    out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, false);
    assert.equal(out.namespace_present, true);
  });
});

test("e2e: applies — ignores other plugins' namespaces (own namespace only)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    // Other plugins' applies=false in their own namespaces must NOT
    // affect policy-fixture's applies decision. ADR-007 §"Discovery
    // global": "El plugin solo lee su propio namespace".
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: {
        "other-plugin": { applies: false },
        "policy-fixture": { mode: "allow" },
      },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
    assert.equal(out.namespace_present, true);
    assert.ok(out.namespace_keys.includes("mode"));
    assert.ok(!out.namespace_keys.includes("applies"));
  });
});

test("e2e: applies — empty/malformed namespace falls back to true (defensive)", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    // Non-boolean applies value (string) must not silently opt out —
    // the fixture does strict boolean coercion.
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { applies: "false" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "applies-check",
    ]);
    assert.equal(out.applies, true);
  });
});

// ---- authorize -----------------------------------------------------

test("e2e: authorize — allow mode returns {decision:'allow'}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.equal(out.command, "authorize-check");
    assert.deepEqual(out.decision, { decision: "allow" });
    assert.equal(out.received.action, "task.take");
    assert.equal(out.received.actor, "fixture-agent");
  });
});

test("e2e: authorize — deny mode returns {decision:'deny', reason}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: {
        "policy-fixture": { mode: "deny", reason: "explicit deny from fixture" },
      },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "gate.resolve",
    ]);
    assert.deepEqual(out.decision, { decision: "deny", reason: "explicit deny from fixture" });
    assert.equal(out.received.action, "gate.resolve");
  });
});

test("e2e: authorize — deny mode uses default reason when none configured", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "deny" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.equal(out.decision.decision, "deny");
    assert.equal(typeof out.decision.reason, "string");
    assert.ok(out.decision.reason.length > 0);
  });
});

test("e2e: authorize — abstain mode returns {decision:'abstain'}", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "abstain" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    assert.deepEqual(out.decision, { decision: "abstain" });
  });
});

test("e2e: authorize — throw mode raises through the dispatcher", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "throw" } },
    });
    const result = await runCli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    // The dispatcher wraps the plugin's throw into PLUGIN_HANDLER_FAILED
    // (ADR-005 §"Dispatch y contrato de errores"). The fixture's throw
    // attaches code = "POLICY_ERROR_FIXTURE" but the dispatcher keeps
    // only the message in details.cause; verifying the message is
    // enough to prove the throw propagated and was not masked.
    assert.equal(result.code, 1);
    const err = JSON.parse(result.stdout);
    assert.equal(err.ok, false);
    assert.equal(err.error.code, "PLUGIN_HANDLER_FAILED");
    assert.ok(err.error.details && err.error.details.cause, "details.cause must be present");
    assert.match(err.error.details.cause, /mode 'throw' rejected the action/);

    // The fixture still records the throw attempt for audit — verify
    // a separate `recorded` call sees mode='throw' and the original
    // actor/action (recordLast runs before the throw inside authorize).
    const recorded = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.ok(recorded.recorded, "recorded payload must exist");
    assert.equal(recorded.recorded.mode, "throw");
    assert.equal(recorded.recorded.received.action, "task.take");
    assert.equal(recorded.recorded.received.actor, "fixture-agent");
  });
});

test("e2e: authorize — slow mode sleeps then allows", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    const slowMs = 80;
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "slow", slowMs } },
    });
    const start = Date.now();
    const out = await cli([
      "--project", projectDir,
      "--as", "fixture-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const elapsed = Date.now() - start;
    assert.deepEqual(out.decision, { decision: "allow" });
    assert.ok(
      elapsed >= slowMs,
      `slow mode must sleep at least ${slowMs}ms; elapsed=${elapsed}ms`,
    );
    // Generous upper bound: a hung timer would exceed this.
    assert.ok(
      elapsed < slowMs + 4000,
      `slow mode should not hang; elapsed=${elapsed}ms`,
    );
  });
});

test("e2e: authorize — actor/action passed through unchanged", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const out = await cli([
      "--project", projectDir,
      "--as", "alice",
      FIXTURE_COMMAND, "authorize-check", "gate.resolve",
    ]);
    assert.equal(out.received.action, "gate.resolve");
    assert.equal(out.received.actor, "alice");
    assert.equal(out.received.target_id, "T-fixture-target");
    assert.equal(out.received.target_kind, "resolvable");
    assert.equal(out.received.projectDir, projectDir);
    // The seam freezes the top-level projectConfig before passing it
    // to authorize (plan §3.3). The subcommand mirrors that contract.
    assert.equal(out.received.projectConfig_frozen, true);
    // The fixture only reads its own namespace; verify the namespace
    // keys were observable.
    assert.ok(Array.isArray(out.received.namespace_keys));
    assert.ok(out.received.namespace_keys.includes("mode"));
  });
});

test("e2e: authorize — distinct actor per invocation is observable in the received payload", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    const a = await cli([
      "--project", projectDir,
      "--as", "bob",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const b = await cli([
      "--project", projectDir,
      "--as", "carol",
      FIXTURE_COMMAND, "authorize-check", "task.release",
    ]);
    assert.equal(a.received.actor, "bob");
    assert.equal(a.received.action, "task.take");
    assert.equal(b.received.actor, "carol");
    assert.equal(b.received.action, "task.release");
  });
});

// ---- recorded -----------------------------------------------------

test("e2e: recorded — authorize persists last invocation for audit", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await writeClimierJson(projectDir, {
      version: 1,
      project_id: "policy-fixture-project",
      plugins: { "policy-fixture": { mode: "allow" } },
    });
    // Trigger an authorize so the fixture writes its last invocation.
    await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "authorize-check", "task.take",
    ]);
    const recorded = await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.equal(recorded.command, "recorded");
    assert.ok(recorded.recorded, "recorded payload must exist");
    assert.equal(recorded.recorded.mode, "allow");
    assert.equal(recorded.recorded.received.action, "task.take");
    assert.equal(recorded.recorded.received.actor, "audit-agent");
    assert.ok(Array.isArray(recorded.recorded.namespace_keys));
    assert.ok(recorded.recorded.namespace_keys.includes("mode"));
  });
});

test("e2e: recorded — returns null when authorize has never been invoked", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    const recorded = await cli([
      "--project", projectDir,
      "--as", "audit-agent",
      FIXTURE_COMMAND, "recorded",
    ]);
    assert.equal(recorded.command, "recorded");
    assert.equal(recorded.recorded, null);
  });
});

// ---- Uninstall -----------------------------------------------------

test("e2e: uninstall — helper cleans up installed dir", async () => {
  await withFreshEnv(async ({ home, projectDir }) => {
    await installPolicyFixture(projectDir);
    const installedDir = path.join(home, "plugins", "installed", FIXTURE_ID);
    assert.ok((await fs.stat(installedDir)).isDirectory(), "installed before uninstall");
    await uninstallPolicyFixture(projectDir);
    await assert.rejects(
      fs.stat(installedDir),
      /ENOENT/,
      "installed dir must be gone after uninstall",
    );
  });
});

test("e2e: uninstall — re-running on an already-clean dir is a successful no-op", async () => {
  await withFreshEnv(async ({ projectDir }) => {
    await installPolicyFixture(projectDir);
    await uninstallPolicyFixture(projectDir);
    // Second uninstall must succeed without raising — the helper
    // surfaces PLUGIN_LOAD_FAILED-equivalent cleanly.
    const result = await uninstallPolicyFixture(projectDir);
    assert.ok(result && result.plugin);
    assert.equal(result.plugin.id, FIXTURE_ID);
    assert.equal(result.plugin.uninstalled, true);
  });
});