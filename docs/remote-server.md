# Operating a Climier remote server

This runbook documents one setup path for a Remote v1 server. The server is the
source of truth for a linked project; a checkout stores only its project ID and
server origin. The path uses the packaged `climier` and `climier-server`
commands and does not depend on deployment scripts outside the package.

## One setup path: generate, check, start, connect

Run `server init` on the host that will own the private configuration. It writes
`server.json`, `server.env`, and, by default, a systemd unit. The configuration
contains no password; `server.env` contains a freshly generated 32-byte
base64url secret. All three files are written with mode `0600` and the data and
state directories are created with mode `0700` unless path creation is
explicitly deferred.

Start with a dry run when choosing paths. It reports the files and actions but
writes neither artifacts nor directories:

```sh
climier server init --root /srv/climier \
  --host localhost --port 43127 \
  --data-root /srv/climier/data \
  --state-home /srv/climier/state \
  --ui-root /srv/climier/ui/dist \
  --dry-run
```

Generate the artifacts with the same options, omitting `--dry-run`:

```sh
climier server init --root /srv/climier \
  --host localhost --port 43127 \
  --data-root /srv/climier/data \
  --state-home /srv/climier/state \
  --ui-root /srv/climier/ui/dist
```

The default `--unit systemd` creates
`/srv/climier/climier-server.service`. `server init` never installs, enables,
or starts it. If the binary is not at `/srv/climier/climier-server`, place the
packaged `climier-server` binary there or choose a root that contains the
binary; `init` does not install binaries. Use `--service-user <user>` only when
the service identity is an explicit operator choice. `init` reports the
required ownership commands but does not run `chown`, `chmod`, `sudo`, or other
privileged operations.

Use `--unit none` when a container or a foreground process supplies its own
process supervisor. This still generates `server.json` and `server.env`, but no
unit file. Use `--allow-missing-paths` when generating the artifacts before
`dataRoot` or `stateHome` is mounted or created by the runtime; it prevents
`init` from creating those directories. The later preflight must still be able
to resolve writable paths before the server starts.

### Preflight before binding

Run either preflight surface after generating the files. Both use the same
checks and do not start the server, acquire the service lock, or create the
runtime directories. `climier-server --check` should name the generated env
file explicitly:

```sh
climier-server --check /srv/climier/server.json \
  --env-file /srv/climier/server.env
```

From the setup root, `climier server doctor` uses `server.json` and
`server.env` by default. Otherwise pass `--config` and `--env-file` (and put the
global project flag before the command):

```sh
climier --project /srv/climier server doctor
# Optional: add --probe-bind; add --strict to make bind/UI warnings fail.
```

The env file is parsed as strict `KEY=VALUE` data; it is not executed as a
shell script. The checks cover configuration shape and permissions, storage
paths, the secret, the optional UI root, and the bounded body-size setting.
`--probe-bind` is opt-in because it briefly opens the configured address;
without `--strict`, port and missing-UI findings are warnings. Neither check
proves that systemd is delivering the `EnvironmentFile`, and `doctor` does not
detect drift between the generated unit and a unit already installed in
systemd. Inspect the installed unit separately when changing it.

### Start the service or run in the foreground

For the generated systemd unit, apply any `pending` ownership commands from
`server init`, then install the unit file using the path reported by `files.unit`
and start it:

```sh
sudo install -m 600 /srv/climier/climier-server.service \
  /etc/systemd/system/climier-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now climier-server.service
```

For `--unit none`, a foreground launch must provide the generated secret to the
process environment without putting it in argv or logs. The generated env file
contains only simple assignments and is private:

```sh
set -a
. /srv/climier/server.env
set +a
/srv/climier/climier-server /srv/climier/server.json
```

Do not print, copy into command arguments, or commit the generated server secret.
`--print-secret` is intentionally the sole exception for controlled recovery or
handoff; it is unsafe and should not be used in routine setup. To rotate it,
stop the service, run `climier server init --root /srv/climier --rotate-password`,
run preflight again, and start the service. Rotation
rewrites only the secret, invalidates existing sessions, and requires every
client to log in again; it does not require `--force`.

### Connect a client checkout

After the service is reachable, configure a checkout. `link` and `login` are
client-side operations; `login` reads the password interactively from a TTY.
Read the secret through a protected administrative channel rather than putting
it in shell history, environment variables, output, or logs:

```sh
climier link https://climier.example.test
climier login --server https://climier.example.test
climier init
```

`init` here provisions the server-side project. It does not upload an existing
local DAG. Use the explicit transfer commands documented below when a complete
snapshot transfer is required. `server init`, `server doctor`, and `server setup`
are local host operations and remain available when the checkout is linked to a
remote backend.

## Serving the web UI

The server serves the built Solid UI at the origin root (non-`/v1` `GET`/`HEAD`)
with SPA fallback, immutable caching for `/assets/*`, and `no-cache` for
`index.html`. `/v1/*` keeps its JSON contract and never returns `index.html`.

The root defaults to `<package>/ui/dist`; set `--ui-root` during `server init`
to use an absolute path elsewhere. If the build is missing, `/` answers `503`
with a short hint while the API keeps working. Build the bundle with the
package's documented UI commands before starting the service:

```sh
cd ui
bun install --frozen-lockfile
bun run build
```

The SPA authenticates with the same `POST /v1/auth/login` password; it lists
projects with `GET /v1/projects` and reads one project with
`/v1/projects/:id/ui/snapshot`, `/ui/nodes/:nodeId`, `/ui/activity`, and
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

To rotate the password, stop the service and run
`climier server init --root /srv/climier --rotate-password`. Run the preflight,
then start the service against the same `stateHome`. The generated secret stays
in the private `server.env`; it is never printed by default. The server durably
writes the new verifier and an empty session list before listening. Existing
bearers fail closed; each client must run `login` again. If startup or
persistence fails, do not report a successful rotation or reopen the proxy.

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

## Verification and failure boundaries

Before accepting a deployment, rerun the preflight checks described above and
confirm that the generated paths are writable by the service identity. For a
linked client, verify `login`, a read-only command, and one authenticated
write against a disposable project before serving production data.

A failed request must not mutate a local sentinel or silently retry against
local state. Check the structured `error.code`; common boundaries are
`AUTH_INVALID`, `REMOTE_CONFIG_OUTDATED`, `REMOTE_REQUEST_FAILED`,
`REMOTE_UNSUPPORTED_OPERATION`, and `SERVER_ALREADY_RUNNING`.
