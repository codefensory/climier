import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { UI_DIR } from "../src/cli/commands/ui.mjs";

test("ui command resolves the root ui subproject", () => {
  assert.equal(UI_DIR, path.resolve("ui"));
});
