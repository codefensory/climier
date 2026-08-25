// Contract tests for the drawer motion language. The animation is CSS-driven,
// but the view wiring is part of the interaction contract: detail and mobile
// navigation drawers need directional entry plus a real exit state.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const UI_SRC = path.resolve("ui", "src");
const CSS_FILE = path.join(UI_SRC, "index.css");
const APP_FILE = path.join(UI_SRC, "App.jsx");
const DETAIL_FILE = path.join(UI_SRC, "views", "NodeDetail.jsx");

const css = fs.readFileSync(CSS_FILE, "utf8");
const app = fs.readFileSync(APP_FILE, "utf8");
const detail = fs.readFileSync(DETAIL_FILE, "utf8");

test("drawer motion has directional entry/exit keyframes and reduced-motion coverage", () => {
  assert.match(css, /@keyframes\s+ui-drawer-detail-in/);
  assert.match(css, /@keyframes\s+ui-drawer-detail-out/);
  assert.match(css, /@keyframes\s+ui-drawer-nav-in/);
  assert.match(css, /@keyframes\s+ui-drawer-nav-out/);
  assert.match(css, /@keyframes\s+ui-drawer-scrim-in/);
  assert.match(css, /@keyframes\s+ui-drawer-scrim-out/);
  assert.match(css, /prefers-reduced-motion/);
});

test("detail and mobile navigation drawers expose the motion state", () => {
  assert.match(detail, /ui-drawer-detail/);
  assert.match(detail, /ui-drawer-detail--closing/);
  assert.match(detail, /ui-drawer-detail-out/);
  assert.match(detail, /open\(\)\s*\|\|\s*closing\(\)/);

  assert.match(app, /ui-drawer-nav/);
  assert.match(app, /ui-drawer-nav--closing/);
  assert.match(app, /ui-drawer-nav-out/);
  assert.match(app, /props\.open\(\)\s*\|\|\s*present\(\)/);
});
