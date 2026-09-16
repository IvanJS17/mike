#!/bin/bash
# Respaldo diario de LiTT (patrón de la casa: restic por app → Hetzner).
# Instalar en /usr/local/sbin/litt-backup.sh (700 root) y agendar en cron 3:30.
# Los DOCUMENTOS viven en Cloudflare R2 (fuera de este respaldo, por diseño:
# la política del producto es borrado definitivo sin retención oculta).
set -Eeuo pipefail

APP_DIR=/srv/litt
RESTIC_ENV=/etc/litt-restic.env
COMPOSE=(docker compose --env-file "$APP_DIR/.env" -f "$APP_DIR/deploy/prod/compose.yaml")

if [ ! -f "$RESTIC_ENV" ] || [ -L "$RESTIC_ENV" ]; then
  echo "restic environment must exist as a regular file" >&2
  exit 1
fi

# Los secretos sólo entran al respaldo si no son legibles por terceros: modo 600
# (sin permisos para grupo ni otros) y dueño confiable — root, el usuario que
# ejecuta el cron o el usuario dueño de APP_DIR.
trusted_secret_owner() {
  local owner mode app_owner
  owner=$(stat -c '%U' "$1")
  mode=$(stat -c '%a' "$1")
  app_owner=$(stat -c '%U' "$APP_DIR")
  [ "$mode" = "600" ] || return 1
  [ "$owner" = "root" ] || [ "$owner" = "$(id -un)" ] || [ "$owner" = "$app_owner" ]
}
for f in "$APP_DIR/.env" "$RESTIC_ENV"; do
  trusted_secret_owner "$f" || {
    echo "secreto legible por terceros o con dueño no confiable, no se respalda: $f ($(stat -c '%a:%U:%G' "$f"))" >&2
    exit 1
  }
done

set -a; source "$RESTIC_ENV"; set +a
: "${RESTIC_REPOSITORY:?required}" "${AWS_ACCESS_KEY_ID:?required}" "${AWS_SECRET_ACCESS_KEY:?required}" "${RESTIC_PASSWORD_FILE:?required}"

mkdir -p "$APP_DIR/backups"
# Dump consistente del estado legal completo (base de datos).
"${COMPOSE[@]}" exec -T db pg_dump -U supabase_admin -d postgres -Fc > "$APP_DIR/backups/db.dump"

restic backup "$APP_DIR/backups" "$APP_DIR/.env"
# Integridad: metadatos a diario; el día 01, además, una porción real de datos.
if [ "$(date +%d)" = "01" ]; then
  restic check --read-data-subset=10%
else
  restic check
fi
restic forget --keep-daily 30 --keep-weekly 8 --keep-monthly 12 --prune
