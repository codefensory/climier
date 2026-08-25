// The refresh/read-only status is global UI state. Keep its single visible
// presentation in the floating chip so page headers do not repeat it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const UI_SRC = path.resolve("ui/src");
const VIEW_FILES = fs
  .readdirSync(path.join(UI_SRC, "views"))
  .filter((file) => file.endsWith(".jsx"));

function read(relative) {
  return fs.readFileSync(path.join(UI_SRC, relative), "utf8");
}

test("LiveStatus is rendered only by the floating shell indicator", () => {
  for (const file of VIEW_FILES) {
    const source = read(path.join("views", file));
    assert.doesNotMatch(source, /\bLiveStatus\b/, `${file} must not render a duplicate live status`);
  }

  const app = read("App.jsx");
  assert.doesNotMatch(app, /Read-only projection/, "the sidebar must not repeat the floating status");
  assert.equal((app.match(/<LiveStatus\b/g) || []).length, 1, "App must render one LiveStatus instance");
  const floatingStart = app.indexOf("fixed bottom-3 right-4");
  assert.notEqual(floatingStart, -1, "the live status must remain in the floating chip");
  assert.ok(
    app.indexOf("<LiveStatus", floatingStart) !== -1,
    "the floating chip must contain LiveStatus",
  );
});
