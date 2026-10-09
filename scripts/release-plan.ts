#!/usr/bin/env bun
/* oxlint-disable complexity -- linear planner: git parsing plus a fixed classification order. */
// Proposes the next release from the commits after the last tag.
//
// Only product changes drive a release. A commit counts toward the bump when it
// touches at least one shipped code path (src/, bin/, ui/) and its type is feat
// (minor), fix/perf (patch), or it is a breaking change (major). Documentation,
// agent tooling (.pi/, .agents/, skills/), decision records, tests, CI, release
// scripts and packaging-only edits to package.json never drive a release, so a
// docs-only range deploys through docs.yml without touching npm.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Bump = "major" | "minor" | "patch" | "none";

export type CommitInput = {
  sha: string;
  subject: string;
  body: string;
  files: string[];
};

export type ClassifiedCommit = {
  sha: string;
  type: string;
  scope?: string;
  description: string;
  breaking: boolean;
  touchesProduct: boolean;
  releaseWorthy: boolean;
  section: string;
};

export type ExcludedCommit = {
  sha: string;
  type: string;
  description: string;
  reason: string;
};

export type ReleasePlan = {
  baseTag: string | null;
  baseVersion: string;
  bump: Bump;
  nextVersion: string;
  releaseWorthy: boolean;
  excluded: ExcludedCommit[];
  changelog: string;
  commits: ClassifiedCommit[];
};

const BUMP_TYPES: Readonly<Record<string, "minor" | "patch">> = Object.freeze({ feat: "minor", fix: "patch", perf: "patch" });

const SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance Improvements",
  revert: "Reverts",
  docs: "Documentation",
  build: "Build System",
  ci: "Continuous Integration",
  refactor: "Refactoring",
  test: "Tests",
  style: "Styles",
  chore: "Chores",
});

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<description>.+)$/u;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/mu;

const PRODUCT_ROOTS = Object.freeze(["src/", "bin/", "ui/"]);

export function isProductPath(file: string): boolean {
  return PRODUCT_ROOTS.some((root) => file.startsWith(root));
}

export function classifyCommit(commit: CommitInput): ClassifiedCommit {
  const match = CONVENTIONAL.exec(commit.subject);
  const type = match?.groups?.type ?? "other";
  const scope = match?.groups?.scope;
  const description = (match?.groups?.description ?? commit.subject).replace(/\s*\[(?:T|G|K)-[^\]]+\]\s*$/u, "");
  const breaking = Boolean(match?.groups?.breaking) || BREAKING_FOOTER.test(commit.body);
  const touchesProduct = commit.files.some(isProductPath);
  const bumpType = BUMP_TYPES[type];
  return {
    sha: commit.sha,
    type,
    ...(scope ? { scope } : {}),
    description,
    breaking,
    touchesProduct,
    releaseWorthy: touchesProduct && (breaking || bumpType !== undefined),
    section: SECTIONS[type] ?? "Other Changes",
  };
}

export function selectBump(commits: ClassifiedCommit[]): Bump {
  const worthy = commits.filter((commit) => commit.releaseWorthy);
  if (worthy.some((commit) => commit.breaking)) { return "major"; }
  if (worthy.some((commit) => commit.type === "feat")) { return "minor"; }
  if (worthy.some((commit) => commit.type === "fix" || commit.type === "perf")) { return "patch"; }
  return "none";
}

export function bumpVersion(version: string, bump: Bump): string {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(version);
  if (!match?.groups) { throw new Error(`release-plan: version '${version}' is not semver`); }
  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);
  if (bump === "major") { return `${major + 1}.0.0`; }
  if (bump === "minor") { return `${major}.${minor + 1}.0`; }
  if (bump === "patch") { return `${major}.${minor}.${patch + 1}`; }
  return `${major}.${minor}.${patch}`;
}

export function renderChangelog(commits: ClassifiedCommit[], repository = "https://github.com/codefensory/climier"): string {
  const grouped = new Map<string, ClassifiedCommit[]>();
  for (const commit of commits) {
    const list = grouped.get(commit.section) ?? [];
    list.push(commit);
    grouped.set(commit.section, list);
  }
  const blocks: string[] = [];
  for (const section of [...Object.values(SECTIONS), "Other Changes"]) {
    const list = grouped.get(section);
    if (!list || list.length === 0) { continue; }
    const lines = list.map((commit) => {
      const scope = commit.scope ? `**${commit.scope}:** ` : "";
      const link = `([${commit.sha.slice(0, 7)}](${repository}/commit/${commit.sha}))`;
      return `- ${scope}${commit.description} ${link}${commit.breaking ? " **BREAKING**" : ""}`;
    });
    blocks.push(`### ${section}\n\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

export function planRelease({ baseTag, baseVersion, commits, repository }: { baseTag?: string | null; baseVersion: string; commits: CommitInput[]; repository?: string }): ReleasePlan {
  const classified = commits.map(classifyCommit);
  const bump = selectBump(classified);
  const worthy = classified.filter((commit) => commit.releaseWorthy);
  const excluded = classified
    .filter((commit) => !commit.releaseWorthy)
    .map((commit) => ({
      sha: commit.sha,
      type: commit.type,
      description: commit.description,
      reason: commit.touchesProduct
        ? `type '${commit.type}' does not drive a release`
        : "no product paths (src/, bin/, ui/)",
    }));
  return {
    baseTag: baseTag ?? null,
    baseVersion,
    bump,
    nextVersion: bumpVersion(baseVersion, bump),
    releaseWorthy: bump !== "none",
    excluded,
    changelog: renderChangelog(worthy, repository),
    commits: classified,
  };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { throw new Error(`release-plan: 'git ${args.join(" ")}' exited ${result.status ?? "unknown"}`); }
  return (result.stdout ?? "").trim();
}

function tryGit(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) { return undefined; }
  return (result.stdout ?? "").trim() || undefined;
}

function collectCommits(range: string, cwd: string): CommitInput[] {
  return git(["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range], cwd)
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, ...body] = record.split("\x1f");
      const files = git(["show", "--name-only", "--format=", sha], cwd).split("\n").map((line) => line.trim()).filter(Boolean);
      return { sha, subject: subject ?? "", body: body.join("\x1f"), files };
    });
}

function main(): void {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const explicitBase = baseIndex === -1 ? undefined : args[baseIndex + 1];
  const repository = process.env.CLIMIER_RELEASE_REPOSITORY ?? "https://github.com/codefensory/climier";
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
  const baseTag = explicitBase ?? tryGit(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"], repoRoot);
  const baseVersion = baseTag ? baseTag.replace(/^v/u, "") : packageVersion;
  const commits = collectCommits(baseTag ? `${baseTag}..HEAD` : "HEAD", repoRoot);
  process.stdout.write(`${JSON.stringify(planRelease({ baseTag: baseTag ?? null, baseVersion, commits, repository }), null, 2)}\n`);
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
