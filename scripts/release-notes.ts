#!/usr/bin/env bun
// Builds the GitHub Release body for a tag from that version's CHANGELOG
// section. `gh release create --generate-notes` only lists merged pull
// requests, so a repository that pushes straight to main publishes a bare
// compare link; the changelog section is the release's real content, and the
// compare link is appended instead of replacing it.

import fs from "node:fs";
import path from "node:path";

export type ReleaseNotesInput = {
  changelog: string;
  version: string;
  compareBase?: string | null;
  repository?: string | null;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Body of `## [<version>]`, heading included and the next release excluded.
 * Null when the version has no section or the section carries no content.
 */
export function extractChangelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/u);
  const heading = new RegExp(`^##+ \\[${escapeRegExp(version)}\\](?:\\s|$)`, "u");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) { return null; }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start, end === -1 ? undefined : end).join("\n").replace(/\s+$/u, "");
  const content = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
  return content ? body : null;
}

export function renderReleaseNotes({ changelog, version, compareBase, repository }: ReleaseNotesInput): string {
  const section = extractChangelogSection(changelog, version);
  if (section === null) {
    throw new Error(`release-notes: CHANGELOG.md has no usable '## [${version}]' section`);
  }
  const blocks = [section];
  if (compareBase && repository) {
    blocks.push(`**Full Changelog**: https://github.com/${repository}/compare/${compareBase}...v${version}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

type CliOptions = {
  version: string;
  changelogFile: string;
  out?: string;
  compareBase?: string;
  repository?: string;
};

const KNOWN_FLAGS = ["version", "changelog", "out", "compare-base", "repository"] as const;

function flagName(arg: string): { name: string; inlineValue?: string } | null {
  const inline = /^--([a-z-]+)=(.*)$/u.exec(arg);
  if (inline) { return { name: inline[1], inlineValue: inline[2] }; }
  if (!arg.startsWith("--")) { return null; }
  return { name: arg.slice(2) };
}

function cliOptions(values: Record<string, string>): CliOptions {
  if (!values.version) { throw new Error("release-notes: --version is required"); }
  return {
    version: values.version,
    changelogFile: values.changelog ?? "CHANGELOG.md",
    out: values.out,
    compareBase: values["compare-base"],
    repository: values.repository,
  };
}

function parseArgs(argv: string[]): CliOptions {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const parsed = flagName(arg);
    if (parsed === null) { throw new Error(`release-notes: unexpected argument '${arg}'`); }
    if (!(KNOWN_FLAGS as readonly string[]).includes(parsed.name)) {
      throw new Error(`release-notes: unknown flag '--${parsed.name}'`);
    }
    const value = parsed.inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) { throw new Error(`release-notes: --${parsed.name} needs a value`); }
    values[parsed.name] = value;
  }
  return cliOptions(values);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const changelog = fs.readFileSync(path.resolve(options.changelogFile), "utf8");
  const notes = renderReleaseNotes({
    changelog,
    version: options.version,
    compareBase: options.compareBase ?? null,
    repository: options.repository ?? process.env.GITHUB_REPOSITORY ?? null,
  });
  if (options.out === undefined) {
    process.stdout.write(notes);
    return;
  }
  fs.writeFileSync(path.resolve(options.out), notes, "utf8");
  process.stderr.write(`release-notes: wrote ${options.out} for v${options.version}\n`);
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
