# Production runtime contract

`compose.prod.yml` is intentionally separate from `docker-compose.yml`. The
local stack keeps Supabase gateway, RustFS, Mailpit, and debugging ports; production does not.

## Required topology

- Caddy is the only service publishing host ports: 80 and 443.
- Frontend, backend, Postgres, GoTrue, and PostgREST share the Compose network
  but publish no host port.
- Object storage is an external private S3-compatible bucket. There is no
  storage container in production.
- Caddy provides the public same-origin routes:
  `/api/*`, `/supabase/auth/v1/*`, and `/supabase/rest/v1/*`.
- PostgreSQL, secret files, Caddy state, and temporary recovery material live
  below the LUKS2 mount at `LITT_DATA_ROOT`.
- Secrets are separate mode-0600 files below `LITT_SECRETS_ROOT`; they are not
  copied into images and are excluded from Docker build contexts.

## Image rule

Every `LITT_*_IMAGE` must be the exact digest emitted by the CI image workflow:

```text
registry.example/name@sha256:<64 lowercase hexadecimal characters>
```

A mutable tag, `latest`, local build, or unverified digest is not a production
release. Save the CI image-lock artifact beside the deployment receipt and put
the same references into the encrypted Compose interpolation file.

## Secret files

Create these files outside Git, then set mode 600:

- `db.env`: `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `SUPABASE_AUTH_PASSWORD`, `POSTGREST_AUTHENTICATOR_PASSWORD`.
- `auth.env`: GoTrue database URL, JWT secret, public site/API URL, invitation-
  only setting, and approved SMTP settings.
- `rest.env`: PostgREST database URL, schemas, anonymous role, and JWT secret.
- `backend.env`: `SUPABASE_URL=http://caddy/supabase`, service-role key,
  `FRONTEND_URL`, R2 endpoint/bucket credentials, the SSE-C customer key, and
  application encryption/signing secrets.

Do not put a secret in `compose.prod.yml`, `Caddyfile`, an image, GitHub logs,
or a chat message. Rotate the three database role passwords together using the
runbook; do not edit a running container by hand.

## Operator gates

1. Verify the LUKS2 mount and permissions before starting Compose.
2. Generate the mode-600 release manifest from the exact clean HEAD, image lock,
   Caddyfile hash, and migration tree; verify it before startup.
3. Verify the image lock and `docker compose ... config` before `up -d`.
4. Run the migration rehearsal and create a recovery set before a migration.
5. Start only with `scripts/production-up.sh` after the host firewall and VPN
   are verified.
6. Check `/api/ready` and the external alert targets.
7. Record the migration result and permission review.

No command in this directory creates a Hetzner server, changes DNS, uploads a
secret, or applies OpenTofu automatically.
