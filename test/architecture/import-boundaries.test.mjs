import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  collectRelativeImports,
  findBoundaryViolations,
  relativeImportSpecifiers,
} from "./import-graph.mjs";

const BOUNDARIES = [
  {
    name: "kernel",
    directory: "src/kernel",
    forbiddenRoots: ["application", "plugins", "cli"],
  },
  {
    name: "providers",
    directory: "src/providers",
    forbiddenRoots: ["cli", "plugins", "storage"],
  },
  {
    name: "read-model",
    directory: "src/read-model",
    forbiddenRoots: ["cli", "plugins", "storage"],
  },
];

for (const boundary of BOUNDARIES) {
  test(`${boundary.name} does not import forbidden architectural roots`, async () => {
    const imports = await collectRelativeImports(boundary.directory);
    assert.ok(imports.length > 0, `${boundary.name} should have imports to inspect`);
    assert.deepEqual(findBoundaryViolations(imports, {
      sourceRoot: boundary.name,
      forbiddenRoots: boundary.forbiddenRoots,
    }), []);
  });
}

test("boundary matcher detects every prohibited direction", () => {
  const imports = [
    { sourceFile: "kernel/mutate.mjs", targetFile: "application/operations/index.mjs" },
    { sourceFile: "kernel/graph.mjs", targetFile: "plugins/query.mjs" },
    { sourceFile: "kernel/transaction.mjs", targetFile: "cli/actor.mjs" },
    { sourceFile: "providers/task/create.mjs", targetFile: "cli/actor.mjs" },
    { sourceFile: "providers/task/create.mjs", targetFile: "plugins/policy.mjs" },
    { sourceFile: "providers/task/create.mjs", targetFile: "storage/state.mjs" },
    { sourceFile: "execution/contract.mjs", targetFile: "cli/actor.mjs" },
    { sourceFile: "execution/contract.mjs", targetFile: "plugins/policy.mjs" },
    { sourceFile: "execution/contract.mjs", targetFile: "storage/state.mjs" },
    { sourceFile: "read-model/index.mjs", targetFile: "cli/actor.mjs" },
    { sourceFile: "read-model/index.mjs", targetFile: "plugins/query.mjs" },
    { sourceFile: "read-model/index.mjs", targetFile: "storage/state.mjs" },
  ];

  for (const boundary of BOUNDARIES) {
    const violations = findBoundaryViolations(imports, {
      sourceRoot: boundary.name,
      forbiddenRoots: boundary.forbiddenRoots,
    });
    assert.equal(violations.length, 3, `${boundary.name} should detect all of its forbidden roots`);
  }
});

test("HTTP modules do not import storage", async () => {
  const imports = await collectRelativeImports("src/server/http");
  assert.ok(imports.length > 0, "HTTP modules should have imports to inspect");
  assert.deepEqual(findBoundaryViolations(imports, {
    sourceRoot: "server/http",
    forbiddenRoots: ["storage"],
  }), []);
});

test("HTTP transfers delegate through kernel transfer ports", async () => {
  const imports = await collectRelativeImports("src/server/http");
  const transferImports = imports.filter(({ sourceFile }) => sourceFile === "server/http/transfers.mjs");
  assert.ok(transferImports.some(({ targetFile }) => targetFile === "kernel/transfer.mjs"));
  const source = await readFile("src/server/http/transfers.mjs", "utf8");
  assert.match(source, /captureTransferSource\(/);
  assert.match(source, /installTransferDestination\(/);
});

test("HTTP facade remains the only HTTP module allowed to read storage", async () => {
  const source = await readFile("src/server/http.mjs", "utf8");
  assert.match(source, /from "\.\.\/storage\/state\.mjs"/);
});

test("HTTP extracted modules do not open projects", async () => {
  for (const file of [
    "src/server/http/codec.mjs",
    "src/server/http/operations.mjs",
    "src/server/http/reads.mjs",
    "src/server/http/transfers.mjs",
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\b(?:openProject|provisionProject|withAuthorizedProject)\b/, file);
    assert.doesNotMatch(source, /from ["'][^"']*catalog\//, file);
  }
});

test("HTTP protocol version is defined once in the public facade", async () => {
  const files = [
    "src/server/http.mjs",
    "src/server/http/codec.mjs",
    "src/server/http/operations.mjs",
    "src/server/http/reads.mjs",
    "src/server/http/transfers.mjs",
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const definitions = sources.flatMap((source, index) =>
    [...source.matchAll(/\b(?:const|let|var)\s+PROTOCOL_VERSION\s*=/g)].map(() => files[index]));

  assert.deepEqual(definitions, ["src/server/http.mjs"]);
  assert.match(sources[0], /createHttpCodec\(\{ protocolVersion: PROTOCOL_VERSION \}\)/);
});

test("scanner recognizes canonical inward dependencies", async () => {
  const applicationImports = await collectRelativeImports("src/application/operations");
  const providerImports = await collectRelativeImports("src/providers/task");
  const kernelImports = await collectRelativeImports("src/kernel");

  assert.ok(applicationImports.some(({ targetFile }) => targetFile.startsWith("providers/")));
  assert.ok(providerImports.some(({ targetFile }) => targetFile.startsWith("kernel/")));
  assert.ok(kernelImports.some(({ targetFile }) => targetFile.startsWith("storage/")));
});

test("scanner ignores comments and strings while inspecting dynamic imports", () => {
  const source = `
    // import { fake } from "../plugins/policy.mjs";
    const text = "export { fake } from '../storage/state.mjs'";
    const dynamic = import("../cli/actor.mjs");
    import { real } from "../providers/task/index.mjs";
    export { real } from "../kernel/graph.mjs";
  `;

  assert.deepEqual(relativeImportSpecifiers(source), [
    "../cli/actor.mjs",
    "../providers/task/index.mjs",
    "../kernel/graph.mjs",
  ]);
});
