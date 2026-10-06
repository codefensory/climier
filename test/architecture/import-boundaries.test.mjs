import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  collectRelativeImports,
  findBoundaryViolations,
  relativeImportSpecifiers,
} from "./import-graph.mjs";

// This is the ratchet for the measured graph. Exceptions name edges that are
// currently real but remain outside the normative dependency direction.
const BOUNDARIES = [
  { name: "contracts", directory: "src/contracts", allowedRoots: [] },
  { name: "storage", directory: "src/storage", allowedRoots: ["contracts"] },
  { name: "kernel", directory: "src/kernel", allowedRoots: ["contracts", "storage"] },
  { name: "providers", directory: "src/providers", allowedRoots: ["contracts", "kernel"] },
  { name: "read-model", directory: "src/read-model", allowedRoots: ["kernel", "providers"] },
  { name: "application", directory: "src/application", allowedRoots: ["contracts", "kernel", "providers", "storage"] },
  {
    name: "plugins",
    directory: "src/plugins",
    allowedRoots: ["application", "contracts", "kernel", "providers", "read-model", "storage"],
    exceptions: [
      { edge: "plugins -> kernel", reason: "existing plugin host dependency" },
      { edge: "plugins -> providers", reason: "existing plugin host dependency" },
      { edge: "plugins -> read-model", reason: "existing plugin host dependency" },
    ],
  },
  {
    name: "server",
    directory: "src/server",
    allowedRoots: ["application", "kernel", "read-model", "storage"],
    exceptions: [
      { edge: "server -> kernel", reason: "existing remote runtime dependency" },
      { edge: "server -> read-model", reason: "existing remote runtime dependency" },
    ],
  },
  {
    name: "cli",
    directory: "src/cli",
    allowedRoots: ["application", "contracts", "kernel", "plugins", "providers", "read-model", "server", "storage"],
  },
  {
    name: "bin",
    directory: "bin",
    allowedRoots: ["cli", "server"],
    collectOptions: { sourceRootDirectory: ".", targetRootDirectory: "src" },
  },
];

const BOUNDARY_ROOTS = BOUNDARIES.map(({ name }) => name);

function forbiddenRootsFor(boundary) {
  return BOUNDARY_ROOTS.filter((root) => root !== boundary.name && !boundary.allowedRoots.includes(root));
}

function boundaryRoot(targetFile) {
  return BOUNDARY_ROOTS.find((root) => (
    targetFile === root || targetFile.startsWith(`${root}${path.sep}`)
  ));
}

function actualBoundaryRoots(imports, boundary) {
  return imports
    .map(({ targetFile }) => boundaryRoot(targetFile))
    .filter((root) => root !== undefined && root !== boundary.name)
    .filter((root, index, roots) => roots.indexOf(root) === index)
    .toSorted();
}

for (const boundary of BOUNDARIES) {
  test(`${boundary.name} matches the declared architectural graph`, async () => {
    const imports = await collectRelativeImports(boundary.directory, boundary.collectOptions);
    assert.ok(imports.length > 0, `${boundary.name} should have imports to inspect`);
    assert.deepEqual(actualBoundaryRoots(imports, boundary), boundary.allowedRoots.toSorted());
    assert.deepEqual(findBoundaryViolations(imports, {
      sourceRoot: boundary.name,
      forbiddenRoots: forbiddenRootsFor(boundary),
    }), []);

    const undeclaredRoots = imports.filter(({ targetFile }) => (
      targetFile.includes(path.sep) && boundaryRoot(targetFile) === undefined
    ));
    assert.deepEqual(undeclaredRoots, [], `${boundary.name} imports an undeclared root`);
  });
}

test("the table names all five measured normative deviations", () => {
  assert.deepEqual(
    BOUNDARIES.flatMap(({ exceptions = [] }) => exceptions.map(({ edge }) => edge)),
    [
      "plugins -> kernel",
      "plugins -> providers",
      "plugins -> read-model",
      "server -> kernel",
      "server -> read-model",
    ],
  );
});

test("providers -> kernel is an explicitly allowed edge", async () => {
  const boundary = BOUNDARIES.find(({ name }) => name === "providers");
  const imports = await collectRelativeImports(boundary.directory);
  assert.ok(boundary.allowedRoots.includes("kernel"));
  assert.deepEqual(findBoundaryViolations(imports, {
    sourceRoot: boundary.name,
    forbiddenRoots: forbiddenRootsFor(boundary),
  }), []);
  assert.ok(actualBoundaryRoots(imports, boundary).includes("kernel"));
});

test("boundary matcher detects every prohibited direction from the table", () => {
  for (const boundary of BOUNDARIES) {
    const forbiddenRoots = forbiddenRootsFor(boundary);
    const imports = forbiddenRoots.map((root) => ({
      sourceFile: `${boundary.name}/fixture.ts`,
      targetFile: `${root}/fixture.ts`,
    }));
    const violations = findBoundaryViolations(imports, {
      sourceRoot: boundary.name,
      forbiddenRoots,
    });
    assert.equal(violations.length, forbiddenRoots.length, `${boundary.name} should detect every forbidden root`);
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
