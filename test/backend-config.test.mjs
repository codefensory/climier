import test from "node:test";
import assert from "node:assert/strict";

import { parseBackendConfig } from "../src/application/backend-config.mjs";

test("backend config defaults to local and accepts explicit local config", () => {
  assert.deepEqual(parseBackendConfig({ version: 1, project_id: "demo" }), { type: "local" });
  assert.deepEqual(parseBackendConfig({ backend: { type: "local" } }), { type: "local" });
});

test("backend config accepts a credential-free remote URL", () => {
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test", protocol: "v2" } }),
    { type: "remote", url: "https://climier.example.test/", protocol: "v2" },
  );
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "http://localhost:4312", protocol: "v2" } }),
    { type: "remote", url: "http://localhost:4312/", protocol: "v2" },
  );
});

test("backend config rejects an unsupported backend type", () => {
  assert.throws(
    () => parseBackendConfig({ backend: { type: "database" } }),
    /backend config: unsupported type/,
  );
});

test("backend config rejects remote config without protocol v2 as outdated", () => {
  assert.throws(
    () => parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test" } }),
    (error) => error.code === "REMOTE_CONFIG_OUTDATED" && /protocol v2/.test(error.message),
  );
});

test("backend config rejects malformed or insecure remote URLs", () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  try {
    for (const url of ["", "/relative", "ftp://climier.example.test", "http://climier.example.test"]) {
      assert.throws(
        () => parseBackendConfig({ backend: { type: "remote", url, protocol: "v2" } }),
        /backend config: remote url/,
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
    } else {
      process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;
    }
  }
});

test("backend config permits remote HTTP only with the exact operator opt-in", () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  try {
    for (const value of [undefined, "false", "TRUE", "true ", "1"]) {
      if (value === undefined) {
        delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
      } else {
        process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = value;
      }
      assert.throws(
        () => parseBackendConfig({ backend: { type: "remote", url: "http://climier.example.test", protocol: "v2" } }),
        /backend config: remote url must use HTTPS outside localhost/,
      );
    }

    process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
    assert.deepEqual(
      parseBackendConfig({ backend: { type: "remote", url: "http://climier.example.test", protocol: "v2" } }),
      { type: "remote", url: "http://climier.example.test/", protocol: "v2", insecureRemoteHttp: true },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
    } else {
      process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;
    }
  }
});

test("backend config keeps loopback HTTP independent of the opt-in", () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  try {
    assert.deepEqual(
      parseBackendConfig({ backend: { type: "remote", url: "http://localhost:4312", protocol: "v2" } }),
      { type: "remote", url: "http://localhost:4312/", protocol: "v2" },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
    } else {
      process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;
    }
  }
});

test("backend config keeps HTTPS remote config outside the insecure exception", () => {
  const previous = process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
  process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = "true";
  try {
    assert.deepEqual(
      parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test", protocol: "v2" } }),
      { type: "remote", url: "https://climier.example.test/", protocol: "v2" },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP;
    } else {
      process.env.CLIMIER_ALLOW_INSECURE_REMOTE_HTTP = previous;
    }
  }
});

test("backend config rejects credentials in metadata and remote URLs", () => {
  for (const config of [
    { backend: { type: "remote", url: "https://user:password@climier.example.test", protocol: "v2" } },
    { backend: { type: "remote", url: "https://climier.example.test/?token=secret", protocol: "v2" } },
    { token: "secret", backend: { type: "remote", url: "https://climier.example.test", protocol: "v2" } },
    { backend: { type: "remote", url: "https://climier.example.test", protocol: "v2", token: "secret" } },
  ]) {
    assert.throws(
      () => parseBackendConfig(config),
      /backend config: credentials must be provided outside .climier.json/,
    );
  }
});

test("backend config rejects invalid config shapes and extra backend fields", () => {
  for (const config of [
    null,
    [],
    { backend: null },
    { backend: { type: "remote", url: "https://climier.example.test", protocol: "v2", region: "west" } },
    { backend: { type: "local", url: "https://climier.example.test" } },
  ]) {
    assert.throws(() => parseBackendConfig(config), /backend config:/);
  }
});
