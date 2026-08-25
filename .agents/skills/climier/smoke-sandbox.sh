#!/usr/bin/env bash
# smoke-sandbox.sh — aísla smokes mutantes de climier del CLIMIER_HOME real.
#
# Usage:
#   bash .agents/skills/climier/smoke-sandbox.sh -- <command> [args...]
#
# Comportamiento:
#   - exige `--` como primer argumento antes del comando a ejecutar.
#   - crea un directorio temporal privado y exporta
#     CLIMIER_HOME=<sandbox>/home, de modo que init/init --force y otras
#     mutaciones sobre un proyecto temporal no toquen el home real.
#   - aplica umask 077 para que el sandbox sea inaccesible a otros usuarios.
#   - ejecuta el comando sin capturar ni alterar stdout/stderr y propaga su
#     exit code.
#   - limpia el sandbox en EXIT, HUP, INT y TERM. Un residual tras SIGKILL es
#     aceptable porque vive fuera del home real.
#
# El helper funciona tanto si el proyecto trae .climier.json copiado como si
# no trae metadata. Los protocolos worker y validator de climier prohíben
# invocar init/init --force o mutaciones de smoke fuera de este helper.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: bash .agents/skills/climier/smoke-sandbox.sh -- <command> [args...]

Isolates the wrapped command by exporting CLIMIER_HOME to a private temp dir.
Required by climier worker and validator protocols for any mutating smoke
that targets a temporary project (init, init --force, ...).
EOF
}

if [[ $# -lt 2 || "$1" != "--" ]]; then
  usage
  exit 64
fi
shift

if [[ $# -lt 1 ]]; then
  usage
  exit 64
fi

# Permisos privados en archivos/dirs creados por el sandbox.
umask 077

# Sandbox privado. TMPDIR respeta la convencion del sistema; cae a /tmp.
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/climier-smoke-XXXXXX")"

# Cleanup en EXIT y en señales que terminarian el proceso. SIGKILL escapa
# al trap por diseño; eso esta documentado como aceptable.
trap 'rm -rf "$sandbox"' EXIT HUP INT TERM

# Aislamos CLIMIER_HOME. La exportacion siempre gana sobre el valor externo,
# asi que smokes externos no pueden filtrar al home real.
export CLIMIER_HOME="$sandbox/home"
mkdir -p "$CLIMIER_HOME"

# Ejecuta el comando. stdout/stderr salen tal cual; el exit code del comando
# es el exit code del script.
"$@"
