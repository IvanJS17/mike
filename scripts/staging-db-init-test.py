#!/usr/bin/env python3
"""Opt-in fresh-bootstrap integration gate; synthetic, portless, no egress.

Run: python scripts/staging-db-init-test.py --runtime
Does not prove full staging, supported upgrade, or backup/restore.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'postgres:16'


def command(args, *, data=None, timeout=30, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True,
                            timeout=timeout, check=False)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr[-1200:]}')
    return result


def run():
    owner = str(uuid.uuid4())
    name = f'litt-bootstrap-{owner}'
    label = f'com.litt.bootstrap-test={owner}'
    workspace = Path(tempfile.mkdtemp(prefix=f'litt-bootstrap-{owner}-'))
    container = None
    receipt = {'owner': owner, 'checks': [], 'status': 'FAIL', 'cleanup': False}
    try:
        # Pin an already installed image; never pull or use credentials.
        image = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE]).stdout.strip()
        schema = (ROOT / 'backend/schema.sql').read_text()
        (workspace / 'schema.sql').write_text(schema)
        shutil.copyfile(ROOT / 'scripts/staging-db-init.sh', workspace / 'db-init.sh')
        # Debian postgres is root at entry then drops privilege via its entrypoint.
        # No container port/network, persistent volume, privileged mode or host socket.
        container = command(['docker', 'create', '--name', name, '--label', label,
            '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,size=536870912',
            '--mount', f'type=bind,src={workspace},dst=/staging,readonly',
            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]).stdout.strip()
        command(['docker', 'start', container])
        deadline = time.monotonic() + 60
        while True:
            ready = command(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'], check=False)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('owned database readiness timeout')
            time.sleep(0.5)

        def sql(database, text):
            return command(['docker', 'exec', '-i', container, 'psql', '-XAtq', '-U',
                            'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], data=text).stdout.strip()

        def bootstrap(database):
            return command(['docker', 'exec', '-e', 'PGUSER=postgres', '-e', f'PGDATABASE={database}',
                            container, 'bash', '/staging/db-init.sh', 'fresh'], timeout=140, check=False)

        sql('postgres', """
create role anon nologin; create role authenticated nologin;
create role service_role nologin bypassrls; create role supabase_auth_admin nologin;
create database fresh; create database nonempty; create database broken;
""")
        auth = """
create schema auth; create table auth.users(id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as
$$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
"""
        for database in ['fresh', 'nonempty', 'broken']:
            sql(database, auth)
        result = bootstrap('fresh')
        assert result.returncode == 0, result.stderr[-1200:]
        assert sql('fresh', 'select schema_sha256 from recovery_staging.bootstrap') == hashlib.sha256(schema.encode()).hexdigest()
        receipt['checks'].append('fresh canonical schema and source receipt')

        def dump_public():
            dump = command(['docker', 'exec', container, 'pg_dump', '-U', 'postgres', '-d',
                            'fresh', '--schema-only', '--schema=public']).stdout
            # pg_dump random psql guard keys are not schema content.
            return '\n'.join(line for line in dump.splitlines()
                             if not line.startswith(('\\restrict ', '\\unrestrict ')))

        before = dump_public()
        assert bootstrap('fresh').returncode == 0
        assert dump_public() == before
        receipt['checks'].append('idempotent replay preserves complete public DDL/ACL dump')
        for role in ['anon', 'authenticated', 'service_role']:
            assert sql('fresh', f"select has_schema_privilege('{role}','recovery_staging','USAGE')") == 'f'
        receipt['checks'].append('bootstrap receipt inaccessible to application roles')
        (workspace / 'schema.sql').write_text(schema + '\n-- changed source\n')
        assert bootstrap('fresh').returncode != 0
        assert dump_public() == before
        receipt['checks'].append('source drift rejected without schema changes')
        (workspace / 'schema.sql').write_text(schema)
        sql('nonempty', 'create table public.sentinel(id integer); insert into sentinel values(7);')
        assert bootstrap('nonempty').returncode != 0
        assert sql('nonempty', 'select id from sentinel') == '7'
        assert sql('nonempty', "select to_regclass('recovery_staging.bootstrap') is null") == 't'
        receipt['checks'].append('nonempty DB rejected and original data preserved')
        (workspace / 'schema.sql').write_text('create table public.partial(id integer);\nselect invalid_bootstrap_call();\n')
        assert bootstrap('broken').returncode != 0
        assert sql('broken', "select to_regclass('public.partial') is null and to_regclass('recovery_staging.bootstrap') is null") == 't'
        receipt['checks'].append('partial DDL and receipt roll back together')
        (workspace / 'schema.sql').write_text(schema)
        for database, definition, probe in [
            ('function_only',
             'create function public.sentinel() returns integer language sql as $$select 71$$;',
             "select pg_get_functiondef('public.sentinel()'::regprocedure)"),
            ('type_only', "create type public.sentinel as enum ('preserved');",
             "select enumlabel from pg_enum where enumtypid='public.sentinel'::regtype"),
        ]:
            sql('postgres', f'create database {database}')
            sql(database, auth)
            sql(database, definition)
            original = sql(database, probe)
            assert bootstrap(database).returncode != 0, f'{database} accepted as empty'
            assert sql(database, probe) == original, f'{database} sentinel changed'
            assert sql(database, "select to_regclass('recovery_staging.bootstrap') is null") == 't'
            receipt['checks'].append(f'{database} rejected with unchanged sentinel and no receipt')
        # Reproduce image-owned per-schema ACLs before the canonical fresh path.
        shutil.copyfile(ROOT / 'scripts/staging-db-roles.sh', workspace / 'roles.sh')
        sql('postgres', 'create role supabase_admin superuser login; create role authenticator login; create database image_acl;')
        sql('image_acl', auth)
        sql('image_acl', '''
        alter default privileges for role postgres in schema public grant all on tables to anon;
        alter default privileges for role supabase_admin in schema public grant all on functions to authenticated;
        ''')
        roles_env = workspace / 'roles.env'
        roles_env.write_text('POSTGRES_PASSWORD=' + uuid.uuid4().hex + '\n')
        roles_env.chmod(0o600)
        def image_roles(database):
            return command(['docker', 'exec', '-e', f'POSTGRES_DB={database}',
                            '--env-file', str(roles_env), container,
                            'bash', '/staging/roles.sh'], check=False)
        assert image_roles('image_acl').returncode == 0
        assert sql('image_acl', "select count(*) from pg_default_acl where defaclnamespace='public'::regnamespace") == '0', 'image default ACLs remain before canonical bootstrap'
        assert bootstrap('image_acl').returncode == 0
        receipt['checks'].append('image public default ACL preparation allows canonical bootstrap')
        sql('nonempty', 'alter default privileges for role postgres in schema public grant all on tables to anon;')
        original_acl = sql('nonempty', 'select defaclacl::text from pg_default_acl order by oid')
        assert image_roles('nonempty').returncode != 0
        assert sql('nonempty', 'select id from sentinel') == '7'
        assert sql('nonempty', 'select defaclacl::text from pg_default_acl order by oid') == original_acl
        receipt['checks'].append('image preparation rejects populated database without changing ACLs')
        receipt['status'] = 'PASS'
    except Exception as error:
        receipt['error'] = str(error)
    finally:
        try:
            # Creation may time out after the daemon allocated the object; recover only our label.
            ids = command(['docker', 'ps', '-aq', '--filter', f'label={label}']).stdout.split()
            for owned in ids:
                command(['docker', 'rm', '-f', owned], timeout=90)
            assert not command(['docker', 'ps', '-aq', '--filter', f'label={label}']).stdout.strip()
            assert not command(['docker', 'volume', 'ls', '-q', '--filter', f'label={label}']).stdout.strip()
            assert not command(['docker', 'network', 'ls', '-q', '--filter', f'label={label}']).stdout.strip()
            shutil.rmtree(workspace)
            assert not workspace.exists()
            receipt['cleanup'] = True
        except Exception as error:
            receipt['status'] = 'FAIL'
            receipt['cleanup_error'] = str(error)
            receipt['owned_workspace'] = str(workspace)
        print(json.dumps(receipt))
    return 0 if receipt['status'] == 'PASS' and receipt['cleanup'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', action='store_true', required=True)
    parser.parse_args()
    raise SystemExit(run())
