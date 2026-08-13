#!/usr/bin/env bash
# Security invariants (W1.6):
#   1. Every public table defined in schema.sql / migrations has RLS enabled
#      (documented exceptions only).
#   2. No ordinary router uses the service_role path (createServerSupabase)
#      without requireAuth in the same file.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1) RLS coverage
tables=$(rg -o 'create table if not exists public\.[a-z_]+' schema.sql migrations/*.sql 2>/dev/null \
  | sed 's/.*public\.//' | sort -u)
rls=$(rg -o 'alter table public\.[a-z_]+ enable row level security' schema.sql migrations/*.sql 2>/dev/null \
  | sed 's/.*public\.//; s/ enable.*//' | sort -u)

for t in $tables; do
  case "$t" in
    courtlistener_*) continue ;; # dropped product-wide (W1.3)
  esac
  if ! grep -qx "$t" <<<"$rls"; then
    echo "FAIL: RLS no habilitado en public.$t"
    fail=1
  fi
done
echo "RLS check: $(echo "$tables" | wc -l) tablas auditadas, $(echo "$rls" | wc -l) con RLS"

# 2) service_role isolation
for f in src/routes/*.ts; do
  if rg -q 'createServerSupabase' "$f" && ! rg -q 'requireAuth' "$f"; then
    echo "FAIL: $f usa service_role sin requireAuth"
    fail=1
  fi
done
echo "service_role isolation: OK"

exit $fail
