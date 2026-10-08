import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUiUrls, encodeInitiativeFilter } from "../src/read-model/urls.ts";
import { buildUiUrls as reExportedBuildUiUrls } from "../src/read-model/index.ts";

type UrlContract = {
  routes: Record<string, string>;
  linked_routes: Record<string, string>;
  detail: {
    task: string;
    gate: string;
    knowledge_param: string;
    gate_param: string;
  };
  filter_wire: Record<string, {
    c: Array<{ f: string; o: string; v: string[] }>;
    g: unknown[];
  }>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "ui/src/modules/app-shell/data/ui-url-contract.json"), "utf8"),
) as UrlContract;

test("buildUiUrls projects the fixture's linked route catalog", () => {
  const urls = buildUiUrls({ origin: "https://climier.example.test", projectId: "project-1" });

  assert.deepEqual(urls.map(({ kind }) => kind), Object.keys(contract.linked_routes));
  assert.deepEqual(
    urls.map(({ url }) => url),
    Object.values(contract.linked_routes).map((route) => `https://climier.example.test/#${route}?project=project-1`),
  );
  assert.equal(reExportedBuildUiUrls, buildUiUrls);
});

test("buildUiUrls adds initiative and node deep links to the base catalog", () => {
  const initiativeUrls = buildUiUrls({
    origin: "https://climier.example.test",
    projectId: "project-1",
    initiative: "auth-migration",
  });
  assert.equal(initiativeUrls.length, Object.keys(contract.linked_routes).length + 1);
  assert.equal(initiativeUrls.at(-1)?.kind, "tasks");
  assert.match(initiativeUrls.at(-1)?.url ?? "", /filter=%7B%22c%22/);

  const taskUrls = buildUiUrls({
    origin: "https://climier.example.test",
    projectId: "project-1",
    node: { id: "T-1", kind: "resolvable", subkind: "task" },
  });
  assert.equal(
    taskUrls.at(-1)?.url,
    `https://climier.example.test/#${contract.detail.task.replace(":id", "T-1")}?project=project-1`,
  );

  const gateUrls = buildUiUrls({
    origin: "https://climier.example.test",
    projectId: "project-1",
    node: { id: "G-1", kind: "resolvable", subkind: "gate" },
  });
  assert.equal(
    gateUrls.at(-1)?.url,
    `https://climier.example.test/#${contract.detail.gate.replace(":id", "G-1")}?project=project-1`,
  );

  const knowledgeUrls = buildUiUrls({
    origin: "https://climier.example.test",
    projectId: "project-1",
    node: { id: "K-1", kind: "knowledge" },
  });
  assert.equal(
    knowledgeUrls.at(-1)?.url,
    `https://climier.example.test/#${contract.linked_routes.knowledges}?project=project-1&${contract.detail.knowledge_param}=K-1`,
  );
  assert.equal(knowledgeUrls.at(-1)?.label, "knowledge K-1 (selection in the knowledges list)");
});

test("the initiative filter encoder matches both fixture wire cases", () => {
  for (const [fixtureName, wire] of Object.entries(contract.filter_wire)) {
    const initiative = wire.c[0]?.v[0];
    assert.equal(typeof initiative, "string", `${fixtureName} has an initiative value`);
    assert.equal(encodeInitiativeFilter(initiative as string), JSON.stringify(wire), fixtureName);
  }
});

test("the projection keeps URL parameter order and encoding deterministic", () => {
  const url = buildUiUrls({
    origin: "https://climier.example.test",
    projectId: "project with spaces",
    initiative: "diseño UI/UX",
  }).at(-1)?.url;

  assert.equal(
    url,
    "https://climier.example.test/#/tasks?project=project+with+spaces&filter=%7B%22c%22%3A%5B%7B%22f%22%3A%22initiative%22%2C%22o%22%3A%22is%22%2C%22v%22%3A%5B%22dise%C3%B1o+UI%2FUX%22%5D%7D%5D%2C%22g%22%3A%5B%5D%7D",
  );
});
