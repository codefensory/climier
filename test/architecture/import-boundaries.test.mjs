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

test("application does not import plugins", async () => {
  const imports = await collectRelativeImports("src/application");
  assert.ok(imports.length > 0, "application should have imports to inspect");
  assert.deepEqual(findBoundaryViolations(imports, {
    sourceRoot: "application",
    forbiddenRoots: ["plugins"],
  }), []);
});

test("boundary matcher detects every prohibited direction", () => {
  const imports = [
    { sourceFile: "kernel/mutate.ts", targetFile: "application/operations/index.ts" },
    { sourceFile: "kernel/graph.ts", targetFile: "plugins/query.ts" },
    { sourceFile: "kernel/transaction.ts", targetFile: "cli/actor.ts" },
    { sourceFile: "providers/task/create.ts", targetFile: "cli/actor.ts" },
    { sourceFile: "providers/task/create.ts", targetFile: "plugins/policy.ts" },
    { sourceFile: "providers/task/create.ts", targetFile: "storage/state.ts" },
    { sourceFile: "execution/contract.mjs", targetFile: "cli/actor.ts" },
    { sourceFile: "execution/contract.mjs", targetFile: "plugins/policy.ts" },
    { sourceFile: "execution/contract.mjs", targetFile: "storage/state.ts" },
    { sourceFile: "read-model/index.ts", targetFile: "cli/actor.ts" },
    { sourceFile: "read-model/index.ts", targetFile: "plugins/query.ts" },
    { sourceFile: "read-model/index.ts", targetFile: "storage/state.ts" },
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
  const transferImports = imports.filter(({ sourceFile }) => sourceFile === "server/http/transfers.ts");
  assert.ok(transferImports.some(({ targetFile }) => targetFile === "kernel/transfer.ts"));
  const source = await readFile("src/server/http/transfers.ts", "utf8");
  assert.match(source, /captureTransferSource\(/);
  assert.match(source, /installTransferDestination\(/);
});

test("HTTP facade remains the only HTTP module allowed to read storage", async () => {
  const source = await readFile("src/server/http.ts", "utf8");
  assert.match(source, /from "\.\.\/storage\/state\.ts"/);
});

test("HTTP extracted modules do not open projects", async () => {
  for (const file of [
    "src/server/http/codec.ts",
    "src/server/http/operations.ts",
    "src/server/http/reads.ts",
    "src/server/http/transfers.ts",
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\b(?:openProject|provisionProject|withAuthorizedProject)\b/, file);
    assert.doesNotMatch(source, /from ["'][^"']*catalog\//, file);
  }
});

test("HTTP protocol version is defined once in the public facade", async () => {
  const files = [
    "src/server/http.ts",
    "src/server/http/codec.ts",
    "src/server/http/operations.ts",
    "src/server/http/reads.ts",
    "src/server/http/transfers.ts",
  ];
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const definitions = [];
  for (const [index, source] of sources.entries()) {
    const definitionCount = [...source.matchAll(/\b(?:const|let|var)\s+PROTOCOL_VERSION\s*=/g)].length;
    definitions.push(...Array(definitionCount).fill(files[index]));
  }

  assert.deepEqual(definitions, ["src/server/http.ts"]);
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
    // import { fake } from "../plugins/policy.ts";
    const text = "export { fake } from '../storage/state.ts'";
    const dynamic = import("../cli/actor.ts");
    import { real } from "../providers/task/index.ts";
    export { real } from "../kernel/graph.ts";
  `;

  assert.deepEqual(relativeImportSpecifiers(source), [
    "../cli/actor.ts",
    "../providers/task/index.ts",
    "../kernel/graph.ts",
  ]);
});
