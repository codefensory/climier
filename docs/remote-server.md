# Operating a Climier remote server

This runbook covers the Remote v1 single-host deployment. The server is the
only source of truth for a linked remote project; the repository checkout
contains only its project ID and the server origin. Node.js 20 or newer and no
runtime packages beyond Node's standard library are required.

## Configure one private server

Keep the JSON configuration outside the checkout, readable only by the service
account. It contains no password, bearer, project allowlist, or project data:

```json
{
  "listen": { "host": "127.0.0.1", "port": 43127 },
  "dataRoot": "/srv/climier/data",
  "stateHome": "/srv/climier/state"
}
```

This example uses loopback, but `listen.host` is an operator choice: Climier
accepts any non-empty host string and leaves binding and network exposure to the
operating system and the operator. Set the password through the service manager
or private environment file, never as a command argument and never in JSON:

```sh
export CLIMIER_SERVER_PASSWORD='<high-entropy-password>'
/path/to/climier-server /srv/climier/private/server.json
```

The launcher prints one JSON health line. A missing password, malformed listener,
legacy `credentials`/`projectIds` fields, or corrupt auth file fails before the
listener accepts requests. An address rejected by the operating system fails at
bind time. Keep `dataRoot`, `stateHome`, and the configuration directory owned
by the service account.

The API body limit defaults to 1,048,576 bytes. For large snapshot transfers,
set `CLIMIER_SERVER_MAX_BODY_BYTES` in the private service environment to an
integer from 1 through 33,554,432, sized to the expected DAG. The cap remains
bounded; invalid values prevent the server from starting.

The first start creates `stateHome/remote-auth.json` with a password verifier
and bearer hashes. On POSIX, the directory is `0700` and the auth file is
`0600`; bearer tokens are never stored in clear text. A password change replaces
the verifier and clears all sessions before the server listens again. Every
client must log in again after rotation.

## Serving the web UI

The server also serves the built Solid UI at the origin root (non-`/v1`
`GET`/`HEAD`) with SPA fallback, immutable caching for `/assets/*`, and
`no-cache` for `index.html`. `/v1/*` keeps its JSON contract and never returns
`index.html`.

The root defaults to `<package>/ui/dist`; set `uiRoot` to an absolute path in
the server JSON to override it. If the build is missing, `/` answers `503` with
a short hint and the API keeps working. Build the bundle before starting the
service:

```sh
cd ui
bun install --frozen-lockfile
bun run build
```

### Deploy the compiled server and UI

The supported deployment procedure ships a compiled server binary and the
static UI bundle; the host does not need Bun, Node.js, a checkout, or UI
runtime dependencies. The old out-of-tree deployment patch is retired: the
operator controls the listener address through `listen.host`, and the service
runs the binary built from the repository revision being deployed.

Prepare the host once with a private `server.json`, a systemd unit, and an
absolute deployment root. The unit's `ExecStart` must point at the deployed
binary and config, for example:

```ini
[Service]
ExecStart=/srv/climier/climier-server /srv/climier/server.json
```

Set `uiRoot` in that config to the path where the script will install the UI.
The script defaults to `/srv/climier/ui/dist` when the remote root is
`/srv/climier`; it updates and validates this field before restarting:

```json
{
  "listen": { "host": "100.64.0.10", "port": 43127 },
  "dataRoot": "/srv/climier/data",
  "stateHome": "/srv/climier/state",
  "uiRoot": "/srv/climier/ui/dist"
}
```

Copy `scripts/deploy-server.env.example` to the gitignored `.deploy.env` and
set the SSH destination, Bun target, systemd unit, and origin. Supported
binary targets include `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, and `windows-x64`; the target must match the service host.
Then run:

```sh
scripts/deploy-server.sh
scripts/deploy-server.sh --check
```

A deployment runs `bun run build:binary --target "$CLIMIER_DEPLOY_TARGET"`,
builds `ui/dist`, copies the binary and bundle over SSH, ensures the remote
`server.json` has the explicit absolute `uiRoot`, restarts the unit, and
checks the service health URL plus the hashed UI asset byte for byte. `--check`
only reads local build artifacts and remote state; it reports drift without
copying files, changing `server.json`, or restarting the service. If the
origin is only reachable from the server, set `CLIMIER_DEPLOY_HEALTH_URL` and
`CLIMIER_DEPLOY_URL` to URLs that the host can access. Do not run the real
production deployment from an implementation task; use `bash -n`, `--help`,
and `--check` with a test host or missing configuration for local validation.

The SPA authenticates with the same `POST /v1/auth/login` password; it lists
projects with `GET /v1/projects` and reads one project with
`/v1/projects/:id/ui/snapshot`, `/ui/nodes/:nodeId`, `/ui/activity`, and the
`/ui/events` SSE stream (revision notifications; the client revalidates the
snapshot with `ETag`).

## TLS and network boundary

HTTPS is the default and recommended transport for every remote origin. Climier
does not enforce a listener address or transport topology: the operator chooses
whether to bind loopback, an interface, a wildcard, or another host accepted by
the operating system, and is responsible for TLS, a private overlay, firewall,
and proxy policy. For TLS on the same host, a trusted reverse proxy can forward
to a loopback upstream:

```text
client -- HTTPS --> trusted TLS proxy -- loopback HTTP --> climier-server
```

If remote clients connect directly over HTTP, the login password and bearer are
sent without transport encryption. Successful `login`, `link`, and remote
`init` commands add a `warnings` field with kind `insecure-remote-http`,
severity `warning`, and the configured origin when HTTP is non-loopback. Use
`--no-warnings` before or after a command to suppress that non-blocking field.
The destination still comes from `.climier.json`, and bearer sessions remain
indexed by origin. For large snapshots, the private service environment can
also contain `CLIMIER_SERVER_MAX_BODY_BYTES=16777216` (16 MiB); choose the
smallest cap that fits the transfer.

## Link, authenticate, and provision a checkout

`link` creates `.climier.json` and a project ID if the checkout has no metadata;
otherwise it preserves the existing `project_id`. Then log in and run `init`
while linked to provision that project on the remote server:

```sh
climier --project /srv/climier/checkouts/alpha link https://climier.example.test
climier --project /srv/climier/checkouts/alpha login
climier --project /srv/climier/checkouts/alpha init
```

`login` reads the password from an interactive TTY without echo, calls
`POST /v1/auth/login` with `X-Climier-Protocol-Version: 1`, and stores only the
bearer for that origin in the local profile (`~/.climier/remote-sessions.json`
by default). The profile directory
is `0700` and its file is `0600` on POSIX. The password and bearer must not be
placed in argv, environment variables, stdin, `.climier.json`, command output,
or logs. For a remote HTTP origin, successful `login` reports the transport
warning described above; pass `--no-warnings` when that field is not wanted.
The project-specific destination remains in `.climier.json` and sessions are
indexed by origin in the local profile. `logout` removes the local copy; it does
not revoke the server hash.

Linking an existing local checkout preserves its project ID but does not upload
or merge its local DAG. Remote `init` provisions the server-side project; it is
not a migration. Transfers are separate, explicit snapshot operations described
below. Changing an origin requires `climier link <new-origin> --replace=true`;
it keeps the project ID but does not copy data between servers.

If a checkout is cloned, preserve its `.climier.json` project ID and run
`login` on the new machine. The canonical remote metadata contains only the
backend type and complete URL. A checkout carrying a retired protocol marker
fails with `REMOTE_CONFIG_OUTDATED` before authentication or local state I/O;
run `link <configured-origin>` to clean it, using `--replace=true` only when
changing the URL.

Only authenticated remote `init` provisions an absent project directory. Reads,
normal operations, batch requests, `push`, and `pull` never create storage
implicitly. Remote `init --force`, snapshots, restore, and plugins are
unsupported.

## Manual local / remote transfers

`push` and `pull` are **EXPERIMENTAL / UNSAFE** manual transfers of a complete
DAG snapshot for the same `project_id`. They require a linked Remote v1 backend
and a valid bearer from `login`. `link` only selects the backend: it does not
transfer the local DAG. To publish local work for the first time, initialize it
locally, then link, log in, provision the remote with `init`, and push:

```sh
# The checkout already has its local DAG and project ID.
climier link https://climier.example.test
climier login
climier init
climier push --as alice
```

`init` creates a pristine remote project; it does not import local state. A
normal first push is accepted only by that pristine destination. `push` never
provisions an absent project. A non-pristine destination without a confirmed
transfer baseline fails instead of being overwritten.

For offline work, pull the latest snapshot before selecting local state. Remove
the `backend` object from `.climier.json` while preserving `project_id`; this
versioned metadata change makes normal commands use local state. When online
again, link the origin, log in, and push:

```sh
climier login
climier pull --as alice
# Remove `backend` from .climier.json; keep project_id.
# Work against the local DAG while offline.
climier link https://climier.example.test
climier login
climier push --as alice
```

The non-secret transfer baseline is stored outside the checkout at
`$CLIMIER_HOME/remote-transfer-baselines/` (default `~/.climier`), scoped by
origin and project ID. It is not copied by git or by `link`. Preserve the same
`CLIMIER_HOME` to retain the baseline. Without a baseline, pull accepts only an
absent or pristine local destination; push accepts only a pristine initialized
remote. With a baseline, CAS compares the destination revision to the last
confirmed transfer. Conflicts do not mutate either DAG; choose an explicit side
with `push --force` or `pull --force` only after review.

Both `--force` forms replace the **entire destination DAG**, including claims,
`in_progress`, plugin data, and its log. The winning snapshot retains its own
log and adds a `transfer.push` or `transfer.pull` event with the replaced
revision. That event does not preserve or recover the discarded destination
log. Back up both sides before force; the feature is experimental and unsafe.
There is no merge, automatic fallback, journal, or retry. A network timeout may
be ambiguous: the remote may have committed even though the local baseline was
not advanced. Inspect the destination or pull before choosing whether to retry
or use force.

## Backup, rotation, and recovery

Back up `stateHome`, `remote-auth.json`, and `dataRoot` together using a
consistent filesystem or service-level snapshot. Protect the backup as both a
secret and the original DAG data. Stop the server before restoring. Never use
`init --force`, delete a project state, or restore a ledger without its matching
state file as a recovery shortcut.

To rotate the password, stop the service, provide the new
`CLIMIER_SERVER_PASSWORD`, and start it against the same `stateHome`. The
server durably writes the new verifier and an empty session list before
listening. Existing bearers fail closed; each client must run `login` again.
If startup or persistence fails, do not report a successful rotation or reopen
the proxy.

If `remote-auth.json` is corrupt, stop the service and take a backup first.
Move only that file aside, then restart with the intended password. The server
creates fresh auth and leaves project DAGs, ledgers, and `dataRoot` untouched;
all clients must log in again. Never delete `tasks.json`, the ledger, or the
whole state directory for auth recovery.

The service lock at `stateHome/.server.lock` covers the entire process lifetime.
A second process using the same `stateHome` fails with `SERVER_ALREADY_RUNNING`
before listening. A normal shutdown releases it. If a crash leaves it behind,
verify that the recorded PID and service are gone, back up `stateHome`, remove
only that lock, and restart. Never auto-delete a lock while another process may
be active.

## Live cutover from the retired wire

Cutting a linked deployment over to Remote v1 is a manual, single-window
operation; no runner or task performs it. It assumes one host serving the API
under a service manager and one or more linked checkouts.

Preflight, over an administrative channel rather than client metadata:

- Inventory the process and listener that answer the origin; when a reverse
  proxy is in front, confirm it has no upstream or alias for the retired
  routes. Never infer the server from `.climier.json`.
- Record the deployed server revision, the stable CLI revision, and whether the
  server worktree carries local patches.
- Stop every writer and record hashes of `tasks.json`, `revision-ledger.json`,
  `stateHome/remote-auth.json`, and the catalog metadata.

Window:

1. Back up the server code path, the private config directory (`dataRoot`,
   `stateHome`, `server.json`, and the service environment), and the exact
   `.climier.json` of each active checkout.
2. Stop the server and confirm the service lock is released.
3. Deploy the v1 server, preserving any deployment-only patch, and leave it
   stopped.
4. Update the stable CLI to the same revision.
5. Clean each checkout with `link <configured-url>`; `link` is metadata-only and
   must reach its adapter without selecting a backend.
6. Start the server and confirm the health line, a protocol header of `1` on
   every response, `426` when that header is absent or different, and `404` for
   the retired routes.
7. Run `login` only if the origin or credentials changed, then only read-only
   commands; re-read the step-0 hashes and require them to be unchanged.

Rollback: stop the writers, restore the backed-up server code and private
config, restore the exact `.climier.json` (a retired-wire CLI rejects metadata
without `backend.protocol`), and compare the state hashes again. Never restore
or migrate the DAG as part of the rollback, and never run `init`, `push`, or
`pull` on the active project during the cutover. A deployment that listens on a
private-network address is an operator choice; review its TLS, overlay,
firewall, and proxy configuration and keep deployment configuration versioned
rather than relying on an uncommitted worktree patch.

## Verification and failure boundaries

Run the server operations E2E with an isolated Remote v1 server; it verifies
two-client isolation, auth/no-fallback, remote provisioning, the offline
transfer cycle, revision conflicts, both force directions, state/plugin/claim
preservation, ledger continuity, and an ambiguous dropped transfer response:

```sh
timeout -k 10s 180s node --test test/server-operations-e2e.test.mjs
```

Run the packed-artifact smoke with temporary homes; it installs the package,
provisions a Remote v1 server, and executes push and pull without the retired
`CLIMIER_TOKEN` or legacy route fallback:

```sh
timeout -k 10s 180s npm run smoke:pack
```

The full required checks are:

```sh
timeout -k 10s 300s npm test
timeout -k 10s 180s npm run surface:check
timeout -k 10s 180s git diff --check
```

A failed request must not mutate a local sentinel or silently retry against
local state. Check the structured `error.code`; common boundaries are
`AUTH_INVALID`, `REMOTE_CONFIG_OUTDATED`, `REMOTE_REQUEST_FAILED`,
`REMOTE_UNSUPPORTED_OPERATION`, and `SERVER_ALREADY_RUNNING`.
