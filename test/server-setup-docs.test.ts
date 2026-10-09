import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const remoteServerDoc = new URL("../docs/remote-server.md", import.meta.url);
const readme = new URL("../README.md", import.meta.url);

test("remote server docs describe the generated setup path", async () => {
  const [doc, readmeText] = await Promise.all([
    fs.readFile(remoteServerDoc, "utf8"),
    fs.readFile(readme, "utf8"),
  ]);

  assert.match(doc, /climier server init/u);
  assert.match(doc, /climier server doctor/u);
  assert.match(doc, /climier server run \/srv\/climier\/server\.json/u);
  assert.doesNotMatch(doc, /\bclimier-server(?:\.ts)?\s/u);
  assert.match(doc, /--unit none/u);
  assert.match(doc, /--allow-missing-paths/u);
  assert.match(doc, /--rotate-password/u);
  assert.match(doc, /--print-secret/u);
  assert.match(doc, /adopted verbatim/u);
  assert.match(doc, /plain re-run never rotates/u);
  assert.match(doc, /\{"ok":true,"host":"<host>","port":<port>\}/u);
  assert.match(doc, /ProtectHome=true/u);
  assert.match(doc, /drift.*unit|unit.*drift/isu);
  assert.doesNotMatch(doc, /deploy-server(?:\.sh|\.env)/u);
  assert.match(readmeText, /climier server init/u);
  assert.match(readmeText, /climier server doctor/u);
  assert.match(readmeText, /--rotate-password/u);
  assert.match(readmeText, /ProtectHome=true/u);
  assert.doesNotMatch(readmeText, /deploy-server|launchd/u);
});
