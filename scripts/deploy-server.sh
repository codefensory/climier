#!/usr/bin/env bash
#
# Deploy the compiled server and the built UI to a remote host over SSH.
# The remote host only needs the compiled binary and a service manager; Bun is
# required locally for both builds.
#
# Usage:
#   scripts/deploy-server.sh              build, copy, configure, restart, verify
#   scripts/deploy-server.sh --check      report drift without changing anything
#   scripts/deploy-server.sh --help       show configuration and the full flow
#
# Configuration can be exported or loaded from CLIMIER_DEPLOY_ENV. The example
# file is scripts/deploy-server.env.example. Required values are:
#   CLIMIER_DEPLOY_REMOTE  SSH destination in <host>:<absolute-remote-root> form
#   CLIMIER_DEPLOY_TARGET  Bun target, for example linux-arm64
#   CLIMIER_DEPLOY_SERVICE systemd unit, for example climier-server.service
#   CLIMIER_DEPLOY_URL     server origin used for health and asset verification
#
# The deployment copies the binary to CLIMIER_DEPLOY_BINARY, replaces the UI
# root configured in server.json, restarts the unit, and verifies the served
# index and hashed asset byte for byte.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'
  cat <<'EOF'

Optional variables:
  CLIMIER_DEPLOY_ENV       env file to source
  CLIMIER_DEPLOY_CONFIG    remote server.json (default: <root>/server.json)
  CLIMIER_DEPLOY_BINARY    remote binary path (default: <root>/climier)
  CLIMIER_DEPLOY_UI_ROOT   remote absolute UI root (default: <root>/ui/dist)
  CLIMIER_DEPLOY_HEALTH_URL URL to probe (default: CLIMIER_DEPLOY_URL/)

The deployment flow is: build the target binary, build ui/dist, copy both over
SSH, ensure server.json.uiRoot names the copied UI root, restart systemd, then
verify the service, health URL, index, and hashed asset.
EOF
}

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  -h|--help) usage; exit 0 ;;
  *) echo "deploy-server: unknown option '$1'" >&2; usage; exit 2 ;;
esac

ENV_FILE=${CLIMIER_DEPLOY_ENV:-}
if [[ -z "$ENV_FILE" ]]; then
  for candidate in "$ROOT/.deploy.env" "${XDG_CONFIG_HOME:-$HOME/.config}/climier/deploy.env"; do
    if [[ -f "$candidate" ]]; then ENV_FILE=$candidate; break; fi
  done
fi
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || { echo "deploy-server: env file not found: $ENV_FILE" >&2; exit 2; }
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

: "${CLIMIER_DEPLOY_REMOTE:?deploy-server: set CLIMIER_DEPLOY_REMOTE to <host>:<absolute-path>}"
: "${CLIMIER_DEPLOY_TARGET:?deploy-server: set CLIMIER_DEPLOY_TARGET, for example linux-arm64}"
: "${CLIMIER_DEPLOY_SERVICE:?deploy-server: set CLIMIER_DEPLOY_SERVICE, for example climier-server.service}"
: "${CLIMIER_DEPLOY_URL:?deploy-server: set CLIMIER_DEPLOY_URL, for example https://climier.example.test}"

CLIMIER_DEPLOY_URL=${CLIMIER_DEPLOY_URL%/}
CLIMIER_DEPLOY_HEALTH_URL=${CLIMIER_DEPLOY_HEALTH_URL:-$CLIMIER_DEPLOY_URL/}
HOST=${CLIMIER_DEPLOY_REMOTE%%:*}
REMOTE_PATH=${CLIMIER_DEPLOY_REMOTE#*:}
[[ -n "$HOST" && "$HOST" != "$REMOTE_PATH" && "$REMOTE_PATH" == /* ]] || {
  echo "deploy-server: CLIMIER_DEPLOY_REMOTE must be '<host>:<absolute-path>'" >&2
  exit 2
}

CLIMIER_DEPLOY_CONFIG=${CLIMIER_DEPLOY_CONFIG:-$REMOTE_PATH/server.json}
CLIMIER_DEPLOY_BINARY=${CLIMIER_DEPLOY_BINARY:-$REMOTE_PATH/climier}
CLIMIER_DEPLOY_UI_ROOT=${CLIMIER_DEPLOY_UI_ROOT:-$REMOTE_PATH/ui/dist}
[[ "$CLIMIER_DEPLOY_UI_ROOT" == /* ]] || {
  echo "deploy-server: CLIMIER_DEPLOY_UI_ROOT must be an absolute remote path" >&2
  exit 2
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

remote() {
  ssh -- "$HOST" "$1"
}

config_ui_root() {
  node -e '
    let value;
    try { value = JSON.parse(require("node:fs").readFileSync(0, "utf8")); }
    catch (error) { console.error(`invalid remote server.json: ${error.message}`); process.exit(2); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      console.error("invalid remote server.json: expected an object"); process.exit(2);
    }
    process.stdout.write(typeof value.uiRoot === "string" ? value.uiRoot : "");
  '
}

set -f
TARGET_NAME=${CLIMIER_DEPLOY_TARGET#bun-}
BINARY_SUFFIX=
[[ "$TARGET_NAME" == windows-* ]] && BINARY_SUFFIX=.exe
BINARY="dist/climier-$TARGET_NAME$BINARY_SUFFIX"
DIST="$ROOT/ui/dist"
INDEX="$DIST/index.html"

asset_name() {
  grep -oE 'assets/[^"[:space:]]+\.js' "$INDEX" | head -1
}

local_asset_sha() {
  sha256sum "$DIST/$1" | awk '{print $1}'
}

require_local_artifacts() {
  [[ -x "$BINARY" ]] || { echo "deploy-server: missing $BINARY; run the binary build first" >&2; return 1; }
  [[ -f "$INDEX" ]] || { echo "deploy-server: missing $INDEX; run the UI build first" >&2; return 1; }
  ASSET=$(asset_name)
  [[ -n "$ASSET" && -f "$DIST/$ASSET" ]] || {
    echo "deploy-server: could not find the hashed JavaScript asset in $INDEX" >&2
    return 1
  }
  LOCAL_BINARY_SHA=$(sha256sum "$BINARY" | awk '{print $1}')
  LOCAL_ASSET_SHA=$(local_asset_sha "$ASSET")
}

remote_value() {
  remote "$1"
}

remote_health() {
  remote "curl --fail --silent --show-error --max-time 20 $(shell_quote "$CLIMIER_DEPLOY_HEALTH_URL") >/dev/null"
}

remote_index() {
  remote "curl --fail --silent --show-error --max-time 20 $(shell_quote "$CLIMIER_DEPLOY_URL/") | grep -F -- $(shell_quote "$ASSET") >/dev/null"
}

remote_asset_sha() {
  remote "curl --fail --silent --show-error --max-time 20 $(shell_quote "$CLIMIER_DEPLOY_URL/$ASSET") | sha256sum | cut -d ' ' -f1"
}

if [[ "$CHECK" == 1 ]]; then
  require_local_artifacts
  REMOTE_CONFIG_TEXT=$(remote "cat -- $(shell_quote "$CLIMIER_DEPLOY_CONFIG")")
  REMOTE_UI_ROOT=$(printf '%s' "$REMOTE_CONFIG_TEXT" | config_ui_root)
  REMOTE_BINARY_SHA=$(remote_value "sha256sum -- $(shell_quote "$CLIMIER_DEPLOY_BINARY") | cut -d ' ' -f1")
  REMOTE_ASSET_SHA=$(remote_asset_sha)
  SERVICE_STATE=$(remote_value "systemctl is-active $(shell_quote "$CLIMIER_DEPLOY_SERVICE") || true")
  DRIFT=0
  printf 'local binary : %s\n' "$LOCAL_BINARY_SHA"
  printf 'remote binary: %s\n' "$REMOTE_BINARY_SHA"
  printf 'configured UI: %s\n' "$REMOTE_UI_ROOT"
  printf 'expected UI  : %s\n' "$CLIMIER_DEPLOY_UI_ROOT"
  printf 'service      : %s\n' "$SERVICE_STATE"
  printf 'asset        : %s\n' "$REMOTE_ASSET_SHA"
  printf 'expected asset: %s\n' "$LOCAL_ASSET_SHA"
  [[ "$REMOTE_BINARY_SHA" == "$LOCAL_BINARY_SHA" ]] || DRIFT=1
  [[ "$REMOTE_UI_ROOT" == "$CLIMIER_DEPLOY_UI_ROOT" ]] || DRIFT=1
  [[ "$SERVICE_STATE" == active ]] || DRIFT=1
  [[ "$REMOTE_ASSET_SHA" == "$LOCAL_ASSET_SHA" ]] || DRIFT=1
  if remote_health; then
    echo "health       : ok"
  else
    echo "health       : failed" >&2
    DRIFT=1
  fi
  if remote_index; then
    echo "index        : ok"
  else
    echo "index        : failed" >&2
    DRIFT=1
  fi
  [[ "$DRIFT" == 0 ]] || { echo "deploy-server: drift detected" >&2; exit 1; }
  echo "deploy-server: level"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "deploy-server: working tree has uncommitted changes" >&2
  exit 1
fi

# Build locally. The remote host receives no source tree or package manager state.
echo "== build binary ($CLIMIER_DEPLOY_TARGET)"
bun run build:binary --target "$CLIMIER_DEPLOY_TARGET"
echo "== build UI (ui/dist)"
bun install --cwd ui --frozen-lockfile
bun run --cwd ui typecheck
bun run --cwd ui build
require_local_artifacts

REMOTE_TMP_BINARY="$CLIMIER_DEPLOY_BINARY.tmp.$$"
echo "== copy binary to $HOST:$CLIMIER_DEPLOY_BINARY"
cat "$BINARY" | remote "umask 077; mkdir -p $(shell_quote "$(dirname "$CLIMIER_DEPLOY_BINARY")"); cat > $(shell_quote "$REMOTE_TMP_BINARY"); chmod 755 $(shell_quote "$REMOTE_TMP_BINARY"); mv -f $(shell_quote "$REMOTE_TMP_BINARY") $(shell_quote "$CLIMIER_DEPLOY_BINARY")"

echo "== copy UI to $HOST:$CLIMIER_DEPLOY_UI_ROOT"
REMOTE_TMP_UI="$CLIMIER_DEPLOY_UI_ROOT.incoming.$$"
cat < <(tar czf - -C "$DIST" .) | remote "set -e; parent=$(shell_quote "$(dirname "$CLIMIER_DEPLOY_UI_ROOT")"); root=$(shell_quote "$CLIMIER_DEPLOY_UI_ROOT"); incoming=$(shell_quote "$REMOTE_TMP_UI"); mkdir -p \"\$parent\"; rm -rf \"\$incoming\"; mkdir \"\$incoming\"; tar xzf - -C \"\$incoming\"; rm -rf \"\$root.old\"; if [ -d \"\$root\" ]; then mv \"\$root\" \"\$root.old\"; fi; mv \"\$incoming\" \"\$root\"; rm -rf \"\$root.old\""

REMOTE_CONFIG_TEXT=$(remote "cat -- $(shell_quote "$CLIMIER_DEPLOY_CONFIG")")
REMOTE_UI_ROOT=$(printf '%s' "$REMOTE_CONFIG_TEXT" | config_ui_root)
if [[ "$REMOTE_UI_ROOT" != "$CLIMIER_DEPLOY_UI_ROOT" ]]; then
  UPDATED_CONFIG=$(printf '%s' "$REMOTE_CONFIG_TEXT" | node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(0, "utf8"));
    config.uiRoot = process.argv[1];
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  ' "$CLIMIER_DEPLOY_UI_ROOT")
  echo "== set server.json.uiRoot to $CLIMIER_DEPLOY_UI_ROOT"
  printf '%s' "$UPDATED_CONFIG" | remote "set -e; tmp=$(shell_quote "$CLIMIER_DEPLOY_CONFIG.tmp.$$"); cat > \"\$tmp\"; chmod 600 \"\$tmp\"; mv -f \"\$tmp\" $(shell_quote "$CLIMIER_DEPLOY_CONFIG")"
fi

echo "== restart $CLIMIER_DEPLOY_SERVICE"
remote "sudo systemctl restart $(shell_quote "$CLIMIER_DEPLOY_SERVICE")"
remote "systemctl is-active --quiet $(shell_quote "$CLIMIER_DEPLOY_SERVICE")" || {
  echo "deploy-server: service did not become active" >&2
  exit 1
}
remote_health || { echo "deploy-server: health check failed" >&2; exit 1; }
remote_index || { echo "deploy-server: served index does not reference $ASSET" >&2; exit 1; }
SERVED_ASSET_SHA=$(remote_asset_sha)
[[ "$SERVED_ASSET_SHA" == "$LOCAL_ASSET_SHA" ]] || {
  echo "deploy-server: served asset differs from the local build" >&2
  exit 1
}

echo "deploy-server: OK ($CLIMIER_DEPLOY_TARGET, $ASSET) on $HOST"
