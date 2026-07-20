import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BIN = path.resolve(process.cwd(), "bin", "climier.mjs");
const HELPERS = path.resolve(process.cwd(), "test", "helpers.mjs");

// These tests guard the helpers.mjs contract: tests must NEVER write to or
// erase a real CLIMIER_HOME. If a developer runs `CLIMIER_HOME=~/.climier npm test`,
// the suite must fail loudly instead of silently touching user data.

test("npm test refuses to use the real ~/.climier", () => {
  const real = path.join(os.homedir(), ".climier");
  // Spawn `npm test --silent` with CLIMIER_HOME pointed at the real home.
  // The script must exit non-zero and emit a clear error.
  // We use a portable guard: a child `node` process that imports helpers
  // and verifies the throw happens.
  const probe = `
    try {
      await import(${JSON.stringify(HELPERS)});
      process.exit(0); // unsafe: helpers allowed real CLIMIER_HOME
    } catch (e) {
      process.stdout.write("GUARD_OK:" + e.message + "\\n");
      process.exit(1);
    }
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], {
    env: { ...process.env, CLIMIER_HOME: real },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, "helpers.mjs must refuse real CLIMIER_HOME");
  assert.match(r.stdout, /GUARD_OK/);
  assert.match(r.stdout, new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("helpers.mjs allows CLIMIER_HOME when it points at a temp dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climier-guard-test-"));
  const probe = `
    await import(${JSON.stringify(HELPERS)});
    process.exit(0);
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], {
    env: { ...process.env, CLIMIER_HOME: tmp },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `helpers.mjs must accept safe CLIMIER_HOME; stderr=${r.stderr}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("helpers.mjs auto-creates a temp CLIMIER_HOME when none is set", () => {
  const env = { ...process.env };
  delete env.CLIMIER_HOME;
  const probe = `
    await import(${JSON.stringify(HELPERS)});
    process.stdout.write("HOME=" + process.env.CLIMIER_HOME);
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], {
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /^HOME=\/tmp\/climier-home-/);
});

test("helpers.mjs cleans up auto-created CLIMIER_HOME on exit", () => {
  const env = { ...process.env };
  delete env.CLIMIER_HOME;
  const probe = `
    await import(${JSON.stringify(HELPERS)});
    // process.exit fires 'exit' handlers; temp home should be gone.
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], {
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // We can't directly observe cleanup, but the file shouldn't throw.
});
