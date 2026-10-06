import test from "node:test";
import assert from "node:assert/strict";

import { parseBackendConfig } from "../src/application/backend-config.ts";

test("backend config defaults to local and accepts explicit local config", () => {
  assert.deepEqual(parseBackendConfig({ version: 1, project_id: "demo" }), { type: "local" });
  assert.deepEqual(parseBackendConfig({ backend: { type: "local" } }), { type: "local" });
});

test("backend config accepts credential-free HTTP and HTTPS origins", () => {
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test" } }),
    { type: "remote", url: "https://climier.example.test/" },
  );
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "http://climier.example.test" } }),
    { type: "remote", url: "http://climier.example.test/", insecureRemoteHttp: true },
  );
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "http://localhost:4312" } }),
    { type: "remote", url: "http://localhost:4312/" },
  );
});

test("backend config rejects an unsupported backend type", () => {
  assert.throws(
    () => parseBackendConfig({ backend: { type: "database" } }),
    /backend config: unsupported type/,
  );
});

test("backend config rejects any legacy protocol marker with a copyable relink", () => {
  for (const protocol of ["v1", "v2", null, "future"]) {
    assert.throws(
      () => parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test/api", protocol } }),
      (error) => error.code === "REMOTE_CONFIG_OUTDATED"
        && error.message.includes("https://climier.example.test/api")
        && error.message.includes("climier link https://climier.example.test/api")
        && error.message.includes(".climier.json")
        && error.details.configured_url === "https://climier.example.test/api",
    );
  }
});

test("backend config rejects malformed remote URLs", () => {
  for (const url of ["", "/relative", "ftp://climier.example.test"]) {
    assert.throws(
      () => parseBackendConfig({ backend: { type: "remote", url } }),
      /backend config: remote url/,
    );
  }
});

test("backend config marks only non-loopback HTTP as insecure", () => {
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "http://climier.example.test" } }),
    { type: "remote", url: "http://climier.example.test/", insecureRemoteHttp: true },
  );
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "http://localhost:4312" } }),
    { type: "remote", url: "http://localhost:4312/" },
  );
  assert.deepEqual(
    parseBackendConfig({ backend: { type: "remote", url: "https://climier.example.test" } }),
    { type: "remote", url: "https://climier.example.test/" },
  );
});

test("backend config rejects credentials in metadata and remote URLs", () => {
  for (const config of [
    { backend: { type: "remote", url: "https://user:password@climier.example.test" } },
    { backend: { type: "remote", url: "https://climier.example.test/?token=secret" } },
    { token: "secret", backend: { type: "remote", url: "https://climier.example.test" } },
    { backend: { type: "remote", url: "https://climier.example.test", token: "secret" } },
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
    { backend: { type: "remote", url: "https://climier.example.test", region: "west" } },
    { backend: { type: "local", url: "https://climier.example.test" } },
  ]) {
    assert.throws(() => parseBackendConfig(config), /backend config:/);
  }
});
