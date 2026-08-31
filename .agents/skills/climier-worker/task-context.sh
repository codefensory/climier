#!/usr/bin/env bash
set -euo pipefail

current_root="$(git rev-parse --show-toplevel)"
project_root="$(git -C "$current_root" worktree list --porcelain | sed -n '1{s/^worktree //p;}')"

if [[ "${1:-}" == "--project-root" ]]; then
  printf '%s\n' "$project_root"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: bash .agents/skills/climier-worker/task-context.sh <task-id> [--docs|--full]" >&2
  echo "   or: bash .agents/skills/climier-worker/task-context.sh --project-root" >&2
  exit 1
fi

task_id="$1"
shift
include_docs=false
full=false

for arg in "$@"; do
  case "$arg" in
    --docs)
      include_docs=true
      ;;
    --full)
      include_docs=true
      full=true
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: bash .agents/skills/climier-worker/task-context.sh <task-id> [--docs|--full]" >&2
      exit 1
      ;;
  esac
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# a single `climier context` call is the canonical snapshot.
# `context` returns node + derived_status + can_claim + revision + claim +
# blocking[] + knowledge[] + informing[] + alerts[] + allowed_actions[].
climier --project "$project_root" context "$task_id" >"$tmpdir/context.json"

node - "$project_root" "$task_id" "$tmpdir" "$include_docs" "$full" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = process.argv[2];
const taskId = process.argv[3];
const tmpdir = process.argv[4];
const includeDocs = process.argv[5] === "true";
const full = process.argv[6] === "true";

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(tmpdir, name), "utf8"));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractDocRefs(text) {
  if (!text) return [];
  const refs = [];
  const patterns = [
    /(?:^|[\s(])((?:\.\/)?(?:docs|\.decisions)\/[^\s)\]]+\.md)(?=$|[\s).,\]])/g,
    /(?:^|[\s(])((?:\.\/)?(?:ARCHITECTURE\.md|README\.md|(?:apps|packages|\.agents|\.pi)\/[A-Za-z0-9._/-]+\.md|[A-Za-z0-9._/-]*AGENTS\.md))(?=$|[\s).,\]])/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) refs.push(match[1]);
  }
  return unique(refs);
}

function readRef(ref, includeContent = false) {
  const filePath = path.resolve(projectRoot, ref);
  if (!fs.existsSync(filePath)) {
    return { ref, filePath, missing: true, content: "" };
  }
  return {
    ref,
    filePath,
    missing: false,
    content: includeContent ? fs.readFileSync(filePath, "utf8").trim() : "",
  };
}

function formatList(values) {
  return values.length ? values.join(", ") : "(none)";
}

function printSection(title, body = "") {
  process.stdout.write(`\n## ${title}\n`);
  if (body) process.stdout.write(`${body}\n`);
}

function summarizeNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return "(none)";
  return notes
    .map((note) => `- ${note.ts || "no-ts"} ${note.agent || "unknown"}: ${note.text || ""}`)
    .join("\n");
}

function summarizeBlocker(b) {
  const n = b.node || {};
  return [
    `- ${n.id} (${n.kind || "?"}${n.subkind ? `:${n.subkind}` : ""}): ${n.title || ""}`,
    `  status: ${n.status || "?"}`,
    `  satisfied: ${String(b.satisfied)}`,
  ].join("\n");
}

function summarizeKnowledge(k) {
  const n = k.node || {};
  return [
    `- ${n.id} (${n.knowledge_type || "knowledge"}): ${n.title || ""}`,
    `  status: ${n.status || "active"}`,
    `  scope_matches: ${formatList(k.scope_matches || [])}`,
    `  mitigation: ${n.mitigation || "(none)"}`,
  ].join("\n");
}

function summarizeInform(i) {
  const n = i.node || {};
  return `- ${n.id}: ${n.title || ""} (status: ${n.status || "?"})`;
}

const context = readJson("context.json");
const node = context.node || {};

// Keep this helper on the public CLI surface. In particular, do not read
// ~/.climier/projects/<id>/tasks.json directly: the state file is owned by
// Climier. The current context command exposes incoming BLOCKS and informing
// edges; a future snapshot/graph command can add dependents and full lineage
// without weakening that boundary.

const blocking = Array.isArray(context.blocking) ? context.blocking : [];
const informing = Array.isArray(context.informing) ? context.informing : [];
const knowledge = Array.isArray(context.knowledge) ? context.knowledge : [];
const alerts = Array.isArray(context.alerts) ? context.alerts : [];
const allowed = Array.isArray(context.allowed_actions) ? context.allowed_actions : [];
const claim = context.claim || null;
const notes = Array.isArray(node.notes) ? node.notes : [];

// Doc-ref extraction across all available text fields.
const rawTexts = [
  node.body,
  node.definition,
  node.acceptance,
  node.purpose,
  ...notes.map((n) => (typeof n === "string" ? n : n.text || "")),
  ...knowledge.map((k) => `${k.node?.mitigation || ""} ${k.node?.body || ""}`),
  ...blocking.map((b) => `${b.node?.body || ""} ${b.node?.title || ""}`),
];
const docRefs = unique(rawTexts.flatMap(extractDocRefs));
const docs = docRefs.map((ref) => readRef(ref, includeDocs));

const specFlags = [];
if (!firstNonEmpty(node.definition)) specFlags.push("definition missing");
if (!firstNonEmpty(node.acceptance)) specFlags.push("acceptance missing");
if (!node.domain) specFlags.push("domain missing");
if (!Array.isArray(node.tags) || node.tags.length === 0) specFlags.push("tags missing");

printSection(
  "Context",
  [
    `project_root: ${projectRoot}`,
    `task: ${taskId}`,
    `mode: ${full ? "full" : includeDocs ? "docs" : "light"}`,
    `derived_status: ${context.derived_status || "(unknown)"}`,
    `can_claim: ${String(context.can_claim)}`,
    `revision: ${context.revision ?? "(none)"}`,
    `claim: ${claim ? JSON.stringify(claim) : "(none)"}`,
    "snapshot: single context call is the snapshot; do not re-run unless state changed.",
  ].join("\n"),
);

printSection(
  "Task",
  [
    `id: ${node.id || taskId}`,
    `kind: ${node.kind || "(none)"}${node.subkind ? ` subkind=${node.subkind}` : ""}`,
    `title: ${node.title || ""}`,
    `initiative: ${node.initiative || "(none)"}`,
    `priority: ${node.priority || "(none)"}`,
    `domain: ${node.domain || "(none)"}`,
    `tags: ${formatList(node.tags || [])}`,
    `meta: ${node.meta ? JSON.stringify(node.meta) : "(none)"}`,
    "",
    "definition:",
    firstNonEmpty(node.definition) || "(none)",
    "",
    "acceptance:",
    firstNonEmpty(node.acceptance) || "(none)",
    "",
    "body:",
    firstNonEmpty(node.body) || "(none)",
    "",
    "notes:",
    summarizeNotes(notes),
  ].join("\n"),
);

printSection(
  "Blocking (incoming BLOCKS)",
  blocking.length ? blocking.map(summarizeBlocker).join("\n") : "(none)",
);

printSection(
  "Dependents (outgoing BLOCKS)",
  "(not exposed by context; use the project graph/snapshot when available)",
);

printSection(
  "Informing (outgoing INFORMS)",
  informing.length ? informing.map(summarizeInform).join("\n") : "(none)",
);

printSection(
  "Knowledge",
  knowledge.length ? knowledge.map(summarizeKnowledge).join("\n") : "(none)",
);

printSection(
  "Lineage",
  "(not exposed by context; use the project graph/snapshot when available)",
);

printSection(
  "Alerts",
  alerts.length ? alerts.map((a) => `- [${a.kind || "?"}] ${a.message || JSON.stringify(a)}`).join("\n") : "(none)",
);

printSection(
  "Allowed actions",
  allowed.length ? allowed.map((a) => `- ${a}`).join("\n") : "(none)",
);

printSection(
  "Spec flags",
  specFlags.length ? specFlags.map((flag) => `- ${flag}`).join("\n") : "(none)",
);

printSection(
  "Docs",
  docs.length
    ? docs
        .map((doc) =>
          doc.missing
            ? `- ${doc.ref} (missing at ${doc.filePath})`
            : `- ${doc.ref} (${doc.filePath})`,
        )
        .join("\n")
    : "(none)",
);

for (const doc of docs) {
  if (!includeDocs) continue;
  printSection(`Doc: ${doc.ref}`, doc.missing ? `(missing at ${doc.filePath})` : doc.content || "(empty file)");
}

// Verdict: GO if claimable OR already claimed by the current view; NO-GO otherwise.
const isClaimable = context.can_claim === true;
const isClaimed = claim !== null;
const verdict = isClaimable ? "GO" : "NO-GO";
const nextAction = isClaimable
  ? specFlags.length
    ? "Claimable, but the spec has gaps. Update the node before take if they are objective."
    : "Claimable. Take the node if the spec matches reality."
  : isClaimed
    ? "Already claimed. Resume work and submit when done."
    : "Do not claim. Fix blockers (or ask the orchestrator to cure the node).";

printSection("Verdict", `${verdict}: ${nextAction}`);
NODE
