import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const isBun = Boolean(process.versions.bun);
type TestRow = { path: string; name: string };
type PendingResult = { name: string; type?: "test" | "suite" };
type HierarchyItem = { indent: number; name: string };
type CollectOptions = { rootDir: string; testDir: string; timeoutMs?: number };

export function parseTapTestNames(tap: string, filePath: string): TestRow[] {
  const rows: TestRow[] = [];
  const hierarchy: HierarchyItem[] = [];
  let pendingResult: PendingResult | undefined;

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
      while (hierarchy.length && hierarchy[hierarchy.length - 1]!.indent >= indent) hierarchy.pop();
      pendingResult = {
        name: [...hierarchy.map((item) => item.name), result[2]].join(" > "),
      };
      continue;
    }

    const subtest = line.match(/^(\s*)# Subtest:\s*(.*)$/);
    if (subtest) {
      const indent = subtest[1].length;
      while (hierarchy.length && hierarchy[hierarchy.length - 1]!.indent >= indent) hierarchy.pop();
      hierarchy.push({ indent, name: subtest[2] });
      continue;
    }

    if (pendingResult) {
      const type = line.match(/^\s+type:\s*['"]?(test|suite)['"]?\s*$/);
      if (type && (type[1] === "test" || type[1] === "suite")) pendingResult.type = type[1];
    }
  }
  finishResult();
  return rows;
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseJunitTestNames(xml: string, filePath: string): TestRow[] {
  const rows: TestRow[] = [];
  for (const match of xml.matchAll(/<testcase\b(?:[^>\"]|\"[^\"]*\")*>/g)) {
    const name = match[0].match(/\bname=\"([^\"]*)\"/)?.[1];
    if (name) rows.push({ path: filePath, name: decodeXml(name) });
  }
  return rows;
}

export async function collectTestNames({ rootDir, testDir, timeoutMs = 180_000 }: CollectOptions): Promise<TestRow[]> {
  const files = await findTestFiles(testDir);
  const rowsByFile = new Map<string, TestRow[]>();
  let nextFile = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (nextFile < files.length) {
      const file = files[nextFile++];
      const relativePath = path.relative(rootDir, file).split(path.sep).join("/");
      const report = await runTap(file, timeoutMs);
      rowsByFile.set(relativePath, isBun
        ? parseJunitTestNames(report, relativePath)
        : parseTapTestNames(report, relativePath));
    }
  });
  await Promise.all(workers);
  return files.flatMap((file) => rowsByFile.get(path.relative(rootDir, file).split(path.sep).join("/")) ?? []);
}

async function findTestFiles(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTestFiles(entryPath));
    else if (entry.isFile()
      && (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.ts"))
      && !entry.name.startsWith("ui-")) files.push(entryPath);
  }
  return files.toSorted();
}

async function runTap(file: string, timeoutMs: number): Promise<string> {
  const reportDir = isBun ? await mkdtemp(path.join(os.tmpdir(), "climier-manifest-")) : null;
  const reportPath = reportDir ? path.join(reportDir, "report.xml") : null;
  const args = isBun
    ? ["test", "--reporter=junit", `--reporter-outfile=${reportPath}`, file]
    : ["--test", "--test-reporter=tap", file];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer;
    const cleanup = async () => {
      if (reportDir) await rm(reportDir, { recursive: true, force: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", async (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      await cleanup();
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) {
        await cleanup();
        return reject(new Error(`manifest collector timed out for ${file}`));
      }
      if (code !== 0) {
        await cleanup();
        return reject(new Error(`manifest collector failed for ${file} (${signal ?? code}): ${stderr || stdout}`));
      }
      try {
        const report = reportPath ? await readFile(reportPath, "utf8") : stdout;
        await cleanup();
        resolve(report);
      } catch (error) {
        await cleanup();
        reject(error);
      }
    });
  });
}
