# Operating a Climier remote server

This runbook covers the protocol v2 single-host deployment. The server is the
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

`listen.host` must be loopback. Set the password through the service manager or
private environment file, never as a command argument and never in JSON:

```sh
export CLIMIER_SERVER_PASSWORD='<high-entropy-password>'
node /path/to/climier/bin/climier-server.mjs /srv/climier/private/server.json
```

The launcher prints one JSON health line. A missing password, non-loopback
listener, legacy `credentials`/`projectIds` fields, or corrupt auth file fails
before the listener accepts requests. Keep `dataRoot`, `stateHome`, and the
configuration directory owned by the service account.

The first start creates `stateHome/remote-auth.json` with a password verifier
and bearer hashes. On POSIX, the directory is `0700` and the auth file is
`0600`; bearer tokens are never stored in clear text. A password change replaces
the verifier and clears all sessions before the server listens again. Every
client must log in again after rotation.

## TLS and network boundary

The Climier server intentionally listens only on loopback. For access from
another host, put a trusted reverse proxy on the same host, terminate TLS
there, and forward only the Climier API to `127.0.0.1:<port>`:

```text
client -- HTTPS --> trusted proxy -- loopback HTTP --> climier-server
```

The client rejects an HTTP origin that is not loopback. Do not enable a plaintext
remote listener, add an insecure HTTP environment switch, or expose the Node
listener directly. Configure the proxy's certificate, firewall, access logs,
and forwarded-client-address policy according to the host's security policy.
The server uses forwarded addresses for login rate limiting only when the peer
is the local proxy.

## Link and authenticate a checkout

Initialize a checkout once, then link its metadata to the v2 origin. A link
preserves the existing `project_id`; repeating the same link is safe. Changing
an origin requires an explicit replacement and does not copy or merge a DAG:

```sh
climier --project /srv/climier/checkouts/alpha init
climier --project /srv/climier/checkouts/alpha link https://climier.example.test
climier --project /srv/climier/checkouts/alpha login
```

`login` reads the password from an interactive TTY without echo, calls
`POST /v2/auth/login`, and stores only the bearer for that origin in the local
profile (`~/.climier/remote-sessions.json` by default). The profile directory
is `0700` and its file is `0600` on POSIX. The password and bearer must not be
placed in argv, environment variables, stdin, `.climier.json`, command output,
or logs. `logout` removes the local copy; it does not revoke the server hash.

If a checkout is cloned, preserve its `.climier.json` project ID and run
`login` on the new machine. A remote v2 config must contain exactly
`backend.protocol: "v2"`. An older remote config fails with
`REMOTE_CONFIG_OUTDATED` before authentication or local state I/O; run
`link <origin> --replace=true` as the explicit relink action.

Only authenticated remote `init` provisions an absent project directory. Reads,
normal operations, and batch requests never create storage implicitly. Remote
`init --force`, snapshots, restore, plugins, and local transfer commands are
unsupported. A linked remote DAG is operated in place; there is no sync or
DAG-transfer workflow.

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

## Verification and failure boundaries

Run the packaged two-client smoke with temporary homes; it verifies link,
interactive login, remote init, mutation/read visibility, distinct project IDs,
local sentinel isolation, invalid auth, password rotation, outdated config,
and endpoint failure without local fallback:

```sh
timeout -k 10s 180s node --test test/server-operations-e2e.test.mjs
```

The full required checks are:

```sh
timeout -k 10s 300s npm test
timeout -k 10s 180s npm run surface:check
timeout -k 10s 180s npm run comments:check
timeout -k 10s 180s git diff --check
```

A failed request must not mutate a local sentinel or silently retry against
local state. Check the structured `error.code`; common boundaries are
`AUTH_INVALID`, `REMOTE_CONFIG_OUTDATED`, `REMOTE_REQUEST_FAILED`,
`REMOTE_UNSUPPORTED_OPERATION`, and `SERVER_ALREADY_RUNNING`.
