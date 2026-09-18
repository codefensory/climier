#!/usr/bin/env node
/**
 * verify-docs-site.mjs — end-to-end verification for the web/ docs site.
 *
 * Dependency-free ESM. Pipeline (each step prints one status line):
 *   1. regenerate content:        node web/scripts/gen-content.mjs
 *   2. load + validate manifest:  web/content-manifest.mjs (or --manifest <file>;
 *                                 every page's repo-relative source path must exist)
 *   3. bun install in web/        only when web/node_modules is missing
 *   4. build:                     bun run build (in web/)
 *   5. serve on a scratch port:   bun run preview -- --port <port> --host
 *                                 (default 4401, DOCS_VERIFY_PORT overrides;
 *                                 +1/+2 tried as fallbacks when busy); readiness
 *                                 = index URL returns 200 within 60s
 *   6. every manifest slug        GET http://127.0.0.1:<port><slug> must return
 *                                 200 with a non-empty <h1>; manifest count >= 1
 *   7. unknown route              /definitely-not-a-page must return 404
 *
 * Exits 0 only when every step passes. The preview process this script spawned
 * is tracked by pid and killed as a process group in a finally block, so no
 * orphaned server survives a failure path. Servers this script did not start —
 * in particular anything already listening on port 4400 — are never touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const webDir = path.join(repoRoot, "web");

const TOTAL_STEPS = 7;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;

class Failure extends Error {}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function ok(n, message) {
  console.log(`ok   ${n}/${TOTAL_STEPS} ${message}`);
}

function fail(n, message) {
  throw new Failure(`${n}/${TOTAL_STEPS} ${message}`);
}

/** Prints a captured subprocess buffer tail so failures stay diagnosable. */
function tail(text, lines = 40) {
  const arr = String(text).split("\n").filter((line) => line.trim() !== "");
  if (arr.length === 0) return "";
  return `--- output (last ${Math.min(lines, arr.length)} lines) ---\n${arr
    .slice(-lines)
    .join("\n")}`;
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { manifestFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") {
      const value = argv[++i];
      if (!value) throw new Error("--manifest requires a file argument");
      opts.manifestFile = path.resolve(value);
    } else if (arg.startsWith("--manifest=")) {
      const value = arg.slice("--manifest=".length);
      if (!value) throw new Error("--manifest requires a file argument");
      opts.manifestFile = path.resolve(value);
    } else {
      throw new Error(`unknown argument: ${arg} (usage: verify-docs-site.mjs [--manifest <file>])`);
    }
  }
  return opts;
}

// ------------------------------------------------------------------- ports

function scratchPorts() {
  const raw = process.env.DOCS_VERIFY_PORT;
  let preferred = 4401;
  if (raw !== undefined && raw !== "") {
    preferred = Number.parseInt(raw, 10);
    if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
      throw new Error(
        `DOCS_VERIFY_PORT must be an integer in [1, 65535], got ${JSON.stringify(raw)}`,
      );
    }
  }
  // Preferred port first, then two fallbacks in case a sibling process holds it.
  return [preferred, preferred + 1, preferred + 2].filter((p) => p <= 65535);
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------- manifest

async function loadPages(manifestFile) {
  if (manifestFile) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch (cause) {
      throw new Error(`cannot read manifest ${manifestFile}: ${cause.message}`);
    }
    const pages = raw?.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error(`manifest ${manifestFile} must have a non-empty "pages" array`);
    }
    return { pages, source: manifestFile };
  }
  const mod = await import(pathToFileURL(path.join(webDir, "content-manifest.mjs")).href);
  const pages = mod.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("web/content-manifest.mjs exposed no pages");
  }
  return { pages, source: "web/content-manifest.mjs" };
}

/** Every page needs a slash-prefixed slug and a source path that exists in the repo. */
function validatePages(pages) {
  const problems = [];
  for (const page of pages) {
    const label = page?.title ? `"${page.title}"` : JSON.stringify(page?.slug ?? page);
    if (typeof page?.slug !== "string" || !page.slug.startsWith("/")) {
      problems.push(`${label}: bad slug ${JSON.stringify(page?.slug)}`);
      continue;
    }
    if (
      typeof page?.path !== "string" ||
      page.path === "" ||
      !existsSync(path.join(repoRoot, page.path))
    ) {
      problems.push(
        `${label} (slug ${page.slug}): source path ${JSON.stringify(page?.path)} does not exist in the repo`,
      );
    }
  }
  return problems;
}

// -------------------------------------------------------------- subprocess

function runStep(command, args, cwd, timeoutMs) {
  const res = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    reason: res.error?.message ?? null,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

// The preview runs in its own process group (detached), so killing -pid tears
// down bun + vite + anything they spawned — and only that group.
let previewPid = 0;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

async function stopPreview() {
  if (!previewPid) return;
  const pid = previewPid;
  previewPid = 0;
  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0); // group still alive?
    } catch {
      return; // gone
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  killGroup(pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
}

process.on("exit", () => {
  if (previewPid) killGroup(previewPid, "SIGKILL");
});
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    if (previewPid) killGroup(previewPid, "SIGKILL");
    process.exit(1);
  });
}

function startPreview(port) {
  const child = spawn(
    "bun",
    ["run", "preview", "--", "--port", String(port), "--host"],
    {
      cwd: webDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

async function waitReady(port, child, timeoutMs) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "never probed";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`preview exited early (code ${child.exitCode ?? child.signalCode})`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return;
      lastError = `GET ${url} -> ${res.status}`;
      // Drain so the socket is reusable for the next poll.
      await res.arrayBuffer().catch(() => {});
    } catch (cause) {
      lastError = cause?.message ?? String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`not ready within ${timeoutMs / 1000}s (last probe: ${lastError})`);
}

// ------------------------------------------------------------------ probes

function extractH1(html) {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!match) return "";
  return match[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function probeSlug(port, slug) {
  const url = `http://127.0.0.1:${port}${slug}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const body = await res.text();
  return { url, status: res.status, h1: extractH1(body) };
}

// -------------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const t0 = Date.now();

try {
  // 1. regenerate content from the read-only markdown sources
  const tGen = Date.now();
  const gen = runStep("node", ["web/scripts/gen-content.mjs"], repoRoot, 120_000);
  if (!gen.ok) {
    console.error(tail(gen.output));
    fail(1, `gen-content failed (exit ${gen.status ?? gen.reason})`);
  }
  ok(1, `gen-content: node web/scripts/gen-content.mjs (${secs(Date.now() - tGen)})`);

  // 2. load the manifest and validate it (fast-fail point for --manifest tamper runs)
  const { pages, source } = await loadPages(opts.manifestFile);
  const problems = validatePages(pages);
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 10)) console.error(`  - ${problem}`);
    fail(2, `manifest ${source}: ${problems.length} invalid page(s); first: ${problems[0]}`);
  }
  const slugs = pages.map((page) => page.slug);
  ok(2, `manifest ${source}: ${slugs.length} page(s), all source paths exist`);

  // 3. install web/ dependencies only when missing
  if (existsSync(path.join(webDir, "node_modules"))) {
    ok(3, "bun install: skipped (web/node_modules present)");
  } else {
    const tInstall = Date.now();
    const install = runStep("bun", ["install"], webDir, 600_000);
    if (!install.ok) {
      console.error(tail(install.output));
      fail(3, `bun install failed (exit ${install.status ?? install.reason})`);
    }
    ok(3, `bun install: completed (${secs(Date.now() - tInstall)})`);
  }

  // 4. build the site
  const tBuild = Date.now();
  const build = runStep("bun", ["run", "build"], webDir, 600_000);
  if (!build.ok) {
    console.error(tail(build.output));
    fail(4, `bun run build failed (exit ${build.status ?? build.reason})`);
  }
  ok(4, `build: bun run build (${secs(Date.now() - tBuild)})`);

  // 5. serve the build on a scratch port and wait for readiness
  const ports = scratchPorts();
  let port = null;
  for (const candidate of ports) {
    if (await canBind(candidate)) {
      port = candidate;
      break;
    }
  }
  if (port === null) fail(5, `no free port among ${ports.join(", ")}`);
  const { child, output } = startPreview(port);
  previewPid = child.pid;
  const tReady = Date.now();
  try {
    await waitReady(port, child, READY_TIMEOUT_MS);
  } catch (cause) {
    console.error(tail(output()));
    fail(5, `preview on port ${port}: ${cause.message}`);
  }
  ok(5, `preview: http://127.0.0.1:${port} ready (${secs(Date.now() - tReady)})`);

  try {
    // 6. every manifest slug must serve 200 with a non-empty <h1>
    const bad = [];
    for (const slug of slugs) {
      let probe;
      try {
        probe = await probeSlug(port, slug);
      } catch (cause) {
        bad.push(`slug ${slug}: request failed (${cause?.message ?? cause})`);
        continue;
      }
      if (probe.status !== 200) {
        bad.push(`slug ${slug}: expected 200 with non-empty <h1>, got ${probe.status}`);
        continue;
      }
      if (!probe.h1) bad.push(`slug ${slug}: 200 but <h1> missing or empty`);
    }
    if (bad.length > 0) {
      for (const line of bad.slice(0, 10)) console.error(`  - ${line}`);
      fail(6, `routes: ${bad.length} failing probe(s) out of ${slugs.length}; first: ${bad[0]}`);
    }
    ok(6, `routes: ${slugs.length}/${slugs.length} slug(s) -> 200 with non-empty <h1>`);

    // 7. unknown routes must 404
    const missing = await fetch(`http://127.0.0.1:${port}/definitely-not-a-page`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (missing.status !== 404) {
      fail(7, `unknown route /definitely-not-a-page: expected 404, got ${missing.status}`);
    }
    ok(7, "unknown route /definitely-not-a-page -> 404");
  } finally {
    await stopPreview();
  }

  console.log(`PASS docs-site verification in ${secs(Date.now() - t0)}`);
} catch (error) {
  if (error instanceof Failure) {
    console.error(`FAIL ${error.message}`);
  } else {
    console.error(`error: ${error?.stack ?? error}`);
  }
  console.log(`FAIL docs-site verification in ${secs(Date.now() - t0)}`);
  process.exitCode = 1;
} finally {
  await stopPreview();
}
