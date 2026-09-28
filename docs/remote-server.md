# Operating a Climier remote server

This runbook covers a single-host Node.js deployment of the v1 HTTP API and
its one-time state import. Replace every `<...>` placeholder with a private
value. Never commit bearer tokens, machine names, IP addresses, deployment
paths, or the private config. Node.js 20 or newer is required; the CLI and
server use Node's standard library at runtime.

## Release window: import the existing project park

The v1 binary writes and reads only the canonical schema-1 state. Import is
mandatory for every project written by an older checkout. The importer writes a
complete backup of each project (state and revision ledger) before changing it.
Treat the import as one maintenance window:

1. **Install or link the v1 binary first.** Verify the intended binary with
   `climier --version` and make sure the control plane, UI, workers, and remote
   server will all use that binary after the window.
2. **Stop every writer.** Stop the control plane and workers, close the UI, and
   stop the remote server before migrating its `stateHome`. Do not let an old
   process retry while the import is running.
3. Review the complete park without writing it:

   ```sh
   climier migrate --all --dry-run
   ```

4. Import every project while all writers remain stopped:

   ```sh
   climier migrate --all
   ```

5. Verify each checkout/project before reopening writers. Run the command with
   the checkout whose `.climier.json` names that project:

   ```sh
   climier --project /srv/climier/checkouts/<project> status
   ```

   Confirm that the expected nodes and initiatives are present, then perform
   one authorized read or small mutation according to the project's change
   policy. Verify the server's catalog and every client that shares the state
   home. Only after these checks pass may the writers restart.

A pre-cut binary must not touch an imported project. It may classify schema-1
state as the prehistorical form and suggest `init --force`; that command can
erase data. If any old process starts during the window, stop it immediately,
do not accept the suggestion, and restore from the project's backup before
continuing.

### Rollback / camino de vuelta

If verification fails, keep **all writers stopped**. Because the v1 binary has
already been linked and the projects have been imported, reverse the window in
this order:

1. For each affected project, restore the complete backup made by the importer
   under `CLIMIER_HOME/backups/<project-id>/<timestamp>/` (state and revision
   ledger together). Restore one project at a time and preserve the failed v1
   files for investigation.
2. Verify the restored state with the same project-level command and confirm
   that its bytes and ledger match the backup before allowing a writer to open.
3. Relink the **previous** binary only after the backups are restored and
   verified. Never run the previous binary against an imported schema-1 state.
4. Restart one writer, verify the project, and then reopen the remaining
   writers in a controlled order.

The backup is the recovery boundary: do not run `init --force`, delete
`tasks.json`, or mix a state from one project with another project's ledger.
Record which projects were restored and the reason in the deployment log.

## Install and configure the server

Install the reviewed v1 package on the server host using the normal package or
deployment process. The package exposes `climier-server` alongside `climier`;
the launcher and its `src/server` runtime must be present. Keep the service
account, configuration, catalog, and state directories private.

Create a private config outside the checkout, for example
`/srv/climier/private/server.json`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 43127 },
  "dataRoot": "/srv/climier/catalog",
  "stateHome": "/srv/climier/state",
  "projectIds": ["<opaque-project-id>"],
  "credentials": [
    { "token": "<operator-generated-bearer-token>", "projectIds": ["<opaque-project-id>"] }
  ]
}
```

Use absolute paths owned by the service account and restrict the config to its
owner (`chmod 600 /srv/climier/private/server.json` on Linux). It contains
bearer credentials. The catalog and `stateHome` must not be writable by
clients. Back up the catalog and `stateHome` together with a consistent
filesystem or service-level backup procedure, and protect those backups like
the original data.

The example binds loopback for a local deployment or a TLS-terminating reverse
proxy on the same host. For a network listener, explicitly secure the
interface/firewall and terminate TLS at a trusted proxy. Do not send bearer
tokens over plaintext networks. A proxy must forward only the versioned Climier
API and must not expose the private config or data directories.

Start in the foreground to verify the deployment:

```sh
node /path/to/climier/bin/climier-server.mjs /srv/climier/private/server.json
```

On success, stdout prints one JSON health line with `ok`, the listening `host`,
and the allocated `port` (for example, when configured with port `0`). Confirm
the reported address and port before configuring clients. Configuration errors
are written to stderr and return non-zero. In production, run the same command
under the host's service manager; do not put tokens in command-line arguments
or service logs.

## Provision and connect a client

Add a project ID to `projectIds` and to the intended credential's `projectIds`,
then restart the service to load the catalog. Generate a high-entropy bearer
token with the operator's secret manager. Rotate credentials by updating the
private config, restarting, and revoking the old token.

For each client checkout, configure only the opaque catalog ID and HTTPS API
URL in `.climier.json`:

```json
{
  "version": 1,
  "project_id": "<opaque-project-id>",
  "backend": { "type": "remote", "url": "https://<operator-approved-api-origin>" }
}
```

Supply the token as `CLIMIER_TOKEN` from the secret manager. Set
`CLIMIER_REMOTE_ORIGIN` to exactly the origin parsed from `backend.url` (scheme,
host, and port). Never store the token in `.climier.json`. Use `climier init`
from a configured remote client only after the import window has been verified;
then use the supported remote commands. Remote errors and invalid
authentication fail closed and never fall back to local state.

## Internal-only plaintext HTTP exception

HTTPS is the default and recommended transport. The only exception is internal,
opt-in use on a network whose operators explicitly assume responsibility for
confidentiality and integrity. Set exactly
`CLIMIER_ALLOW_INSECURE_REMOTE_HTTP=true` in the client environment; never put
it in `.climier.json`. Keep `CLIMIER_TOKEN` secret and still set
`CLIMIER_REMOTE_ORIGIN` to the exact approved origin. Remove the variable and
use HTTPS to reverse the exception.

## Health, shutdown, restart, and stale-lock recovery

Check service health by observing the launcher's JSON line **and** probing the
API with an authorized client command. A listening socket alone does not prove
credentials or project scope. On planned shutdown, send `SIGTERM` through the
service manager; the launcher closes its HTTP server. Keep the service offline
while restoring a coordinated catalog/state backup.

Climier serializes writes with a per-project `.lock`. Locks are deliberately
not auto-cleared. If a process crashes and leaves one behind:

1. Stop or isolate the service and every other writer for that `stateHome`.
2. On the host that owns the storage, verify that the lock owner's process is
   gone and that no second service instance can write the project.
3. Preserve a backup and record the verification (process/service check,
   project id, and timestamp).
4. Remove only that specific stale lock, then run the project-level `status`
   command and confirm it reads the expected schema-1 state before resuming.
5. Investigate repeated lock residue; never remove a lock while a writer may be
   active and never use a blanket cleanup command.

The recovery contract is covered by the test
`stale lock recovery requires verified manual removal before schema-1 operation resumes`
in `test/lock.test.mjs`. It verifies timeout without auto-clear, explicit lock
removal, and a subsequent schema-1 read/write. Run it with:

```sh
timeout -k 10s 180s node --test --test-name-pattern="stale lock recovery requires verified manual removal" test/lock.test.mjs
```

## Local two-client verification

The packaged end-to-end test starts the launcher on loopback with temporary
catalog/state roots and independent client homes. It verifies health, remote
initialization, a mutation visible to a second client, unchanged client-local
sentinels, invalid bearer rejection, and endpoint-unavailable failure without
local fallback:

```sh
timeout -k 10s 180s node --test test/server-operations-e2e.test.mjs
```

This test does not require a Tailscale deployment. A separately authorized
network smoke must use temporary operator-controlled credentials and publish
only redacted evidence.
