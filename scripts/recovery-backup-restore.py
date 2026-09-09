#!/usr/bin/env python3
"""Bounded, local synthetic paired recovery foundation (stdlib, POSIX main thread).

Default --contract-only does not contact Docker. --runtime requires existing exact
image IDs for backend/frontend/db/auth/rest/proxy/storage/storage-init, and an
output directory outside this checkout. No pulls, remote endpoints or retries of
uploads. Both stacks and ALL backup temporaries are destroyed even on failure.
The coordinator owns first runtime execution; offline tests are not runtime proof.
"""
import argparse
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import uuid

# Import without writing outside the two-file implementation allowlist.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('paired_staging_smoke', Path(__file__).with_name('recovery-staging-smoke.py'))
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)
Failure = smoke.SmokeFailure
TAG_SERVICES = dict(zip((
    'supabase/postgres:17.6.1.136', 'supabase/gotrue:v2.189.0',
    'postgrest/postgrest:v14.12', 'nginx:1.27.5-alpine',
    'minio/minio:RELEASE.2025-09-07T16-13-09Z', 'amazon/aws-cli:2.27.41'),
    ('db', 'auth', 'rest', 'proxy', 'storage', 'storage-init')))
IMAGE_SERVICES = ('backend', 'frontend', *TAG_SERVICES.values())
WRITERS = ('proxy', 'frontend', 'backend', 'rest', 'auth', 'storage-init', 'db-init', 'storage')
LIMITATIONS = [
    'Auth/project/document fixture only; foundation for later aggregate seeded verification, not G completion',
    'No approved-AI/Drive evidence', 'No full Beta journey',
    'No supported upgrade evidence', 'No full Phase3 coverage',
    'No browser rendering or PDF conversion assertion',
    'Same-image stopped-writer MinIO copy only; no cross-version or live-backup support',
    'No runtime proof in contract-only mode; offline boundary models are not runtime evidence',
    'Existing image source provenance is not attested',
    'Restored HTTP uses backed-up active sessions; password login/logout are exercised on source before backup',
]

# Hash sorted JSONB rows inside PostgreSQL. No rows, credentials, or SQL dumps
# cross stdout. Include all non-system ordinary/materialized tables and sequence
# state, not just fixture rows. The quiescent DB has no application writers.
CONTENT_SQL = r"""-- paired-content
SET statement_timeout = '60s';
SET timezone = 'UTC';
SELECT format('SELECT encode(sha256(convert_to(%L || coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, ''[]''), ''UTF8'')), ''hex'') FROM %I.%I t;',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','m')
ORDER BY n.nspname, c.relname
\gexec
SELECT format('SELECT encode(sha256(convert_to(%L || jsonb_build_array(last_value, is_called)::text, ''UTF8'')), ''hex'') FROM %I.%I;',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind='S'
ORDER BY n.nspname, c.relname
\gexec
"""

# Schema-only pg_dump covers function bodies/search_path/security-definer,
# policies, grants/default grants, owners, constraints and trigger definitions.
# These additional normalized facts cover effective role membership, role flags,
# database ACL/settings, effective fixture permissions and enabled RLS/triggers.
SECURITY_SQL = r"""-- paired-security
SET statement_timeout = '60s';
WITH facts AS (
 SELECT jsonb_build_array('role', rolname, rolsuper, rolinherit, rolcreaterole,
   rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil, rolconfig) AS v FROM pg_roles
 UNION ALL SELECT jsonb_build_array('member', pg_get_userbyid(roleid), pg_get_userbyid(member),
   pg_get_userbyid(grantor), admin_option, inherit_option, set_option) FROM pg_auth_members
 UNION ALL SELECT jsonb_build_array('database', datname, pg_get_userbyid(datdba), datacl)
   FROM pg_database WHERE datname=current_database()
 UNION ALL SELECT jsonb_build_array('settings', coalesce(d.datname,''), coalesce(r.rolname,''), s.setconfig)
   FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole
   WHERE s.setdatabase=0 OR d.datname=current_database()
 UNION ALL SELECT jsonb_build_array('rls', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
 UNION ALL SELECT jsonb_build_array('trigger', n.nspname, c.relname, t.tgname, t.tgenabled)
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_'
 UNION ALL SELECT jsonb_build_array('permission', r, t, p, has_table_privilege(r,t,p))
   FROM unnest(ARRAY['anon','authenticated','service_role']) r
   CROSS JOIN unnest(ARRAY['public.projects','public.documents','public.audit_events']) t
   CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
)
SELECT encode(sha256(convert_to(jsonb_agg(v ORDER BY v::text)::text,'UTF8')),'hex') FROM facts;
"""


@contextmanager
def bounded_files(runner):
    duration = min(60, runner.deadline - time.monotonic())
    if duration <= 0:
        raise Failure('file_deadline')
    signal.setitimer(signal.ITIMER_REAL, duration)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def file_hash(runner, path, schema=False):
    with bounded_files(runner):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 256 * 1024 * 1024:
            raise Failure('invalid_private_file')
        path.chmod(0o600)
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            if schema:
                # Remove only paired outer psql nonce commands. Preserve every
                # SQL byte, including comment-looking or empty literal lines.
                lines = handle.readlines()
                first = next((i for i, line in enumerate(lines)
                              if line.strip() and not line.startswith(b'--')), None)
                last = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].strip()), None)
                ignored = set()
                if first is not None:
                    opening = re.fullmatch(rb'\\restrict ([A-Za-z0-9]+)\r?\n?', lines[first])
                    if opening:
                        if last == first or lines[last].strip() != b'\\unrestrict ' + opening[1]:
                            raise Failure('invalid_dump_framing')
                        ignored = {first, last}
                for i, line in enumerate(lines):
                    if i not in ignored:
                        digest.update(line)
            else:
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    digest.update(chunk)
        return digest.hexdigest()


def storage_hash(runner, directory, post_start=False):
    digest, count, size = hashlib.sha256(), 0, 0
    with bounded_files(runner):
        # Bound tree enumeration as well as reads. No symlinks/devices accepted.
        pending = [directory]
        while pending:
            folder = pending.pop()
            folder.chmod(0o700)
            with os.scandir(folder) as entries:
                for entry in entries:
                    count += 1
                    if count > 10000 or entry.is_symlink():
                        raise Failure('invalid_storage_tree')
                    info = entry.stat(follow_symlinks=False)
                    if info.st_uid != os.getuid():
                        raise Failure('invalid_storage_owner')
                    if stat.S_ISDIR(info.st_mode):
                        pending.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode):
                        size += info.st_size
                        if size > 256 * 1024 * 1024:
                            raise Failure('storage_size_limit')
                        Path(entry.path).chmod(0o600)
                    else:
                        raise Failure('invalid_storage_file')
        files = sorted(p for p in directory.rglob('*') if p.is_file())
    if post_start:
        # Pinned MinIO scanner/cache internals ONLY. The pre-start proof never
        # filters. Retain every other byte, including .minio.sys/config (IAM),
        # bucket policy/versioning/lock metadata, format and all object versions.
        volatile = re.compile(r'\.minio\.sys/(?:tmp/.*|buckets/[^/]+/\.metacache/.*|buckets/(?:\.bloomcycle\.bin|\.usage\.json|(?:[^/]+/)?\.usage-cache\.bin(?:\.bkp)?)(?:/.*)?)\Z')
        files = [p for p in files if not volatile.fullmatch(p.relative_to(directory).as_posix())]
    for path in files:
        digest.update(path.relative_to(directory).as_posix().encode() + b'\0')
        digest.update(bytes.fromhex(file_hash(runner, path)))
    if not files or not size:
        raise Failure('empty_storage_backup')
    return digest.hexdigest()


class ObservedRunner(smoke.Runner):
    """The inherited application() and every inherited smoke check run unchanged."""
    def __init__(self, args):
        super().__init__(args)
        self.pins = {s: getattr(args, s.replace('-', '_') + '_image') for s in IMAGE_SERVICES}
        self.fixture = {}
        self.ids = {}
        self.logical_storage = None
        self.inventory_source = smoke.ROOT / 'backend/scripts/recovery-storage-inventory.cjs'
        self.receipt['scope'] = 'Paired recovery stack component'
        self.receipt['limitations'] = LIMITATIONS

    def command(self, argv, timeout=30):
        if argv == self.compose + ['down', '--volumes', '--remove-orphans', '--timeout', '10']:
            # Reuse Runner teardown, but guard its implicit stops/removals too.
            # Discovery by project catches a lost/foreign owner label fail-closed.
            guarded = {cid for service in smoke.SERVICES if (cid := self.resource(
                service, {'created', 'running', 'exited', 'restarting', 'paused', 'dead'}, optional=True))}
            found = super().command(self.docker + ['ps', '--all', '--quiet', '--no-trunc', '--filter',
                'label=com.docker.compose.project=' + self.project], timeout=8)
            if set(found.splitlines()) != guarded:
                raise Failure('cleanup_container_identity_mismatch')
            for kind, names in (('volume', ('staging_db_data', 'staging_storage_data')),
                                ('network', ('default', 'edge'))):
                found = super().command(self.docker + [kind, 'ls', '--quiet', '--filter',
                    'label=com.docker.compose.project=' + self.project], timeout=8)
                for identity in found.splitlines():
                    row = json.loads(super().command(self.docker + [kind, 'inspect', '--format',
                        '{"Name":{{json .Name}},"Labels":{{json .Labels}}}', identity], timeout=8))
                    name = row['Name'].removeprefix(self.project + '_')
                    if (name not in names or row['Name'] != self.project + '_' + name or
                            row['Labels'].get('com.litt.recovery.owner') != self.owner or
                            row['Labels'].get('com.docker.compose.project') != self.project or
                            row['Labels'].get('com.docker.compose.' + kind) != name):
                        raise Failure('cleanup_resource_identity_mismatch')
        result = super().command(argv, timeout)
        # Runner resolves frozen infrastructure tags. Require the caller's exact
        # local IDs to agree, then pin all services before any creation.
        if 'image' in argv and 'inspect' in argv and argv[-1] in TAG_SERVICES:
            if result != self.pins[TAG_SERVICES[argv[-1]]]:
                raise Failure('infra_pin_mismatch')
        return result

    def prepare(self):
        super().prepare()
        with bounded_files(self):
            self.receipt['paired_runner_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            self.receipt['inventory_runner_sha256'] = hashlib.sha256(self.inventory_source.read_bytes()).hexdigest()
        if self.args.runtime:
            self.override.write_text('services:\n' + ''.join(
                '  ' + s + ':\n    image: ' + self.pins['db' if s == 'db-init' else s] + '\n'
                for s in smoke.SERVICES))
            self.override.chmod(0o600)

    def http(self, name, method, path, expected=200, body=None, content_type='application/json', binary=False):
        result = super().http(name, method, path, expected, body, content_type, binary)
        if name == 'signup':
            self.fixture['credentials'] = dict(body)
            self.fixture['user'] = str(uuid.UUID(result['user']['id']))
        elif name == 'project_create':
            self.fixture['project'] = str(uuid.UUID(result['id']))
        elif name == 'document_upload':
            self.fixture['document'] = str(uuid.UUID(result['id']))
        elif name == 'document_download':
            self.fixture['hash'] = hashlib.sha256(result).hexdigest()
        elif name == 'outsider_signup':
            self.fixture['outsider_credentials'] = dict(body)
            self.fixture['outsider'] = str(uuid.UUID(result['user']['id']))
        return result

    def resource(self, service, states, optional=False):
        labels = {'com.litt.recovery.owner': self.owner, 'com.docker.compose.project': self.project,
                  'com.docker.compose.service': service}
        argv = self.docker + ['ps', '--all', '--quiet', '--no-trunc']
        for k, v in labels.items():
            if k != 'com.litt.recovery.owner':
                argv += ['--filter', 'label=' + k + '=' + v]
        cid = self.command(argv)
        if optional and not cid:
            return None
        if not re.fullmatch('[0-9a-f]{64}', cid) or (service in self.ids and self.ids[service] != cid):
            raise Failure('container_identity_mismatch')
        raw = self.command(self.docker + ['container', 'inspect', '--format',
            '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},'
            '"State":{{json .State.Status}},"Mounts":{{json .Mounts}}}', cid])
        row = json.loads(raw)
        if (row['Id'] != cid or any(row['Labels'].get(k) != v for k, v in labels.items())
                or row['Image'] != self.pins['db' if service == 'db-init' else service] or row['State'] not in states):
            raise Failure('resource_guard_failed')
        self.ids[service] = cid
        if service in ('db', 'storage'):
            volume = 'staging_' + ('db' if service == 'db' else 'storage') + '_data'
            name = self.project + '_' + volume
            dest = '/data' if service == 'storage' else '/var/lib/postgresql/data'
            mounts = [m for m in row['Mounts'] if m['Destination'] == dest]
            if len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0]['Name'] != name:
                raise Failure('volume_mount_mismatch')
            v = json.loads(self.command(self.docker + ['volume', 'inspect', '--format',
                '{"Name":{{json .Name}},"Labels":{{json .Labels}}}', name]))
            if v['Name'] != name or any(v['Labels'].get(k) != value for k, value in {
                'com.litt.recovery.owner': self.owner, 'com.docker.compose.project': self.project,
                'com.docker.compose.volume': volume}.items()):
                raise Failure('volume_identity_mismatch')
        return cid

    def create(self):
        self.stage('create')
        self.started = True  # Partial creation belongs to cleanup too.
        self.receipt['runtime_attempted'] = True
        self.port_guard.close()
        self.command(self.compose + ['create', '--no-build', '--pull', 'never'], timeout=900)
        for service in smoke.SERVICES:
            self.resource(service, {'created'})

    def start(self, runtime_only=False):
        self.stage('start')
        for service in smoke.SERVICES:
            self.resource(service, {'created', 'exited', 'running'})
        services = [s for s in smoke.SERVICES if not s.endswith('init')] if runtime_only else []
        self.command(self.compose + ['start'] + services, timeout=600)
        self.readiness()
        self.receipt['runtime_exercised'] = True

    def storage_inventory(self):
        self.stage('logical_storage_inventory')
        self.resource('storage', {'running'})
        backend = self.resource('backend', {'running'})
        path = self.work / 'storage-inventory.cjs'
        with bounded_files(self):
            data = self.inventory_source.read_bytes()
            if hashlib.sha256(data).hexdigest() != self.receipt['inventory_runner_sha256']:
                raise Failure('inventory_source_changed')
            path.write_bytes(data)
            path.chmod(0o600)
        remote = '/app/scripts/recovery-storage-inventory.cjs'
        self.copy('backend', path, remote, inbound=True)
        actual = self.command(self.docker + ['exec', '--user', 'root', backend, 'sha256sum', remote])
        self.check('inventory_container_bytes', actual == self.receipt['inventory_runner_sha256'] + '  ' + remote)
        result = json.loads(self.command(self.docker + ['exec', '--user', 'root', backend, 'node', remote], timeout=300))
        counts = result.get('counts', {}) if isinstance(result, dict) else {}
        if (not isinstance(result, dict) or set(result) != {'sha256', 'counts'} or
            not isinstance(result['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', result['sha256']) or
            not isinstance(counts, dict) or set(counts) != {'buckets', 'versions', 'deleteMarkers', 'currentObjects', 'bytes'} or
            any(type(v) is not int or v < 0 for v in counts.values()) or
            any(counts[k] < 1 for k in ('buckets', 'versions', 'currentObjects', 'bytes')) or
            sum(v for k, v in counts.items() if k != 'bytes') > 10000 or counts['bytes'] > 256 * 1024 * 1024):
            raise Failure('invalid_storage_inventory')
        return result

    def quiesce(self):
        self.stage('quiesce')
        # Close ingress and initializers first. The existing backend supplies the
        # SDK process; no helper container, public port or dependency is added.
        # Its app process is still alive during this read, so the inventory alone
        # is NOT a quiescent proof: the mandatory post-stop persistent-byte
        # comparison below covers any subsequent object/config/IAM mutation.
        for service in WRITERS:
            if service in ('backend', 'storage'):
                continue
            cid = self.resource(service, {'running', 'exited'})
            self.command(self.docker + ['stop', '--time', '30', cid], timeout=45)
            self.resource(service, {'exited'})
        self.logical_storage = self.storage_inventory()
        for service in ('backend', 'storage'):
            cid = self.resource(service, {'running', 'exited'})
            self.command(self.docker + ['stop', '--time', '30', cid], timeout=45)
            self.resource(service, {'exited'})

    def db_exec(self, command, user='postgres'):
        cid = self.resource('db', {'running'})
        return self.command(self.docker + ['exec', '--user', user, cid] + command, timeout=180)

    def copy(self, service, local, remote, inbound=False):
        cid = self.resource(service, {'created', 'exited'} if service == 'storage' else {'running'})
        endpoint = cid + ':' + remote
        self.command(self.docker + ['cp'] + ([str(local), endpoint] if inbound else [endpoint, str(local)]), timeout=180)
        if inbound and service == 'db':
            if remote not in ('/tmp/paired/query.sql', '/tmp/paired/database.dump'):
                raise Failure('invalid_database_copy_path')
            # docker cp creates root-owned files. Retain 0600 and transfer only
            # these two fixed private files to the container's postgres OS user.
            self.db_exec(['sh', '-ec', 'chown postgres:postgres ' + remote + '; chmod 600 ' + remote], user='root')

    def sql(self, text):
        path = self.work / 'query.sql'
        with bounded_files(self):
            path.write_text(text)
            path.chmod(0o600)
        self.copy('db', path, '/tmp/paired/query.sql', inbound=True)
        return self.db_exec(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin',
                             '-d', 'postgres', '-f', '/tmp/paired/query.sql'])

    def snapshot(self):
        self.stage('database_comparison')
        hashes = []
        for sql in (CONTENT_SQL, SECURITY_SQL):
            result = self.sql(sql)
            if not result or not all(re.fullmatch('[0-9a-f]{64}', s) for s in result.splitlines()):
                raise Failure('invalid_database_fingerprint')
            hashes.append(hashlib.sha256(result.encode()).hexdigest())
        self.db_exec(['sh', '-ec', 'umask 077; pg_dump -U supabase_admin -d postgres --schema-only '
                      '--file=/tmp/paired/schema.sql'])
        path = self.work / 'schema.sql'
        self.copy('db', path, '/tmp/paired/schema.sql')
        hashes.append(file_hash(self, path, schema=True))
        return hashes

    def audit(self, fixture):
        # Correlate real audit rows to the HTTP fixture by digest. Observed IDs
        # and credentials remain in memory, never in SQL files or command argv.
        result = self.sql("-- paired-audit\nSET statement_timeout='30s';\n"
            "SELECT DISTINCT encode(sha256(convert_to(actor_user_id::text || ':' || project_id::text || ':' || "
            "document_id::text, 'UTF8')), 'hex') FROM public.audit_events "
            "WHERE event_type='document.uploaded' AND status='completed';")
        expected = hashlib.sha256(':'.join(fixture[k] for k in ('user', 'project', 'document')).encode()).hexdigest()
        rows = result.splitlines()
        self.check('real_upload_audit', all(re.fullmatch('[0-9a-f]{64}', row) for row in rows) and expected in rows)

    def capture_restore_sessions(self):
        # All legitimate Auth writes precede the complete backup fingerprint.
        # Preserve two independent active sessions in memory only. Clearing the
        # client's cookie jar does not revoke the persisted server session.
        self.fixture['sessions'] = {}
        for role, credentials, identity in (
            ('owner', 'credentials', 'user'), ('outsider', 'outsider_credentials', 'outsider')
        ):
            self.cookies.clear()
            login = self.http('backup_' + role + '_login', 'POST', '/api/auth/login', body=self.fixture[credentials])
            self.check('backup_' + role + '_identity', login['user']['id'] == self.fixture[identity] and bool(self.cookies))
            self.fixture['sessions'][role] = [copy.copy(cookie) for cookie in self.cookies]
        self.cookies.clear()

    def restore_session(self, fixture, role):
        self.cookies.clear()
        for cookie in fixture['sessions'][role]:
            self.cookies.set_cookie(copy.copy(cookie))
        self.check('restored_' + role + '_session_present', bool(self.cookies))

    def verify_http(self, fixture, restored=False):
        if restored:
            self.restore_session(fixture, 'owner')
        else:
            login = self.http('owner_login', 'POST', '/api/auth/login', body=fixture['credentials'])
            self.check('owner_identity', login['user']['id'] == fixture['user'] and bool(self.cookies))
        session = self.http('owner_session', 'GET', '/api/auth/session')
        self.check('owner_session_identity', session['user']['id'] == fixture['user'])
        project = self.http('owner_project', 'GET', '/api/projects/' + fixture['project'])
        self.check('project_identity', project['id'] == fixture['project'])
        docs = self.http('owner_documents', 'GET', '/api/projects/' + fixture['project'] + '/documents')
        self.check('restored_document_identity', any(d.get('id') == fixture['document'] for d in docs))
        data = self.http('owner_docx', 'GET', '/api/single-documents/' + fixture['document'] + '/docx', binary=True)
        self.check('restored_docx_hash', hashlib.sha256(data).hexdigest() == fixture['hash'])
        if not restored:
            self.http('owner_logout', 'POST', '/api/auth/logout', expected=204, body={})
            credentials = {'email': 'outsider-' + self.owner + '@example.invalid', 'password': smoke.secrets.token_hex(32)}
            self.http('outsider_signup', 'POST', '/api/auth/signup', expected=201, body=credentials)
            self.check('distinct_outsider', self.fixture['outsider'] != fixture['user'])
        else:
            self.restore_session(fixture, 'outsider')
            session = self.http('outsider_session', 'GET', '/api/auth/session')
            self.check('outsider_identity', session['user']['id'] == fixture['outsider'])
        for name, path in (('project', '/api/projects/' + fixture['project']),
                           ('documents', '/api/projects/' + fixture['project'] + '/documents'),
                           ('docx', '/api/single-documents/' + fixture['document'] + '/docx')):
            self.http('outsider_denied_' + name, 'GET', path, expected=404)
        if not restored:
            self.http('outsider_logout', 'POST', '/api/auth/logout', expected=204, body={})
        self.cookies.clear()


def lifecycle(source, target):
    source.prepare()
    source.create()
    source.start()
    source.application()
    source.verify_http(source.fixture)
    source.capture_restore_sessions()
    source.quiesce()
    source.db_exec(['sh', '-ec', 'umask 077; mkdir -m 700 /tmp/paired'])
    source.audit(source.fixture)
    before = source.snapshot()
    source.stage('paired_backup')
    source.db_exec(['sh', '-ec', 'umask 077; pg_dump -U supabase_admin -d postgres --format=custom '
                    '--create --file=/tmp/paired/database.dump'])
    dump = source.work / 'database.dump'
    source.copy('db', dump, '/tmp/paired/database.dump')
    dump_hash = file_hash(source, dump)
    storage = source.work / 'storage'
    storage.mkdir(mode=0o700)
    source.copy('storage', storage, '/data/.')
    object_hash = storage_hash(source, storage)
    persistent_hash = storage_hash(source, storage, post_start=True)
    source.check('source_unchanged_during_backup', before == source.snapshot())

    target.prepare()
    # Restore synthetic deployment keys too (encrypted columns and S3 identity),
    # preserving target owner, project, loopback port and origin. No argv secrets.
    with bounded_files(target):
        original = dict(line.split('=', 1) for line in source.envfile.read_text().splitlines())
        values = dict(line.split('=', 1) for line in target.envfile.read_text().splitlines())
        for key in values:
            if any(s in key for s in ('PASSWORD', 'SECRET', 'KEY')):
                values[key] = original[key]
        target.envfile.write_text(''.join(k + '=' + v + '\n' for k, v in values.items()))
    target.create()
    cid = target.resource('db', {'created'})
    target.command(target.docker + ['start', cid], timeout=30)
    deadline = min(target.deadline, time.monotonic() + 360)
    while True:
        try:
            ready = target.db_exec(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres',
                                   '-c', "SELECT 1 WHERE current_setting('listen_addresses') <> ''"])
            if ready == '1':
                break
        except Failure as error:
            if str(error) != 'subprocess_exit':
                raise
        if time.monotonic() >= deadline:
            raise Failure('target_database_timeout')
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    target.db_exec(['sh', '-ec', 'umask 077; mkdir -m 700 /tmp/paired'])
    target.stage('restore_disposable_target')
    if source.owner == target.owner or source.project == target.project or source.work == target.work:
        raise Failure('nonindependent_target')
    target.check('backup_dump_integrity', file_hash(source, dump) == dump_hash)
    target.copy('db', dump, '/tmp/paired/database.dump', inbound=True)
    # Restore archived objects only in the newly created, ownership-checked
    # target. Keep its postgres database present: removing it crashes an image
    # background worker. App writers have never started in this target.
    target.stage('restore_database_archive')
    target.db_exec(['sh', '-ec', 'pg_restore -U supabase_admin --exit-on-error --single-transaction '
                    '--clean --if-exists -d postgres /tmp/paired/database.dump'])
    target.stage('restore_storage_bytes')
    target.copy('storage', str(storage) + '/.', '/data', inbound=True)
    def checkpoint(phase):
        target.stage(phase)
        # Each copy needs an empty destination, so a deleted remote file cannot
        # survive locally from an earlier checkpoint and hide a difference.
        copied = target.work / phase
        copied.mkdir(mode=0o700)
        target.copy('storage', copied, '/data/.')
        if phase == 'restored':
            target.check(phase + '_storage_equal', storage_hash(target, copied) == object_hash)
        else:
            target.check(phase + '_storage_equal', storage_hash(target, copied, post_start=True) == persistent_hash)
            target.check(phase + '_logical_storage_equal', target.logical_storage == source.logical_storage)
        current = target.snapshot()
        target.check(phase + '_content_equal', before[0] == current[0])
        target.check(phase + '_security_equal', before[1:] == current[1:])
        target.audit(source.fixture)
        return current

    after = checkpoint('restored')
    target.check('source_preserved_until_verification', source.snapshot() == before)
    target.start()
    target.quiesce()
    after = checkpoint('post_init')
    # The init writers have now run and their complete effects were compared.
    # Do not run them again after that comparison.
    target.start(runtime_only=True)
    target.verify_http(source.fixture, restored=True)
    target.quiesce()
    # Restored sessions permit read-only HTTP without introducing Auth writes.
    # Compare ALL data again, with no Auth-table/column exclusion or observed-only
    # hash. Refresh, background writes or any unexpected mutation fail closed.
    final = checkpoint('post_http')
    target.check('source_preserved_after_http', source.snapshot() == before)
    source_copy = source.work / 'source-final-storage'
    source_copy.mkdir(mode=0o700)
    source.copy('storage', source_copy, '/data/.')
    source.check('source_storage_preserved_after_http', storage_hash(source, source_copy) == object_hash)
    target.receipt['paired_evidence'] = dict(database_content_sha256=after[0], security_sha256=final[1],
        schema_sha256=final[2], storage_sha256=object_hash, docx_sha256=source.fixture['hash'],
        post_http_database_content_sha256=final[0],
        persistent_storage_sha256=persistent_hash, logical_storage=target.logical_storage,
        content_equality_phase='post_http', final_security_and_storage_phase='post_http')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--runtime', action='store_true')
    modes.add_argument('--contract-only', action='store_true')
    for name in IMAGE_SERVICES:
        parser.add_argument('--' + name + '-image', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--docker-socket', default='/var/run/docker.sock')
    parser.add_argument('--timeout-seconds', type=int, default=6000,
                        help='Total work plus two independent 1200s cleanup reserves (3000..7200)')
    args = parser.parse_args(argv)
    if any(not smoke.IMAGE_ID.fullmatch(getattr(args, s.replace('-', '_') + '_image')) for s in IMAGE_SERVICES):
        parser.error('all images must be complete sha256 image IDs')
    if not 3000 <= args.timeout_seconds <= 7200:
        parser.error('timeout must be between 3000 and 7200 seconds')
    if not args.docker_socket.startswith('/') or '\x00' in args.docker_socket:
        parser.error('Docker socket must be an absolute local path')
    source, target = ObservedRunner(args), ObservedRunner(args)
    source.deadline = target.deadline = time.monotonic() + args.timeout_seconds - 2410
    receipt = dict(status='FAIL', runtime_exercised=False, limitations=LIMITATIONS,
                   source=source.receipt, target=target.receipt)
    old = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    previous_umask = os.umask(0o077)

    def interrupted(_signal, _frame):
        raise Failure('interrupted_or_deadline')

    for sig in old:
        signal.signal(sig, interrupted)
    try:
        if args.runtime:
            lifecycle(source, target)
            receipt.update(status='PASS', runtime_exercised=True)
        else:
            source.prepare()
            target.prepare()
            receipt['status'] = 'CONTRACT_ONLY'
        for runner in (source, target):
            runner.receipt['status'] = receipt['status']
    except Exception as error:
        # SmokeFailure carries only fixed local codes / allowlisted signatures.
        # Never serialize arbitrary exception strings from external boundaries.
        receipt['error'] = str(error) if isinstance(error, Failure) else 'paired_lifecycle_failed'
        if isinstance(error, Failure):
            if error.exit_code is not None:
                receipt['subprocess_exit_code'] = error.exit_code
            receipt['failure_signatures'] = list(error.signatures)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for runner in (target, source):
            try:
                # Bound filesystem teardown too, independently for each stack.
                signal.setitimer(signal.ITIMER_REAL, 1200)
                runner.cleanup()  # Each Runner reserves its own 1200s independently.
            except Exception:
                runner.receipt['cleanup_error'] = 'cleanup_failed'
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            runner.fixture.clear()
            if runner.receipt.get('cleanup_error') or not all(runner.receipt['cleanup'].values()):
                receipt['status'] = 'FAIL'
        # Ten seconds reserved for final receipts after BOTH independent cleanups.
        source.deadline = target.deadline = time.monotonic() + 10
        for runner in (source, target):
            runner.receipt['status'] = receipt['status']
            try:
                if runner.output != smoke.ROOT and smoke.ROOT not in runner.output.parents and runner.output.is_dir():
                    with bounded_files(runner):
                        runner.save()
            except Exception:
                receipt['status'] = 'FAIL'
        try:
            if source.output != smoke.ROOT and smoke.ROOT not in source.output.parents and source.output.is_dir():
                path = source.output / ('litt-g-paired-' + source.owner + '-receipt.json')
                with bounded_files(source):
                    with path.open('x', encoding='utf-8') as handle:
                        json.dump(receipt, handle, indent=2)
                        handle.write('\n')
        except Exception:
            receipt['status'] = 'FAIL'
        os.umask(previous_umask)
        for sig, handler in old.items():
            signal.signal(sig, handler)
    print(json.dumps(receipt))
    return 0 if receipt['status'] in ('PASS', 'CONTRACT_ONLY') else 1


if __name__ == '__main__':
    raise SystemExit(main())
