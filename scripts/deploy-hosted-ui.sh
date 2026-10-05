#!/usr/bin/env bash
#
# Nivela y actualiza el servidor remoto de la UI hosteada, y lo reinicia.
#
# El server corre desde un checkout git en un host SSH y **no** tiene toolchain de
# build, así que el bundle `ui/dist` se construye localmente y se copia. El script:
#
#   1. exige el árbol local limpio y calcula el commit a desplegar: `deploy-base`
#      fusionado con `HEAD`, reutilizando la rama de deploy si ya lo contiene;
#   2. instala, typechequea y construye `ui/dist` desde el checkout local;
#   3. empuja ese commit a un ref temporal en el host —no se puede pushear la rama
#      que está checkouteada— y hace `merge --ff-only` en la rama de deploy;
#   4. copia el `ui/dist` construido (swap atómico dentro de `ui/`);
#   5. reinicia el servicio y verifica que sirva byte a byte el asset local.
#
# La configuración no vive en el repo: copiá `scripts/deploy-hosted-ui.env.example`
# a `.deploy.env` (ignorado por git) o exportá las variables de entorno.
#
# Uso:
#   scripts/deploy-hosted-ui.sh            # nivela, actualiza y reinicia
#   scripts/deploy-hosted-ui.sh --check    # sólo reporta drift, no toca nada
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; }

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "" ) ;;
  -h|--help) usage; exit 0 ;;
  *) echo "deploy: opción desconocida '$1'" >&2; usage; exit 2 ;;
esac

ENV_FILE=${CLIMIER_DEPLOY_ENV:-}
if [[ -z "$ENV_FILE" ]]; then
  for candidate in "$ROOT/.deploy.env" "${XDG_CONFIG_HOME:-$HOME/.config}/climier/deploy.env"; do
    if [[ -f "$candidate" ]]; then ENV_FILE=$candidate; break; fi
  done
fi
# shellcheck disable=SC1090
[[ -n "$ENV_FILE" ]] && source "$ENV_FILE"

: "${CLIMIER_DEPLOY_REMOTE:?definí CLIMIER_DEPLOY_REMOTE, ej. mi-host:/srv/climier/server}"
: "${CLIMIER_DEPLOY_SERVICE:?definí CLIMIER_DEPLOY_SERVICE, ej. climier-server.service}"
CLIMIER_DEPLOY_URL=${CLIMIER_DEPLOY_URL:-}
CLIMIER_DEPLOY_URL=${CLIMIER_DEPLOY_URL%/}
CLIMIER_DEPLOY_BRANCH=${CLIMIER_DEPLOY_BRANCH:-deploy/hosted-ui}
CLIMIER_DEPLOY_BASE=${CLIMIER_DEPLOY_BASE:-deploy-base}
CLIMIER_DEPLOY_UI=${CLIMIER_DEPLOY_UI:-ui}
HOST=${CLIMIER_DEPLOY_REMOTE%%:*}
REMOTE_PATH=${CLIMIER_DEPLOY_REMOTE#*:}

if [[ "$HOST" == "$REMOTE_PATH" || -z "$REMOTE_PATH" ]]; then
  echo "deploy: CLIMIER_DEPLOY_REMOTE debe ser '<host>:<path>'" >&2
  exit 2
fi

ssh_remote() { ssh "$HOST" "$@"; }

# ── 1. Precondiciones y commit de deploy ─────────────────────────────────────
git diff --quiet && git diff --cached --quiet || { echo "deploy: el árbol tiene cambios sin commitear" >&2; exit 1; }
git rev-parse --verify --quiet "$CLIMIER_DEPLOY_BASE" >/dev/null || { echo "deploy: no existe la rama base '$CLIMIER_DEPLOY_BASE'" >&2; exit 1; }
git rev-parse --verify --quiet "$CLIMIER_DEPLOY_BRANCH" >/dev/null || git branch "$CLIMIER_DEPLOY_BRANCH" "$CLIMIER_DEPLOY_BASE"

SHA=$(git rev-parse HEAD)
PENDING=0
if git merge-base --is-ancestor "$SHA" "$CLIMIER_DEPLOY_BRANCH"; then
  DEPLOY_SHA=$(git rev-parse "$CLIMIER_DEPLOY_BRANCH")
else
  # Merge pendiente: se calcula sin tocar el índice ni la rama; se materializa recién al desplegar.
  PENDING=1
  TREE=$(git merge-tree --write-tree "$CLIMIER_DEPLOY_BRANCH" "$SHA")
  # El bundle se construye desde HEAD: si la fusión cambia `ui/`, hay que resolver a mano.
  git diff --quiet "$TREE" "$SHA^{tree}" -- "$CLIMIER_DEPLOY_UI" || { echo "deploy: la fusión con '$CLIMIER_DEPLOY_BASE' cambia '$CLIMIER_DEPLOY_UI/'; resolvelo a mano" >&2; exit 1; }
fi

# ── 2. Estado remoto ─────────────────────────────────────────────────────────
REMOTE_BRANCH=$(ssh_remote "git -C '$REMOTE_PATH' rev-parse --abbrev-ref HEAD")
[[ "$REMOTE_BRANCH" == "$CLIMIER_DEPLOY_BRANCH" ]] || { echo "deploy: el checkout remoto está en '$REMOTE_BRANCH', no en '$CLIMIER_DEPLOY_BRANCH'" >&2; exit 1; }
[[ -z $(ssh_remote "git -C '$REMOTE_PATH' status --porcelain") ]] || { echo "deploy: el checkout remoto tiene cambios sin commitear" >&2; exit 1; }
REMOTE_SHA=$(ssh_remote "git -C '$REMOTE_PATH' rev-parse HEAD")
SERVICE_STATE=$(ssh_remote "systemctl is-active '$CLIMIER_DEPLOY_SERVICE'" || true)

if [[ "$CHECK" == 1 ]]; then
  echo "local HEAD   : $SHA"
  echo "local deploy : ${DEPLOY_SHA:-merge pendiente}"
  echo "remote HEAD  : $REMOTE_SHA"
  echo "service      : $SERVICE_STATE"
  [[ "$PENDING" == 0 && "$DEPLOY_SHA" == "$REMOTE_SHA" && "$SERVICE_STATE" == "active" ]] || { echo "deploy: hay drift" >&2; exit 1; }
  echo "deploy: nivelado"
  exit 0
fi

if [[ "$PENDING" == 1 ]]; then
  DEPLOY_SHA=$(git commit-tree "$TREE" -p "$CLIMIER_DEPLOY_BRANCH" -p "$SHA" -m "Deploy $SHA")
  git branch -f "$CLIMIER_DEPLOY_BRANCH" "$DEPLOY_SHA"
fi

# ── 3. Build local del bundle ────────────────────────────────────────────────
echo "== build $CLIMIER_DEPLOY_UI/dist"
( cd "$CLIMIER_DEPLOY_UI" && bun install --frozen-lockfile && bun run typecheck && bun run build )
DIST="$CLIMIER_DEPLOY_UI/dist"
ASSET=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$DIST/index.html" | head -1)
[[ -n "$ASSET" ]] || { echo "deploy: no encontré el asset JS en $DIST/index.html" >&2; exit 1; }
LOCAL_ASSET_SHA=$(sha256sum "$DIST/$ASSET" | awk '{print $1}')

# ── 4. Commit al host y ff en la rama de deploy ──────────────────────────────
TMP_BRANCH="sync/deploy-$$"
ssh_remote "git -C '$REMOTE_PATH' branch -D '$TMP_BRANCH'" >/dev/null 2>&1 || true
echo "== push $DEPLOY_SHA → $HOST:$REMOTE_PATH ($TMP_BRANCH)"
git push --quiet "$CLIMIER_DEPLOY_REMOTE" "+$DEPLOY_SHA:refs/heads/$TMP_BRANCH"
ssh_remote "set -e; git -C '$REMOTE_PATH' merge --ff-only '$TMP_BRANCH'; git -C '$REMOTE_PATH' branch -D '$TMP_BRANCH'"

# ── 5. Copia del bundle construido (swap dentro de ui/) ──────────────────────
echo "== copia $DIST"
tar czf - -C "$CLIMIER_DEPLOY_UI" dist | ssh_remote "set -e; cd '$REMOTE_PATH/$CLIMIER_DEPLOY_UI' && rm -rf .dist-incoming && mkdir .dist-incoming && tar xzf - -C .dist-incoming --strip-components=1 && rm -rf dist.old && { [ -d dist ] && mv dist dist.old || true; } && mv .dist-incoming dist && rm -rf dist.old"

# ── 6. Reinicio y verificación ───────────────────────────────────────────────
echo "== restart $CLIMIER_DEPLOY_SERVICE"
ssh_remote "sudo systemctl restart '$CLIMIER_DEPLOY_SERVICE'"
sleep 2
ssh_remote "systemctl is-active --quiet '$CLIMIER_DEPLOY_SERVICE'" || { echo "deploy: el servicio no quedó activo" >&2; exit 1; }

if [[ -n "$CLIMIER_DEPLOY_URL" ]]; then
  ssh_remote "curl -fsS '$CLIMIER_DEPLOY_URL/' | grep -q '$ASSET'" || { echo "deploy: el index servido no referencia $ASSET" >&2; exit 1; }
  SERVED_ASSET_SHA=$(ssh_remote "curl -fsS '$CLIMIER_DEPLOY_URL/$ASSET'" | sha256sum | awk '{print $1}')
  [[ "$SERVED_ASSET_SHA" == "$LOCAL_ASSET_SHA" ]] || { echo "deploy: el asset servido no coincide con el construido" >&2; exit 1; }
fi

echo "deploy: OK → $DEPLOY_SHA ($ASSET) en $HOST, $CLIMIER_DEPLOY_SERVICE activo"
