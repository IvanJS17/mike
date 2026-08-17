#!/usr/bin/env bash
# Write a non-secret inventory for the exact release deployed by Compose.
set -Eeuo pipefail
umask 077

: "${RELEASE_MANIFEST_PATH:?set RELEASE_MANIFEST_PATH to the encrypted config path}"
: "${RELEASE_SHA:?set RELEASE_SHA to the reviewed Git commit}"
: "${SOURCE_OFFER_URL:?set SOURCE_OFFER_URL to the public AGPL source offer}"
: "${CADDYFILE_PATH:?set CADDYFILE_PATH to the reviewed Caddyfile}"
: "${LITT_BACKEND_IMAGE:?set LITT_BACKEND_IMAGE to a digest reference}"
: "${LITT_FRONTEND_IMAGE:?set LITT_FRONTEND_IMAGE to a digest reference}"
: "${LITT_CADDY_IMAGE:?set LITT_CADDY_IMAGE to a digest reference}"
: "${LITT_DB_IMAGE:?set LITT_DB_IMAGE to a digest reference}"
: "${LITT_AUTH_IMAGE:?set LITT_AUTH_IMAGE to a digest reference}"
: "${LITT_REST_IMAGE:?set LITT_REST_IMAGE to a digest reference}"
: "${MIGRATION_VERSION:?set MIGRATION_VERSION to the applied migration version}"
: "${OPENTOFU_VERSION:?set OPENTOFU_VERSION to the reviewed OpenTofu version}"

for image in "$LITT_BACKEND_IMAGE" "$LITT_FRONTEND_IMAGE" "$LITT_CADDY_IMAGE" "$LITT_DB_IMAGE" "$LITT_AUTH_IMAGE" "$LITT_REST_IMAGE"; do
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { printf 'Mutable image reference rejected.\n' >&2; exit 1; }
done
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { printf 'Release SHA must be a full commit.\n' >&2; exit 1; }
[[ "$SOURCE_OFFER_URL" == *"$RELEASE_SHA"* ]] || { printf 'Source offer must point at RELEASE_SHA.\n' >&2; exit 1; }
[[ -f "$CADDYFILE_PATH" && ! -L "$CADDYFILE_PATH" ]] || { printf 'Caddyfile must be a regular file.\n' >&2; exit 1; }
caddy_config_sha256=$(sha256sum "$CADDYFILE_PATH" | cut -d' ' -f1)
mkdir -p "$(dirname "$RELEASE_MANIFEST_PATH")"
jq -n \
  --arg application "litt" \
  --arg release_sha "$RELEASE_SHA" \
  --arg source_offer "$SOURCE_OFFER_URL" \
  --arg backend "$LITT_BACKEND_IMAGE" \
  --arg frontend "$LITT_FRONTEND_IMAGE" \
  --arg caddy "$LITT_CADDY_IMAGE" \
  --arg db "$LITT_DB_IMAGE" \
  --arg auth "$LITT_AUTH_IMAGE" \
  --arg rest "$LITT_REST_IMAGE" \
  --arg migration "$MIGRATION_VERSION" \
  --arg opentofu "$OPENTOFU_VERSION" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg caddy_config_sha256 "$caddy_config_sha256" \
  '{application:$application,license:"AGPL-3.0-only",release_sha:$release_sha,source_offer:$source_offer,caddy_config_sha256:$caddy_config_sha256,images:{backend:$backend,frontend:$frontend,caddy:$caddy,postgres:$db,auth:$auth,rest:$rest},migration_version:$migration,opentofu_version:$opentofu,generated_at:$generated_at}' \
  >"$RELEASE_MANIFEST_PATH"
chmod 0600 "$RELEASE_MANIFEST_PATH"
