import path from "node:path";
import { spawn } from "node:child_process";

export function parseTapTestNames(tap, filePath) {
  const rows = [];
  const hierarchy = [];
  let pendingResult;

  function finishResult() {
    if (pendingResult && pendingResult.type !== "suite") {
      rows.push({ path: filePath, name: pendingResult.name });
    }
    pendingResult = undefined;
  }

  for (const line of tap.split(/\r?\n/)) {
    const result = line.match(/^(\s*)(?:ok|not ok)\s+\d+\s+-\s+(.+?)\s*$/);
    if (result) {
      finishResult();
      const indent = result[1].length;
      while (hierarchy.length && hierarchy.at(-1).indent >= indent) hierarchy.pop();
      pendingResult = {
        name: [...hierarchy.map((item) => item.name), result[2]].join(" > "),
        type: undefined,
      };
      continue;
    }

    const subtest = line.match(/^(\s*)# Subtest:\s*(.*)$/);
    if (subtest) {
      const indent = subtest[1].length;
      while (hierarchy.length && hierarchy.at(-1).indent >= indent) hierarchy.pop();
      hierarchy.push({ indent, name: subtest[2] });
      continue;
    }

    if (pendingResult) {
      const type = line.match(/^\s+type:\s*['"]?(test|suite)['"]?\s*$/);
      if (type) pendingResult.type = type[1];
    }
  }
  finishResult();
  return rows;
}

export async function collectTestNames({ rootDir, testDir, timeoutMs = 180_000 } = {}) {
  const files = await findTestFiles(testDir);
  const rowsByFile = new Map();
  let nextFile = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (nextFile < files.length) {
      const file = files[nextFile++];
      const relativePath = path.relative(rootDir, file).split(path.sep).join("/");
      const tap = await runTap(file, timeoutMs);
      rowsByFile.set(relativePath, parseTapTestNames(tap, relativePath));
    }
  });
  await Promise.all(workers);
  return files.flatMap((file) => rowsByFile.get(path.relative(rootDir, file).split(path.sep).join("/")));
}

async function findTestFiles(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs") && !entry.name.startsWith("ui-")) files.push(entryPath);
  }
  return files.toSorted();
}

function runTap(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) return reject(new Error(`manifest collector timed out for ${file}`));
      if (code !== 0) return reject(new Error(`manifest collector failed for ${file} (${signal ?? code}): ${stderr || stdout}`));
      resolve(stdout);
    });
  });
}
