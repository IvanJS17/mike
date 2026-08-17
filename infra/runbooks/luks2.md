# LUKS2 data volume runbook

This procedure protects PostgreSQL, Caddy state, secrets, and recovery
scratch space from being silently created on the unencrypted root filesystem.
It is intentionally manual: the passphrase is entered by the approved operator
and the recovery material remains under Socium custody.

## One-time initialization on an approved disposable host

1. Confirm the Hetzner volume device from the OpenTofu output and compare it
   with `lsblk -f`, `findmnt /`, and the provider attachment receipt. Never use
   `/dev/vda`, the root device, or a guessed device path.
2. Set only non-secret variables in the operator shell:

   ```bash
   export LITT_DATA_DEVICE=/dev/disk/by-id/<verified-volume>
   export LITT_CRYPT_MAPPER=litt-data
   export LITT_DATA_ROOT=/srv/litt-data
   export LUKS2_CONFIRM=YES
   ```

3. Run `sudo -E scripts/storage/format-luks2.sh`. `cryptsetup` prompts for the
   passphrase twice; do not put it in an environment variable, command line,
   file, or chat. Save the LUKS header backup and passphrase separately under
   Socium custody. The script refuses the root device and refuses a non-LUKS
   mapper collision.
4. Create the five mode-0700 directories shown by the script. Secret files
   under `/srv/litt-data/secrets` must also be mode 0600 and live on this encrypted
   volume.

The script deliberately performs no OpenTofu action and creates no provider
resource.

## Reboot/unlock procedure

After every reboot, before production Compose:

```bash
export LITT_DATA_DEVICE=/dev/disk/by-id/<verified-volume>
export LITT_CRYPT_MAPPER=litt-data
export LITT_DATA_ROOT=/srv/litt-data
sudo -E scripts/storage/unlock-luks2.sh
sudo -E scripts/storage/verify-encrypted-mount.sh
```

The service must not start if `findmnt` reports the root filesystem, an empty
path, or any source other than `/dev/mapper/litt-data`. `scripts/production-up.sh`
will repeat this guard before `docker compose -f compose.prod.yml up -d`.

## Shutdown/maintenance

Set `COMPOSE_FILE=compose.prod.yml` and run the lock script only during an
approved maintenance window:

```bash
export COMPOSE_FILE=compose.prod.yml
export LUKS2_CONFIRM=YES
sudo -E scripts/storage/lock-luks2.sh
```

The script stops the production project, unmounts the volume, and closes the
mapper. It refuses the local `docker-compose.yml`. Never run `docker compose
 down -v`: that may remove data volumes and is not part of this procedure.

## Proof required before Gate B

On a disposable host, record timestamps and command output for: `lsblk -f`,
`cryptsetup luksDump` (metadata only), `findmnt`, a reboot, the unlock command,
`docker compose ... ps`, and the readiness probe. The receipt must prove that
Compose remains stopped before unlock and that PostgreSQL/secret/temp paths are
inside the LUKS mount. Do not include passphrases, key material, or full secret
environment files in the receipt.
