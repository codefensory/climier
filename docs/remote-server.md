# Operating a Climier remote server

This runbook describes a single-host Node.js deployment of the built-in HTTP API. It uses only local example values; replace every `<...>` placeholder in your private deployment files. Never commit the private config, bearer tokens, machine names, IP addresses, or deployment paths. Node.js 20 or newer is required. The root CLI and server launcher use Node's standard library only.

## Install and configure

Install a reviewed Climier release on the server host using the project's normal package or deployment process. The package exposes `climier-server` alongside `climier`; the launcher and its `src/server` runtime must be present. Keep the service account, configuration, catalog, and state directories private to the service operator.

Create a private server config outside the checkout, for example `/srv/climier/private/server.json`:

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

Use absolute paths owned by the service account. Restrict the config to its owner (`chmod 600 /srv/climier/private/server.json` on Linux); it contains bearer credentials. The catalog and `stateHome` must be server-controlled and not writable by clients. The server maps catalog project IDs to hash-safe internal project directories and pins Climier state to `stateHome`; do not place `tasks.json`, a client-provided project path, or token in the client checkout. Back up the server catalog and `stateHome` together using a consistent filesystem or service-level backup procedure, and protect backups like the original data.

The example binds loopback for a local deployment or a TLS-terminating reverse proxy on the same host. For a remote network listener, explicitly select and secure the interface/firewall and terminate TLS at a trusted proxy; do not send bearer tokens over plaintext networks. A proxy should forward only the versioned Climier API and must not expose the private config or data directories.

Start in the foreground to verify the deployment:

```sh
node /path/to/climier/bin/climier-server.mjs /srv/climier/private/server.json
```

On success, stdout prints one JSON health line with `ok`, the listening `host`, and an allocated `port` (for example, when configured with port `0`). Confirm the reported address and port are the intended private listener before configuring clients. Startup/configuration errors are written to stderr and return a non-zero exit. In production, run the same command under the host's service manager with the private config path; do not put tokens in command-line arguments or service logs.

## Provision and connect clients

Add a project ID to `projectIds` and to the intended credential's `projectIds` in the private config, then restart the service to load the catalog. Generate a high-entropy bearer token with the operator's secret manager and deliver it through that manager, not source control or chat. Restart the service after rotating credentials and revoke old credentials from the config.

For each client checkout, configure only the opaque catalog ID and HTTPS API URL in `.climier.json`:

```json
{
  "version": 1,
  "project_id": "<opaque-project-id>",
  "backend": { "type": "remote", "url": "https://<operator-approved-api-origin>" }
}
```

Supply the token as `CLIMIER_TOKEN` from the secret manager. Separately approve the exact API origin with `CLIMIER_REMOTE_ORIGIN`; it must equal the origin parsed from `backend.url` (scheme, host, and port). This binding is not a secret and does not replace TLS. Never store the token in `.climier.json`. Use `climier init` from a configured remote client to initialize the already-cataloged project, then use ordinary supported remote commands. Remote errors, invalid authentication, and network failures are fail-closed: they do not authorize local state fallback.

## Health, shutdown, restart, and recovery

Check service health by observing the launcher's JSON line and probing the configured API with an authorized client command. Do not interpret a listening socket alone as proof that client credentials or project scope are correct. On planned shutdown, send `SIGTERM` through the service manager; the launcher closes its HTTP server. Restart with the same private config and storage roots. Keep the service offline while restoring a coordinated backup of catalog and state.

Climier serializes writes with a per-project `.lock`. If a process crashes and leaves a stale lock, first stop or isolate the service and verify that the lock owner is no longer running on the host that owns the storage. Confirm no other service instance can use that `stateHome`; only then remove the specific stale lock and restart. Never delete locks automatically, while a writer may be active, or as a general cleanup step. Preserve a backup before manual recovery and investigate repeated lock residue.

## Local two-client verification

The automated `test/server-operations-e2e.test.mjs` starts the packaged launcher on loopback with temporary config/catalog/state roots and independent client homes. It verifies launcher health, remote initialization, a mutation by client A visible to client B, unchanged client-local sentinel states, invalid bearer rejection, and endpoint-unavailable failure without local fallback. Run it with:

```sh
timeout -k 10s 180s node --test test/server-operations-e2e.test.mjs
```

This local test does not require or imply a Tailscale deployment. A separately authorized Tailscale smoke, when planned, must use temporary operator-controlled credentials and endpoints and publish only redacted evidence.
