import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  collectRelativeImports,
  findBoundaryViolations,
  relativeImportSpecifiers,
} from "./import-graph.ts";

// This is the ratchet for the measured graph. `documentedEdges` names the
// adapter edges the ADRs approve explicitly: each one is also an allowed root,
// listed here so the norm stays visible instead of hiding inside an allowlist.
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
    documentedEdges: [
      { edge: "plugins -> kernel", source: "ADR-013 §5: the plugin host may consume the kernel" },
      { edge: "plugins -> providers", source: "ADR-013 §5: the plugin host may consume providers" },
      { edge: "plugins -> read-model", source: "ADR-013 §5 and §9: plugin queries consume read-model" },
    ],
  },
  {
    name: "server",
    directory: "src/server",
    allowedRoots: ["application", "kernel", "read-model", "storage", "upgrade"],
    documentedEdges: [
      { edge: "server -> kernel", source: "ADR-032: transfers dispatch through kernel/transfer port" },
      { edge: "server -> read-model", source: "ADR-032: the narrow boundary test does not restrict read-model" },
      { edge: "server -> upgrade", source: "ADR-068: systemd reuses distribution classification" },
    ],
  },
  {
    name: "cli",
    directory: "src/cli",
    allowedRoots: ["application", "contracts", "kernel", "plugins", "providers", "read-model", "server", "storage", "upgrade"],
  },
  { name: "upgrade", directory: "src/upgrade", allowedRoots: ["contracts"] },
  {
    name: "bin",
    directory: "bin",
    allowedRoots: ["cli"],
    collectOptions: { sourceRootDirectory: ".", targetRootDirectory: "src" },
  },
];

const BOUNDARY_ROOTS = BOUNDARIES.map(({ name }) => name);

function forbiddenRootsFor(boundary) {
  return BOUNDARY_ROOTS.filter((root) => root !== boundary.name && !boundary.allowedRoots.includes(root));
}

function isUndeclaredRoot({ targetFile }) {
  return targetFile.includes(path.sep)
    && boundaryRoot(targetFile) === undefined
    && targetFile !== "../package.json";
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

    const undeclaredRoots = imports.filter(isUndeclaredRoot);
    assert.deepEqual(undeclaredRoots, [], `${boundary.name} imports an undeclared root`);
  });
}

test("the table declares the adapter edges approved by ADR-013, ADR-032, and ADR-068", () => {
  assert.deepEqual(
    BOUNDARIES.flatMap(({ documentedEdges = [] }) => documentedEdges.map(({ edge }) => edge)),
    [
      "plugins -> kernel",
      "plugins -> providers",
      "plugins -> read-model",
      "server -> kernel",
      "server -> read-model",
      "server -> upgrade",
    ],
  );
  // A documented edge is normative, not a tolerated exception: it must also be an
  // allowed root, so it can never silently drift out of the declared graph again.
  for (const boundary of BOUNDARIES) {
    for (const { edge, source } of boundary.documentedEdges ?? []) {
      const target = edge.split(" -> ")[1];
      assert.ok(boundary.allowedRoots.includes(target), `${edge} must be an allowed root`);
      assert.match(source, /ADR-\d{3}/, `${edge} must cite its normative source`);
    }
  }
});

test("providers -> kernel is an explicitly allowed edge", async () => {
  const boundary = BOUNDARIES.find(({ name }) => name === "providers");
  assert.ok(boundary);
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
  const definitions: string[] = [];
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
