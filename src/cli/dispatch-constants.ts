import packageJson from "../../package.json" with { type: "json" };

import type { CommandLoader } from "./commands/contracts.ts";

export const COMMANDS = Object.freeze({
  accept: () => import("./commands/accept.ts"),
  "add-edge": () => import("./commands/add-edge.ts"),
  "add-gate": () => import("./commands/add-gate.ts"),
  "add-initiative": () => import("./commands/add-initiative.ts"),
  "add-knowledge": () => import("./commands/add-knowledge.ts"),
  "add-node": () => import("./commands/add-node.ts"),
  "add-note": () => import("./commands/add-note.ts"),
  "add-task": () => import("./commands/add-task.ts"),
  batch: () => import("./commands/batch.ts"),
  cancel: () => import("./commands/cancel.ts"),
  context: () => import("./commands/context.ts"),
  "deprecate-knowledge": () => import("./commands/deprecate-knowledge.ts"),
  history: () => import("./commands/history.ts"),
  initiatives: () => import("./commands/initiatives.ts"),
  init: () => import("./commands/init.ts"),
  install: () => import("./commands/install.ts"),
  link: () => import("./commands/link.ts"),
  login: () => import("./commands/login.ts"),
  logout: () => import("./commands/logout.ts"),
  log: () => import("./commands/log.ts"),
  migrate: () => import("./commands/migrate.ts"),
  pull: () => import("./commands/pull.ts"),
  push: () => import("./commands/push.ts"),
  reject: () => import("./commands/reject.ts"),
  release: () => import("./commands/release.ts"),
  rename: () => import("./commands/rename.ts"),
  "remove-edge": () => import("./commands/remove-edge.ts"),
  reopen: () => import("./commands/reopen.ts"),
  resolve: () => import("./commands/resolve.ts"),
  restore: () => import("./commands/restore.ts"),
  server: () => import("./commands/server.ts"),
  search: () => import("./commands/search.ts"),
  show: () => import("./commands/show.ts"),
  snapshots: () => import("./commands/snapshots.ts"),
  state: () => import("./commands/state.ts"),
  status: () => import("./commands/status.ts"),
  submit: () => import("./commands/submit.ts"),
  take: () => import("./commands/take.ts"),
  ui: () => import("./commands/ui.ts"),
  urls: () => import("./commands/urls.ts"),
  version: () => import("./commands/version.ts"),
  upgrade: () => import("./commands/upgrade.ts"),
  uninstall: () => import("./commands/uninstall.ts"),
  update: () => import("./commands/update.ts"),
} satisfies Readonly<Record<string, CommandLoader>>);

export const PACKAGE_VERSION = packageJson.version;

export const HELP_TEXT = "climier — JSON-first task DAG CLI for coordinating work\n\nUse it when one or many actors need a shared source of truth for what is\nready, claimed, blocked, decided, backlog, done, or archived.\n\nCommon patterns:\n  solo / multi-session: status -> context -> take -> work -> submit -> accept\n  human + AI:           add-task -> context -> take -> add-note -> submit -> accept\n  with a policy plugin: see docs/PLUGINS.md (ADR-007/008); the core\n                        no longer recognises actor names like\n                        \"orchestrator\"/\"recovery\" as authority.\n\nUsage: climier [--project <dir>] <command> [args...]\n\nOutput: every command prints a single JSON value to stdout.\nErrors: { ok: false, error: { code, message, details } } on stdout, non-zero exit.\nExceptions: --help/-h/help and --version/version print plain text.\n\nRead-only:\n  status [--initiative X] [--kind task|gate|knowledge] [--status X] [--domain X]\n        [--claimed-by X] [--stale-ms N] [--limit N] [--all]\n                                          Summary-shape: task buckets (ready/in_progress/blocked/backlog), open gates, knowledge count, alerts.\n                                          in_progress is global by default: every in_progress task is listed and counted\n                                          regardless of caller. Use --claimed-by <agent> to narrow to one agent's claims.\n                                          --as is an identity tag (it scopes context's allowed_actions) and is not a filter\n                                          for status.\n  context <id>                           Agent-first view of a node: spec, blockers, informing edges, scoped knowledge, allowed actions.\n  search \"<query>\" [--all]               Search active knowledge; --all includes deprecated knowledge.\n  initiatives                            List registered initiatives with usage counts.\n  log [--limit N] [--action X] [--agent X] [--node X]\n                                          Show the audit log.\n  history <id> [--limit N]               Log entries that reference a node.\n  show <id>                              Print the raw node object.\n  snapshots                              List recoverable snapshots captured under <state-dir>/snapshots/, newest first.\n  state                                  Read the deterministic current core projection (not historical snapshots).\n  migrate [--project <dir>] [--all] [--dry-run]  Report detected state forms; dry-run is read-only.\n  ui [--port N] [--open=true|false]      Start the local read-only web UI on loopback and open it in the browser.\n                                          Serves the static UI and the same /v1 read contract as the hosted server (catalog, login, snapshot with ETag, nodes, activity, SSE) for every local project.\n  urls [--initiative X] [--id NODE] [--port N] [--origin URL]\n                                          Print UI deep links; local-only links work while `climier ui` runs on this machine.\n  upgrade [--check] [--version X]          Upgrade the installed distribution, or check for a release.\n  server doctor [--config P] [--env-file P] [--probe-bind] [--strict]\n                                          Run server preflight checks without starting or binding the server.\n  server init|setup [--root P] [--host H] [--port N] [--data-root P] [--state-home P]\n                    [--ui-root P] [--service-user U] [--service-name N] [--unit systemd|none]\n                    [--allow-missing-paths] [--dry-run] [--force] [--rotate-password]\n                    [--print-secret] [--yes]\n                                          Generate local server artifacts or collect the same options interactively.\n\nMutating (require --as <agent-id>):\n  batch --file <json> --as <agent>       Execute an atomic batch from a JSON file.\n  batch --stdin --as <agent>             Execute an atomic batch from stdin.\n  take <id> --as <agent>                 Claim a ready task (idempotent when you already hold the claim).\n  submit <id> --note \"...\" --as <agent>  Submit an owned in-progress task for validation.\n  accept <id> --as <agent>               Accept a submitted task as done.\n  reject <id> --reason \"...\" --as <agent> Return a submitted task to open with a reason.\n                                          A policy plugin may authorise taking over another actor's claim.\n  release <id> --as <agent>              Free a claim (idempotent when the task is unclaimed). A policy\n                                          plugin may authorise releasing any claim.\n  cancel <id> --reason \"<text>\" --as <agent>\n                                          Terminate a node without resolving (open/in_progress only).\n  resolve <id> --choice \"<text>\" --rationale \"<text>\" --as <agent>\n                                          Resolve a choice gate; tasks close only through submit then accept.\n  reopen <id> --reason \"<text>\" --as <agent>\n                                          Re-open a done task or resolved gate; downstream tasks re-block.\n  restore <snapshot-id> --as <agent>      Replace the live state with the snapshot's raw bytes (validates target\n                                          schema-1 shape first; takes a pre-restore raw snapshot before changing state).\n                                          A policy plugin may deny or further restrict this action.\n  login [--server <origin>]               Authenticate to a remote server using an interactive TTY password prompt.\n  logout [--server <origin>]              Remove the local credential for a remote server origin.\n  link <origin> [--replace=true]          Link this checkout to a remote server origin.\n  push --as <actor> [--force]             Copy local DAG to Remote v1 (`/v1`, header 1; EXPERIMENTAL / UNSAFE).\n  pull --as <actor> [--force]             Copy Remote v1 (`/v1`, header 1) DAG to local (EXPERIMENTAL / UNSAFE).\n                                          --force replaces the complete destination DAG; make a backup first. Use bare --force after the command (not --force=true). Requires Remote v1 link + login; no local fallback.\n  deprecate-knowledge <id> --reason \"...\" --as <agent>\n                                          Soft-delete a knowledge node (sets status=deprecated + reason).\n\nAdding to the DAG:\n  add-task [id] --initiative X --title \"...\" --body \"...\" --acceptance \"...\" --blocked-by \"...\"\n                                          Append a task. Id is auto-allocated as T-xxxxxxxx when omitted.\n  add-gate [id] --initiative X --title \"...\" --body \"...\" --purpose decision|approval|external-dependency|research [--supersedes OLD]\n                                          Append a gate.\n  add-knowledge [id] --initiative X --title \"...\" --body \"...\" --scope-domains X [--supersedes OLD]\n                                          Append a knowledge node.\n  add-initiative <name> [--desc \"...\"]   Register an initiative.\n  add-node <id> --kind resolvable|knowledge --title \"...\" [--subkind task|gate] [--blocked-by A,B] [--derived-from A,B] [--refs a,b] [--meta '{...}']\n                                          Low-level node creation (prefer add-task/add-gate/add-knowledge).\n  add-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM\n                                          Low-level edge creation.\n  remove-edge <from> <to> --type BLOCKS|SUPERSEDES|DERIVED_FROM\n                                          Idempotently remove one exact edge.\n\nEditing (any agent; status guard applies):\n  update <id> [--title X] [--body \"...\"] [--initiative X] [--domain Y] [--tags ...]\n              [--backlog true|false] [--if-revision N] --as <agent>\n                                          Edit a node's fields; increments revision.\n  add-note <id> \"text\" --as <agent>      Append a note to a node's running thread (any status).\n\nSetup:\n  init [--force]                          Create .climier.json and the project's live state.\n  rename \"<name>\"                         Set this project's display name (the label shown in the UI). Defaults to the checkout directory name.\n  server init|doctor|setup                Manage local server setup artifacts and preflight checks.\n\nGlobal flags:\n  --project <dir>                         Project root (default: CWD)\n  --help, -h                              Show this help and exit\n  --version                               Show the package version and exit\n  --no-warnings                           Suppress non-blocking transport warnings\n\nDocs: see README.md for quickstart, workflow, storage model, and command reference.\n\nAvailable commands:\n  status, context, take, submit, accept, reject, resolve, release, cancel, reopen, search, history,\n  show, update, add-note, add-initiative, add-task, add-gate, add-knowledge,\n  deprecate-knowledge, add-node, add-edge, remove-edge, initiatives, log, init, snapshots, state,\n  restore, batch, login, logout, link, push, pull, migrate, server, ui, urls, upgrade, rename, help, version.";

export const BOOLEAN_FLAGS = Object.freeze(new Set(["all", "force", "stdin", "dry-run", "probe-bind", "strict", "no-warnings", "check"]));

export const LOCAL_ONLY_COMMANDS = new Set<string>(["server", "version", "upgrade"]);

export const KNOWN_COMMANDS = Object.freeze([
  "status", "context", "take", "submit", "accept", "reject", "resolve", "release", "cancel", "reopen",
  "search", "history", "show", "update", "add-note", "add-initiative", "add-task", "add-gate", "add-knowledge",
  "deprecate-knowledge", "add-node", "add-edge", "remove-edge", "initiatives", "log", "init", "snapshots", "state",
  "restore", "batch", "login", "logout", "link", "push", "pull", "migrate", "server", "ui", "urls", "help", "version", "upgrade", "rename",
]);

export const REMOTE_SUPPORTED_COMMANDS = new Set<string>([
  "status", "context", "show", "history", "search", "initiatives", "log", "state",
  "take", "submit", "accept", "reject", "resolve", "release", "cancel", "reopen",
  "update", "add-note", "add-initiative", "add-task", "add-gate", "add-knowledge",
  "deprecate-knowledge", "add-node", "add-edge", "remove-edge", "batch", "init", "login", "logout", "link", "push", "pull", "urls", "rename",
]);
