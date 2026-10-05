#!/usr/bin/env bash
# Verificación completa de climier-ui, en el orden en que conviene descubrir las cosas.
#
#   verify.sh            typecheck + tests + build
#   verify.sh --fast      sin build (typecheck + tests)
#
# El typecheck corre primero a propósito: un error de tipos es el que menos tarda en aparecer y el que más
# ruido hace en los tests si se cuela.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

step() { printf '\n▸ %s\n' "$*"; }

step "typecheck (tsc -b: app + node + storybook)"
bun run typecheck

step "tests (vitest en Chromium: humo + play + axe)"
bun run test:run

if [ "$FAST" -eq 0 ]; then
  step "build de producción (no compila stories)"
  bun run build
fi

step "¿el árbol se movió mientras corría esto?"
recent="$(find src .storybook -newermt '-5 minutes' -type f 2>/dev/null | wc -l)"
if [ "$recent" -gt 0 ]; then
  printf '  ojo: %s archivos modificados en los últimos 5 minutos.\n' "$recent"
  printf '  Si no fuiste vos, estos resultados son de un árbol que cambió bajo los pies.\n'
  find src .storybook -newermt '-5 minutes' -type f 2>/dev/null | head -5 | sed 's/^/    /'
else
  printf '  sin cambios recientes: el veredicto es sobre un árbol quieto.\n'
fi

printf '\nlisto\n'
