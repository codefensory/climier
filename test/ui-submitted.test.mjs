import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tasksByStatus } from "../ui/src/store/selectors.js";

const root = path.resolve("ui/src");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("tasksByStatus exposes submitted as an independent task pool", () => {
  const entities = {
    nodes: {
      ready: { id: "ready", subkind: "task", status: "open" },
      submitted: { id: "submitted", subkind: "task", status: "submitted" },
      blocked: { id: "blocked", subkind: "task", status: "open" },
      progress: { id: "progress", subkind: "task", status: "in_progress" },
    },
  };
  const derived = {
    ready: ["ready"],
    submitted: ["submitted"],
    blocked: ["blocked"],
    backlog: [],
  };

  assert.deepEqual(tasksByStatus(entities, derived), {
    ready: ["ready"],
    in_progress: ["progress"],
    submitted: ["submitted"],
    blocked: ["blocked"],
    backlog: [],
  });
});

test("submitted is represented across the read-only UI surfaces", () => {
  assert.match(read("components.jsx"), /submitted:/);
  assert.match(read("views/Board.jsx"), /submitted/);
  assert.match(read("views/Nodes.jsx"), /submitted/);
  assert.match(read("views/Overview.jsx"), /submitted/);
  assert.match(read("views/NodeDetail.jsx"), /submitted/);
  assert.match(fs.readFileSync(path.resolve("ui/server/server.mjs"), "utf8"), /submitted/);
});
