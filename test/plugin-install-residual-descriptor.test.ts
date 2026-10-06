// Focused plugin install/uninstall tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { importFresh } from "./helpers.mjs";
import { requireTestModule as require } from "./plugin-install-test-helpers.mjs";
import { captureError as capture } from "./plugin-install-test-helpers.mjs";
import { DESCRIPTOR_MODULE } from "./plugin-install-test-helpers.mjs";

type PluginTestError = { code: string; message: string; details: Record<string, unknown> };

function asPluginError(error: unknown): PluginTestError {
  if (!error || typeof error !== "object") {
    throw new TypeError("expected plugin error");
  }
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    !candidate.details ||
    typeof candidate.details !== "object" ||
    Array.isArray(candidate.details)
  ) {
    throw new TypeError("expected structured plugin error");
  }
  return {
    code: candidate.code,
    message: candidate.message,
    details: candidate.details as Record<string, unknown>,
  };
}

test("plugin-descriptor: PLUGIN_ID_RE matches the ADR regex", () => {
  const { PLUGIN_ID_RE } = require(DESCRIPTOR_MODULE);
  assert.ok(PLUGIN_ID_RE.test("a"));
  assert.ok(PLUGIN_ID_RE.test("A"));
  assert.ok(PLUGIN_ID_RE.test("1abc"));
  assert.ok(PLUGIN_ID_RE.test("foo.bar"));
  assert.ok(PLUGIN_ID_RE.test("foo_bar"));
  assert.ok(PLUGIN_ID_RE.test("foo-bar"));
  assert.ok(PLUGIN_ID_RE.test("a.b-c_d"));
  assert.ok(!PLUGIN_ID_RE.test(""));
  assert.ok(!PLUGIN_ID_RE.test(".foo"));
  assert.ok(!PLUGIN_ID_RE.test("-foo"));
  assert.ok(!PLUGIN_ID_RE.test("_foo"));
  assert.ok(!PLUGIN_ID_RE.test("foo bar"));
  assert.ok(!PLUGIN_ID_RE.test("foo/bar"));
  assert.ok(!PLUGIN_ID_RE.test("foo@bar"));
});
test("plugin-descriptor: validateDescriptor rejects missing climier fields with PLUGIN_INVALID_DESCRIPTOR", () => {
  const { validateDescriptor } = require(DESCRIPTOR_MODULE);
  const cases = [
    [undefined, "object required"],
    [null, "object required"],
    [{}, "id"],
    [{ id: "ok.id" }, "command"],
    [{ id: "ok.id", command: "cmd" }, "entry"],
    [{ id: "ok.id", command: "cmd", entry: "", api: 1 }, "entry"],
    [{ id: "bad id", command: "cmd", entry: "./x.mjs", api: 1 }, "id regex"],
  ];
  for (const [descriptor, expected] of cases) {
    const err = capture(() => validateDescriptor(descriptor));
    assert.ok(err, `expected throw for ${JSON.stringify(descriptor)} (looking for: ${expected})`);
    assert.equal(err.code, "PLUGIN_INVALID_DESCRIPTOR");
  }
});
test("plugin-descriptor: strictly rejects API 3 with the expected version and reinstall guidance", () => {
  const { validateDescriptor } = require(DESCRIPTOR_MODULE);
  const base = { id: "ok.id", command: "cmd", entry: "./x.mjs" };
  const error = capture(() => validateDescriptor({ ...base, api: 3 }));
  assert.ok(error);
  assert.equal(error.code, "PLUGIN_API_INCOMPATIBLE");
  assert.equal(error.details.required, 1);
  assert.equal(error.details.received, 3);
  assert.match(error.message, /api: 1/);
  assert.match(error.message, /update.*reinstall|reinstall.*update/i);
  for (const api of [undefined, null, "1", 2, 4, 1.1]) {
    const descriptor = api === undefined ? base : { ...base, api };
    const err = capture(() => validateDescriptor(descriptor));
    assert.ok(err, `expected incompatibility for api=${String(api)}`);
    assert.equal(err.code, "PLUGIN_API_INCOMPATIBLE");
    assert.equal(err.details.required, 1);
    assert.equal(err.details.received, api ?? null);
  }
  assert.deepEqual(validateDescriptor({ ...base, api: 1 }), { ...base, api: 1 });
});
test("plugin-descriptor: importEntry rejects missing default.commands with PLUGIN_LOAD_FAILED", async () => {
  const { importEntry } = await importFresh(DESCRIPTOR_MODULE);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-entry-"));
  try {
    await fs.writeFile(
      path.join(dir, "entry.mjs"),
      "export default { notCommands: {} };\n",
      "utf8",
    );
    await assert.rejects(
      importEntry(path.join(dir, "entry.mjs")),
      (err) => asPluginError(err).code === "PLUGIN_LOAD_FAILED",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("plugin-descriptor: importEntry rejects entry that cannot be resolved with PLUGIN_LOAD_FAILED", async () => {
  const { importEntry } = await importFresh(DESCRIPTOR_MODULE);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "climier-plugin-entry-"));
  try {
    await assert.rejects(
      importEntry(path.join(dir, "missing.mjs")),
      (err) => {
        const error = asPluginError(err);
        assert.equal(error.code, "PLUGIN_LOAD_FAILED");
        assert.equal(error.details.entry, path.join(dir, "missing.mjs"));
        assert.equal(error.details.entry_url, pathToFileURL(path.join(dir, "missing.mjs")).href);
        assert.match(String(error.details.cause), /missing|cannot find|not found/i);
        return true;
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
