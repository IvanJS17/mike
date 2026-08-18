#!/usr/bin/env bash
# Reap resources left by an interrupted disposable WS2 run.
set -Eeuo pipefail
umask 077
: "${REAPER_APPROVAL:?set REAPER_APPROVAL=YES}"
: "${REAPER_TARGET_KIND:?set REAPER_TARGET_KIND=load|restore|migration}"
: "${REAPER_TARGET_ID:?set REAPER_TARGET_ID to the versioned disposable target}"
: "${REAPER_DOCKER_CONTEXT:?set REAPER_DOCKER_CONTEXT to the versioned disposable context}"
: "${REAPER_PROJECT:?set REAPER_PROJECT to the versioned disposable project}"
: "${REAPER_COMPOSE_ENV_FILE:?set REAPER_COMPOSE_ENV_FILE to the mode-600 disposable env file}"
: "${LITT_APP_ROOT:?set LITT_APP_ROOT to the reviewed checkout}"
[[ "$REAPER_APPROVAL" == YES ]] || { printf 'Explicit disposable reaper approval is required.\n' >&2; exit 2; }
root=$(realpath -e "$LITT_APP_ROOT")
manifest="$root/infra/production/disposable-targets.json"
case "$REAPER_TARGET_KIND" in
  load) jq -e --arg id "$REAPER_TARGET_ID" --arg context "$REAPER_DOCKER_CONTEXT" --arg project "$REAPER_PROJECT" '(.load.target_id == $id) and (.load.docker_context == $context) and (.load.project == $project)' "$manifest" >/dev/null ;;
  restore) jq -e --arg id "$REAPER_TARGET_ID" --arg context "$REAPER_DOCKER_CONTEXT" --arg project "$REAPER_PROJECT" '(.restore.target_id == $id) and (.restore.docker_context == $context) and (.restore.project == $project)' "$manifest" >/dev/null ;;
  migration) jq -e --arg id "$REAPER_TARGET_ID" --arg context "$REAPER_DOCKER_CONTEXT" --arg project "$REAPER_PROJECT" '(.migration.target_id == $id) and (.migration.docker_context == $context) and (.migration.project == $project)' "$manifest" >/dev/null ;;
  *) printf 'Unknown disposable reaper target kind.\n' >&2; exit 1 ;;
esac
[[ "$REAPER_DOCKER_CONTEXT" != *production* && "$REAPER_DOCKER_CONTEXT" != *local* && "$REAPER_PROJECT" != *production* ]] || { printf 'Reaper target resembles production/local.\n' >&2; exit 1; }
[[ "$(docker context show)" == "$REAPER_DOCKER_CONTEXT" ]] || { printf 'Current Docker context is not the approved disposable context.\n' >&2; exit 1; }
[[ "$(realpath -e "$REAPER_COMPOSE_ENV_FILE")" == /srv/*/secrets/compose.env && "$(stat -c '%a' "$REAPER_COMPOSE_ENV_FILE")" == "600" ]] || { printf 'Reaper env is not an approved mode-600 disposable file.\n' >&2; exit 1; }
docker_prefix=(docker --context "$REAPER_DOCKER_CONTEXT")
compose=("${docker_prefix[@]}" compose --env-file "$REAPER_COMPOSE_ENV_FILE" -f "$root/compose.prod.yml" -p "$REAPER_PROJECT")
"${compose[@]}" down --remove-orphans >/dev/null
volumes=$("${docker_prefix[@]}" volume ls -q --filter "label=com.docker.compose.project=$REAPER_PROJECT")
[[ -z "$volumes" ]] || "${docker_prefix[@]}" volume rm $volumes >/dev/null
networks=$("${docker_prefix[@]}" network ls -q --filter "label=com.docker.compose.project=$REAPER_PROJECT")
[[ -z "$networks" ]] || "${docker_prefix[@]}" network rm $networks >/dev/null
[[ -z "$("${docker_prefix[@]}" ps -aq --filter "label=com.docker.compose.project=$REAPER_PROJECT")" ]] || { printf 'Disposable containers remain after reaper.\n' >&2; exit 1; }
[[ -z "$("${docker_prefix[@]}" volume ls -q --filter "label=com.docker.compose.project=$REAPER_PROJECT")" && -z "$("${docker_prefix[@]}" network ls -q --filter "label=com.docker.compose.project=$REAPER_PROJECT")" ]] || { printf 'Disposable volumes/networks remain after reaper.\n' >&2; exit 1; }
printf 'Disposable target %s/%s reaped with no Compose residue.\n' "$REAPER_TARGET_KIND" "$REAPER_PROJECT"
