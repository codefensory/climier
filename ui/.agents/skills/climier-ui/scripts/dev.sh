#!/usr/bin/env bash
# Levanta y baja los servidores de desarrollo de climier-ui.
#
#   dev.sh start [dev|storybook|both]     (default: both)
#   dev.sh stop  [dev|storybook|both]
#   dev.sh status
#   dev.sh restart [dev|storybook|both]
#
# Por qué existe: matar procesos por nombre es peligroso acá. `pkill -f "vite"` (o `"storybook dev"`) también
# matchea el shell que lo invoca y la sesión se mata a sí misma, así que hay que matar por puerto. Y el dev
# server escucha en IPv6, así que `127.0.0.1:5173` da ERR_CONNECTION_REFUSED con el server levantado: la URL
# es `http://localhost:5173/`.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

DEV_PORT=5173
SB_PORT=6006
LOG_DIR="$ROOT/.logs"

declare -A PORT_OF=( [dev]=$DEV_PORT [storybook]=$SB_PORT )
declare -A SCRIPT_OF=( [dev]="dev" [storybook]="storybook" )

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

port_pid() {
  # Un pid por puerto, tomado de ss. `[::1]:5173` y `0.0.0.0:6006` entran igual.
  #
  # El `|| true` es imprescindible: con `set -o pipefail`, un `grep` sin resultados hace fallar la tubería, y
  # con `set -e` eso mata el script en la rama más común —el puerto libre, o sea el caso normal.
  ss -ltnp 2>/dev/null | grep -oE ":${1}\\b.*pid=([0-9]+)" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | head -1 || true
}

is_up() { [ -n "$(port_pid "${PORT_OF[$1]}")" ]; }

wait_up() {
  local target="$1" port="${PORT_OF[$1]}" tries=0
  while [ "$tries" -lt 60 ]; do
    if is_up "$target"; then return 0; fi
    sleep 1
    tries=$((tries + 1))
  done
  tail -n 15 "$LOG_DIR/$target.log" 2>/dev/null || true
  fail "$target no levantó en 60s en el puerto $port"
}

start() {
  local target="$1"
  if is_up "$target"; then say "  $target ya estaba arriba (puerto ${PORT_OF[$target]})"; return 0; fi
  mkdir -p "$LOG_DIR"
  # setsid + nohup para que sobreviva al shell que lo lanza; el log queda para diagnosticar.
  setsid nohup bun run "${SCRIPT_OF[$target]}" > "$LOG_DIR/$target.log" 2>&1 < /dev/null &
  wait_up "$target"
  say "  $target arriba (puerto ${PORT_OF[$target]}) → log en .logs/$target.log"
}

stop() {
  local target="$1" pid
  pid="$(port_pid "${PORT_OF[$target]}")"
  if [ -z "$pid" ]; then say "  $target no estaba corriendo"; return 0; fi
  kill "$pid" 2>/dev/null || true
  local tries=0
  while [ "$tries" -lt 15 ] && is_up "$target"; do sleep 1; tries=$((tries + 1)); done
  is_up "$target" && kill -9 "$pid" 2>/dev/null || true
  say "  $target abajo (era pid $pid)"
}

status() {
  local target port pid
  for target in dev storybook; do
    port="${PORT_OF[$target]}"
    pid="$(port_pid "$port")"
    if [ -n "$pid" ]; then
      say "  $target   ARRIBA   puerto $port   pid $pid"
    else
      say "  $target   abajo    puerto $port"
    fi
  done
  if is_up dev; then say "  app        http://localhost:5173/     (IPv6: usá localhost, no 127.0.0.1)"; fi
  if is_up storybook; then say "  storybook  http://127.0.0.1:6006/"; fi
}

targets() {
  case "${1:-both}" in
    both) printf 'dev storybook\n' | tr ' ' '\n' ;;
    dev | storybook) printf '%s\n' "$1" ;;
    *) fail "destino desconocido: $1 (usá dev, storybook o both)" ;;
  esac
}

action="${1:-status}"
case "$action" in
  start | stop | restart)
    for target in $(targets "${2:-both}"); do
      [ "$action" = restart ] && stop "$target"
      "$action" "$target"
    done
    ;;
  status) status ;;
  *) fail "uso: dev.sh [start|stop|status|restart] [dev|storybook|both]" ;;
esac
