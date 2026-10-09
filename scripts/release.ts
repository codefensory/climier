#!/usr/bin/env bun
/* oxlint-disable complexity, max-statements, max-lines-per-function -- linear operator release sequence: explicit guard ordering matters more than statement count. */
// Operator-run release cut. Publishes to npm from an interactive 2FA session
// (CI tokens cannot: npm requires Bypass 2FA for tokens, and Trusted Publishing
// cannot create the first version). See .adrs/071-release-local-publish.md.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DistTag = "latest" | "next";
export type TagAction = "create" | "reuse" | "worktree";

export type ReleaseOptions = {
  dryRun: boolean;
  skipGate: boolean;
  help: boolean;
  distTag?: DistTag;
};

const VERIFY_ATTEMPTS = 60;
const VERIFY_DELAY_MS = 5_000;

const RELEASE_GATE: ReadonlyArray<readonly [string, string[]]> = Object.freeze([
  ["bun", ["install", "--frozen-lockfile"]],
  ["bun", ["run", "build:ui"]],
  ["bun", ["run", "typecheck"]],
  ["bun", ["run", "test"]],
  ["bun", ["run", "surface:check"]],
  ["bun", ["run", "lint:cut"]],
  ["bun", ["run", "pack:check"]],
  ["bun", ["run", "smoke:pack"]],
]);

const USAGE = `usage: bun run release [--dry-run] [--skip-gate] [--tag latest|next]

Cuts the release named by package.json:
  1. validates the checkout (clean, main, pushed, CHANGELOG section, npm session)
  2. runs the release gate (install, build:ui, typecheck, test, surface:check,
     lint:cut, pack:check, smoke:pack)
  3. publishes to npm with RELEASE_TAG set (prompts for the 2FA one-time code)
  4. creates and pushes the v<version> tag, then verifies the published version

When v<version> already exists at another commit (the v1.0.0 bootstrap) the gate
and publish run inside a worktree checked out at that tag, so the published
tarball matches the GitHub Release exactly.

--dry-run    run the gate and npm publish --dry-run; do not publish or push
--skip-gate  skip the release gate (still validates the preconditions)
--tag        override the npm dist-tag (default: latest, or next for prereleases)
`;

export function releaseTagFor(version: string): string {
  return `v${version}`;
}

export function distTagFor(version: string): DistTag {
  return version.includes("-") ? "next" : "latest";
}

export function decideTagAction({ existingCommit, headCommit }: { existingCommit?: string; headCommit: string }): TagAction {
  if (!existingCommit) { return "create"; }
  return existingCommit === headCommit ? "reuse" : "worktree";
}

// npm scans and indexes a new version before the registry exposes it, so the
// version can take minutes to appear after a successful publish. The publish
// success line is authoritative; the view is only a best-effort confirmation.
export function classifyPublishVerification(observed: string | undefined, version: string): "verified" | "pending" {
  return observed === version ? "verified" : "pending";
}

export function assertChangelogHasVersion(version: string, changelog: string): void {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`^##+ \\[${escaped}\\]`, "mu").test(changelog)) {
    throw new Error(`release: CHANGELOG.md has no '## [${version}]' section`);
  }
}

export function parseReleaseArgs(argv: string[]): ReleaseOptions {
  const options: ReleaseOptions = { dryRun: false, skipGate: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--skip-gate") { options.skipGate = true; continue; }
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    const inline = /^--tag=(.*)$/u.exec(arg);
    let value: string | undefined;
    if (inline) {
      value = inline[1];
    } else if (arg === "--tag") {
      value = argv[++index];
    }
    if (value !== undefined) {
      if (value !== "latest" && value !== "next") {
        throw new Error(`release: --tag must be latest or next, got '${value}'`);
      }
      options.distTag = value;
      continue;
    }
    throw new Error(`release: unknown argument '${arg}'`);
  }
  return options;
}

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean };

function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) { throw result.error; }
  if (result.status !== 0) {
    throw new Error(`release: '${command} ${args.join(" ")}' exited ${result.status ?? "unknown"}`);
  }
  return options.capture ? (result.stdout ?? "").trim() : "";
}

function tryRun(command: string, args: string[], options: RunOptions = {}): string | undefined {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) { return undefined; }
  return (result.stdout ?? "").trim() || undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readVersion(root: string): string {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("release: package.json has no version");
  }
  return parsed.version;
}

function requireNpmSession(): void {
  if (tryRun("npm", ["whoami"], { capture: true }) === undefined) {
    throw new Error("release: npm session missing; run 'npm login' first");
  }
}

function assertNotPublished(version: string): void {
  const published = tryRun("npm", ["view", `climier@${version}`, "version"], { capture: true });
  if (published === version) {
    throw new Error(`release: climier@${version} is already published`);
  }
}

function assertReleaseCheckout(root: string, headCommit: string): void {
  if (run("git", ["status", "--porcelain"], { cwd: root, capture: true }) !== "") {
    throw new Error("release: working tree is not clean; commit or stash first");
  }
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, capture: true });
  if (branch !== "main") {
    throw new Error(`release: releases are cut from main, current branch is '${branch}'`);
  }
  const upstream = tryRun("git", ["rev-parse", "--verify", "@{u}"], { cwd: root, capture: true });
  if (upstream !== undefined && upstream !== headCommit) {
    throw new Error("release: HEAD is not pushed to its upstream");
  }
}

function gate(root: string): void {
  for (const [command, args] of RELEASE_GATE) {
    process.stderr.write(`release: gate '${command} ${args.join(" ")}'\n`);
    run(command, args, { cwd: root });
  }
}

async function main(): Promise<void> {
  const options = parseReleaseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }

  const repoRoot = run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  const version = readVersion(repoRoot);
  const tag = releaseTagFor(version);
  const distTag = options.distTag ?? distTagFor(version);
  const headCommit = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot, capture: true });
  const existingCommit = tryRun("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], { cwd: repoRoot, capture: true });
  assertChangelogHasVersion(version, fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8"));
  const action = decideTagAction({ existingCommit, headCommit });

  if (action !== "worktree") {
    assertReleaseCheckout(repoRoot, headCommit);
  }
  requireNpmSession();
  assertNotPublished(version);

  const tagCommit = action === "worktree" ? (existingCommit as string) : headCommit;
  process.stderr.write(`release: climier@${version} from ${tagCommit.slice(0, 12)} (tag ${tag}, dist-tag ${distTag}${action === "worktree" ? ", worktree at tag" : ""})\n`);

  let releaseRoot = repoRoot;
  let worktree: string | undefined;
  if (action === "worktree") {
    worktree = path.join(os.tmpdir(), `climier-release-${version}-${process.pid}`);
    run("git", ["worktree", "add", "--detach", worktree, tag], { cwd: repoRoot });
    releaseRoot = worktree;
  } else if (action === "create") {
    run("git", ["tag", "-a", tag, "-m", tag], { cwd: repoRoot });
  }

  try {
    if (!options.skipGate) {
      gate(releaseRoot);
    } else {
      process.stderr.write("release: gate skipped (--skip-gate)\n");
    }

    const publishArgs = ["publish", "--access", "public", "--tag", distTag, "--ignore-scripts"];
    if (options.dryRun) { publishArgs.push("--dry-run"); }
    run("npm", publishArgs, { cwd: releaseRoot, env: { ...process.env, RELEASE_TAG: tag } });
    process.stderr.write(`release: published climier@${version} with dist-tag ${distTag}\n`);

    if (!options.dryRun) {
      const remoteTag = tryRun("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: repoRoot, capture: true });
      if (remoteTag === undefined) {
        run("git", ["push", "origin", `refs/tags/${tag}`], { cwd: repoRoot });
        process.stderr.write(`release: pushed ${tag}; CI will build binaries and create the GitHub Release\n`);
      }
      let observed = tryRun("npm", ["view", `climier@${version}`, "version"], { capture: true });
      let attempt = 0;
      while (classifyPublishVerification(observed, version) !== "verified" && attempt < VERIFY_ATTEMPTS) {
        attempt += 1;
        process.stderr.write(`release: waiting for npm to index climier@${version} (${attempt}/${VERIFY_ATTEMPTS}); npm scans a new version before it is public\n`);
        await sleep(VERIFY_DELAY_MS);
        observed = tryRun("npm", ["view", `climier@${version}`, "version"], { capture: true });
      }
      if (classifyPublishVerification(observed, version) === "verified") {
        process.stderr.write(`release: verified https://www.npmjs.com/package/climier/v/${version}\n`);
      } else {
        process.stderr.write(`release: climier@${version} was published but npm has not indexed it yet; confirm later with 'npm view climier version'\n`);
      }
    } else {
      process.stderr.write("release: dry run complete; nothing was published or pushed\n");
    }
  } finally {
    if (worktree !== undefined) {
      tryRun("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot });
    }
  }
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
