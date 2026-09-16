# LiTT — despliegue de producción (`litt.asteroitt.com.mx`)

Paquete operativo del despliegue al VPS compartido `staging-apps-dev`. Sigue el
patrón de la casa: la app vive en `/srv/litt` con su propio compose (`name: litt`),
**ningún puerto se publica al host**, el borde 80/443 lo sirve el Caddy compartido
(de `escrituralab`) con un bloque dedicado, y el respaldo es restic por app.
Los documentos viven en **Cloudflare R2** (externo); no hay object storage local.

## Piezas

| Archivo | Rol |
|---|---|
| `compose.yaml` | Stack completo (db, auth, rest, db-init, gateway, backend, frontend) |
| `gateway.conf` | Fachada interna de Supabase (gotrue+postgrest) para el backend |
| `Caddyfile.litt` | Bloque del dominio para el Caddy compartido (marcadores `# BEGIN/END litt`) |
| `.env.example` | Contrato de variables (copiar a `/srv/litt/.env`, 600) |
| `supabase-jwt.py` | Generador de las llaves JWT `anon` / `service_role` |
| `litt-backup.sh` | Respaldo diario (pg_dump + restic; sin documentos, por diseño) |

## Requisitos previos (una vez)

- [ ] Bucket R2 en Cloudflare (`litt-docs`) + credenciales S3 + reglas CORS
      para `https://litt.asteroitt.com.mx` (PUT/GET de las URLs firmadas).
- [ ] Registro DNS `A litt` → `78.47.184.224` (Cloudflare; mismo modo que
      `contextlexmx`).
- [ ] Imágenes del release construidas y verificadas (IDs exactos abajo).

## 1. Imágenes (máquina de build → VPS)

```bash
docker tag sha256:f99301dc34bfd657cef486e7cd79b61dc0afa2912762c2fa67885ef10733578a litt-backend:<RELEASE>
docker tag sha256:bbfb690842d78a8b45ffcf493c67b1dff7db927ce9d482a9fd1260ba5eb8bda2 litt-frontend:<RELEASE>
docker save litt-backend:<RELEASE>  | gzip > /tmp/litt-backend.tgz
docker save litt-frontend:<RELEASE> | gzip > /tmp/litt-frontend.tgz
scp /tmp/litt-*.tgz staging-apps-dev:/tmp/
# En el VPS:
gzip -dc /tmp/litt-backend.tgz  | docker load
gzip -dc /tmp/litt-frontend.tgz | docker load
docker image inspect --format '{{.Id}}' litt-backend:<RELEASE>   # == f99301dc…
docker image inspect --format '{{.Id}}' litt-frontend:<RELEASE>  # == bbfb6908…
```

`<RELEASE>` = sha corto del commit de `main` desplegado (queda en `.env` como
`LITT_RELEASE`). Las imágenes son las verificadas en las corridas G5; el deploy
NO compila en el VPS.

**Procedencia de las imágenes (registro):** los IDs `f99301dc…`/`bbfb6908…`
provienen de los builds S7 sobre `951c834f`; el **runtime** de la app es
byte-idéntico entre `951c834f` y este `<RELEASE>` (lo único distinto en el
árbol es el arnés `backend/scripts/recovery-beta-server.cjs`, que no forma
parte del runtime). La verificación de IDs tras `docker load` (comando arriba)
es la que ata el deploy a los bytes probados.

## 2. Árbol del release (VPS)

```bash
# En la máquina de build (repo mike):
git archive --format=tar.gz -o /tmp/litt.tar.gz <SHA-de-main> && scp /tmp/litt.tar.gz staging-apps-dev:/tmp/
# En el VPS (owner ivan, como /srv/contextlex-mx):
sudo -n mkdir -p /srv/litt && sudo -n chown ivan:ivan /srv/litt
cd /srv/litt && tar -xzf /tmp/litt.tar.gz
```

## 3. Secretos (`/srv/litt/.env`, 600)

```bash
cp deploy/prod/.env.example /srv/litt/.env && chmod 600 /srv/litt/.env
# POSTGRES_PASSWORD, JWT_SECRET, DOWNLOAD_SIGNING_SECRET, USER_API_KEYS_ENCRYPTION_SECRET:
openssl rand -hex 32
# Llaves de Supabase:
JWT_SECRET=<el de arriba> python3 deploy/prod/supabase-jwt.py anon
JWT_SECRET=<el de arriba> python3 deploy/prod/supabase-jwt.py service_role
# R2: endpoint + access + secret + bucket del bucket dedicado.
```
Nunca imprimir el contenido del `.env`.

## 4. Primer arranque

```bash
cd /srv/litt
C="docker compose --env-file .env -f deploy/prod/compose.yaml"
$C up -d db auth rest gateway        # base + auth (el init de postgres tarda ~2-5 min)
$C up db-init                        # esquema + roles (one-shot "fresh")
$C up -d                             # backend + frontend
$C ps                                # todo healthy
```

## 5. Caddy compartido (quirúrgico)

```bash
sudo -n cp /srv/escrituralab/deploy/Caddyfile /srv/escrituralab/deploy/Caddyfile.bak-$(date +%F-%H%M)
# Insertar el contenido de deploy/prod/Caddyfile.litt (solo entre sus marcadores).
sudo -n docker exec escrituralab-caddy-1 caddy validate --config /etc/caddy/Caddyfile
sudo -n docker exec escrituralab-caddy-1 caddy reload  --config /etc/caddy/Caddyfile
```

## 6. DNS

Registro `A litt` → `78.47.184.224` en Cloudflare (igual que `contextlexmx`).
Verificar propagación con DoH (`cloudflare-dns.com/dns-query`); el certificado
ACME lo emite Caddy solo cuando el DNS resuelve.

## 7. Respaldo (patrón de la casa)

1. Crear el bucket `litt-backups` en Hetzner Object Storage y la password en la
   máquina de build (600): `/home/ijs/.secrets/restic-litt-password`.
   **Escrutinio (escrow):** esa password debe existir también fuera del VPS —
   sin ella, ni el respaldo ni los secretos cifrados son recuperables.
2. En el VPS: transferir la password por canal seguro e instalarla en
   `/etc/litt-restic-password` (`sudo install -m 600 -o root -g root`; nunca
   imprimirla). Crear `/etc/litt-restic.env` (600 root:root) con
   `RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/litt-backups`,
   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` y
   `RESTIC_PASSWORD_FILE=/etc/litt-restic-password`.
3. `install -m 700 -o root -g root deploy/prod/litt-backup.sh /usr/local/sbin/litt-backup.sh`
   + `sha256sum` comparado en ambos lados.
4. Cron (root, sin pisar): `30 3 * * * /usr/local/sbin/litt-backup.sh >> /var/log/litt-backup.log 2>&1`
5. Correrlo una vez y **probar la restauración con profundidad**:
   `restic restore latest --target /tmp/litt-restore` →
   `pg_restore --list /tmp/litt-restore/srv/litt/backups/db.dump` (dump legible) →
   carga en una base temporal aislada (`createdb` + `pg_restore` + conteos
   mínimos dentro del contenedor `db`) → borrar la base temporal.
   El script verifica los secretos fail-closed (regulares, modo 600, dueño
   confiable) e integridad (`restic check` diario; `--read-data-subset=10%` el
   día 01).

## 8. Verificación final (con Iván en el navegador)

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://litt.asteroitt.com.mx          # 200 (login)
curl -s -o /dev/null -w '%{http_code}\n' https://litt.asteroitt.com.mx/api/health
```
Luego: abrir en el navegador, crear la cuenta del owner, dar de alta la llave
de IA (Ajustes) y subir un documento de prueba.

## Decisiones y pendientes conocidos

- **Drive (Google): NO activado** — la publicación a Drive no tiene conector
  real todavía. Verificado en este mismo PR: no existen enlaces visibles hacia
  las páginas de Drive (solo accesibles por URL manual) y el backend responde
  `drivePublicationUnavailable` de forma fail-closed. El workstream del conector
  real (self-serve) reescribirá esas páginas cuando se apruebe.
- **Signup abierto + autoconfirmación** (aún sin SMTP): cerrar
  (`DISABLE_SIGNUP=true`) cuando todo el equipo tenga cuenta. SMTP (correos
  del sistema) pospuesto.
- **Login con Google**: deshabilitado (requiere credenciales de sistema).
- **Documentos en R2**: el respaldo NO los incluye (política de borrado
  definitivo sin retención oculta); R2 es el almacén durable.
- **Upgrades de la base**: el flujo soportado es `recovery-upgrade`
  (documentar caso de uso en el primer upgrade real; este paquete instala
  `fresh`). El init reutilizado es replay-safe por recibo
  (`recovery_staging.bootstrap` — nombre cosmético en producción): no-op en
  replay con el mismo sha256 y error explícito si el esquema difiere.
- **SMTP futuro**: cuando se habilite el correo, el servicio `auth` necesitará
  egreso (añadirlo a la red `egress` del compose); hoy no lo requiere.
