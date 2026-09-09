#!/usr/bin/env python3
"""Offline entrypoint tests; only process, HTTP and socket/OS boundaries faked."""
import contextlib
import email.message
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.response

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name('recovery-backup-restore.py')
PINS = {name: 'sha256:' + str(i) * 64 for i, name in enumerate(
    ('backend', 'frontend', 'db', 'auth', 'rest', 'proxy', 'storage', 'storage-init'), 1)}
USER = '11111111-1111-4111-8111-111111111111'
OUTSIDER = '44444444-4444-4444-8444-444444444444'
PROJECT = '22222222-2222-4222-8222-222222222222'
DOC = '33333333-3333-4333-8333-333333333333'
SECRET = 'NEVER-EMIT-password-cookie-dump'


def cli(output, runtime=True):
    return ['--runtime' if runtime else '--contract-only', '--output-dir', str(output)] + [
        item for name, value in PINS.items() for item in ('--' + name + '-image', value)]


class Boundary:
    """Small Docker/HTTP model: target data exists only after real restore commands."""
    def __init__(self, failure=None):
        self.failure = failure
        self.stacks = {}
        self.commands = []
        self.requests = []
        self.events = []
        self.uploads = 0
        self.inventory_reads = 0
        self.injected = False
        self.secrets = [SECRET]

    def process(self, argv, **kw):
        self.commands.append(argv)
        assert kw['start_new_session'] and kw['stdout'] is not None
        assert all(secret not in ' '.join(argv) for secret in self.secrets)
        out = ''
        if argv[0] == 'git':
            out = '3be2c02770a288e2aa67cfea632894e7934bce3f\n' + 'a' * 40
        elif 'compose' in argv:
            project = argv[argv.index('--project-name') + 1]
            work = Path(argv[argv.index('--env-file') + 1]).parent
            env = dict(line.split('=', 1) for line in (work / 'synthetic.env').read_text().splitlines())
            self.secrets.extend(v for k, v in env.items() if any(s in k for s in ('PASSWORD', 'SECRET', 'KEY')))
            stack = self.stacks.setdefault(project, dict(project=project, owner=env['STAGING_OWNER'],
                port=env['STAGING_PROXY_PORT'], work=work, created=False, down=False, files={},
                data={}, storage={}, states={}, index=len(self.stacks)))
            action = argv[argv.index(str(work / 'images.yml')) + 1]
            if action == 'config':
                if stack['index'] == 1 and self.failure == 'target_prepare':
                    self.injected = True
                    raise OSError(SECRET)
            elif action == 'create':
                text = (work / 'images.yml').read_text()
                for pin in PINS.values():
                    assert pin in text
                assert 'networks:' not in text and 'ports:' not in text
                assert '--no-build' in argv and 'never' in argv
                stack['created'] = True
                stack['states'] = {s: 'created' for s in self.module.smoke.SERVICES}
                self.events.append(('create', stack['index']))
                if stack['index'] == 1 and self.failure == 'signal_target_create':
                    self.injected = True
                    os.kill(os.getpid(), signal.SIGTERM)
                if stack['index'] == 1 and self.failure == 'target_create':
                    self.injected = True
                    raise OSError(SECRET)
            elif action == 'start':
                selected = argv[argv.index(str(work / 'images.yml')) + 2:] or list(stack['states'])
                for s in selected:
                    stack['states'][s] = 'exited' if s.endswith('init') else 'running'
                if stack['index'] == 1 and 'db-init' in selected:
                    stack['init_runs'] = stack.get('init_runs', 0) + 1
                    if self.failure and self.failure.startswith('post_init_'):
                        self.injected = True
                        stack['post_init_corruption'] = self.failure
                        if self.failure == 'post_init_content':
                            stack['data']['unexpected_init_row'] = True
                        if self.failure == 'post_init_storage':
                            stack['storage']['unexpected-init-object'] = b'unexpected'
                self.events.append(('start', stack['index']))
            elif action == 'ps':
                out = json.dumps([dict(Service=s, State=state, ExitCode=0,
                    Health='healthy' if s in self.module.smoke.HEALTHY else '', ID=self.cid(stack, s))
                    for s, state in stack['states'].items()])
            elif action == 'down':
                self.events.append(('down', stack['index']))
                if self.failure == ('cleanup_source' if stack['index'] == 0 else 'cleanup_target'):
                    self.injected = True
                    raise OSError(SECRET)
                stack['down'] = True
            else:
                raise AssertionError(argv)
        elif 'image' in argv and 'inspect' in argv:
            out = argv[-1] if argv[-1].startswith('sha256:') else PINS[self.module.TAG_SERVICES[argv[-1]]]
        elif 'ps' in argv or ('ls' in argv and ('volume' in argv or 'network' in argv)):
            labels = [argv[i + 1][6:] for i, a in enumerate(argv) if a == '--filter']
            matches = [s for s in self.stacks.values() if s['created'] and not s['down'] and all(
                value in (s['owner'], s['project']) for key, value in
                (label.split('=', 1) for label in labels) if key != 'com.docker.compose.service')]
            if matches:
                service = next((label.split('=', 1)[1] for label in labels if label.startswith('com.docker.compose.service=')), None)
                if 'ps' in argv:
                    out = self.cid(matches[0], service) if service else '\n'.join(
                        self.cid(matches[0], item) for item in self.module.smoke.SERVICES)
                elif 'volume' in argv:
                    out = '\n'.join(matches[0]['project'] + '_' + v for v in ('staging_db_data', 'staging_storage_data'))
                else:
                    out = '\n'.join(matches[0]['project'] + '_' + n for n in ('default', 'edge'))
        elif 'inspect' in argv:
            if 'volume' in argv or 'network' in argv:
                kind = 'volume' if 'volume' in argv else 'network'
                stack = next(s for s in self.stacks.values() if argv[-1].startswith(s['project']))
                volume = argv[-1].removeprefix(stack['project'] + '_')
                out = json.dumps(dict(Name=argv[-1], Labels={'com.litt.recovery.owner': stack['owner'],
                    'com.docker.compose.project': stack['project'], 'com.docker.compose.' + kind: volume}))
            else:
                stack, service = self.lookup(argv[-1])
                if argv[argv.index('--format') + 1] == '{{.Image}}':
                    out = PINS[service]
                else:
                    labels = {'com.litt.recovery.owner': stack['owner'], 'com.docker.compose.project': stack['project'],
                              'com.docker.compose.service': service}
                    if self.failure == 'labels':
                        self.injected = True
                        labels['com.litt.recovery.owner'] = 'wrong'
                    out = json.dumps(dict(Id=argv[-1], Image=PINS['db' if service == 'db-init' else service],
                        Labels=labels, State=stack['states'][service], Mounts=[dict(Type='volume',
                        Name=stack['project'] + '_staging_' + ('db' if service == 'db' else 'storage') + '_data',
                        Destination='/var/lib/postgresql/data' if service == 'db' else '/data')]))
        elif 'stop' in argv or ('start' in argv and 'compose' not in argv):
            stack, service = self.lookup(argv[-1])
            if self.failure == 'post_inventory_storage' and stack['index'] == 1 and service == 'backend' and 'stop' in argv:
                self.injected = True
                stack['storage']['late-object'] = b'mutation after logical inventory'
            stack['states'][service] = 'exited' if 'stop' in argv else 'running'
            self.events.append(('stop' if 'stop' in argv else 'start_one', stack['index'], service))
            if self.failure == 'signal' and service == 'storage' and 'stop' in argv:
                self.injected = True
                os.kill(os.getpid(), signal.SIGTERM)
        elif 'cp' in argv:
            src, dst = argv[-2:]
            local = Path(dst if ':' in src else src.removesuffix('/.'))
            assert local.parent.stat().st_mode & 0o777 == 0o700
            if local.is_file():
                assert local.stat().st_mode & 0o777 == 0o600
            if ':' in src:
                cid, path = src.split(':', 1)
                stack, service = self.lookup(cid)
                if service == 'storage':
                    for name, data in stack['storage'].items():
                        if self.failure == 'storage' and stack['index'] == 1:
                            self.injected = True
                            data += b'corrupt'
                        (Path(dst) / name).write_bytes(data)
                else:
                    Path(dst).write_bytes(stack['files'][path])
            else:
                cid, path = dst.split(':', 1)
                stack, service = self.lookup(cid)
                if service == 'storage':
                    stack['storage'] = {p.name: p.read_bytes() for p in Path(src.removesuffix('/.')).iterdir()}
                else:
                    stack['files'][path] = Path(src).read_bytes()
        elif 'exec' in argv:
            pos = argv.index('exec')
            stack, service = self.lookup(argv[pos + 3])  # exec --user postgres CID ...
            command = argv[pos + 4:]
            if command[0] == 'sha256sum':
                out = hashlib.sha256(stack['files'][command[1]]).hexdigest() + '  ' + command[1]
            elif command[0] == 'node':
                assert command[1] == '/app/scripts/recovery-storage-inventory.cjs'
                self.inventory_reads += 1
                manifest = [(k, hashlib.sha256(v).hexdigest()) for k, v in sorted(stack['storage'].items())]
                out = json.dumps({'sha256': hashlib.sha256(json.dumps(manifest).encode()).hexdigest(),
                    'counts': {'buckets': 1, 'versions': len(manifest), 'deleteMarkers': 0,
                               'currentObjects': len(manifest), 'bytes': sum(map(len, stack['storage'].values()))}})
                if self.failure == 'inventory_unavailable':
                    self.injected = True
                    raise OSError(SECRET)
                if self.failure == 'inventory_empty':
                    self.injected = True
                    out = json.dumps({'sha256': '0' * 64, 'counts': {k: 0 for k in ('buckets','versions','deleteMarkers','currentObjects','bytes')}})
            elif command[0] == 'sh':
                if 'pg_dump' in command[-1] and '--schema-only' not in command[-1]:
                    self.events.append(('backup', stack['index']))
                    if self.failure == 'backup':
                        self.injected = True
                        raise OSError(SECRET)
                    stack['files']['/tmp/paired/database.dump'] = json.dumps(stack['data']).encode()
                elif 'pg_restore' in command[-1]:
                    assert '--clean --if-exists -d postgres' in command[-1]
                    assert '--single-transaction' in command[-1]
                    assert '--create' not in command[-1]
                    self.events.append(('restore', stack['index']))
                    assert stack['index'] == 1
                    if self.failure == 'signal_restore':
                        self.injected = True
                        os.kill(os.getpid(), signal.SIGTERM)
                    if self.failure == 'restore':
                        self.injected = True
                        raise OSError(SECRET)
                    stack['data'] = json.loads(stack['files']['/tmp/paired/database.dump'])
                elif 'schema.sql' in command[-1]:
                    self.injected |= self.failure == 'schema' and stack['index'] == 1
                    stack['files']['/tmp/paired/schema.sql'] = b'-- header\n\\restrict random\nCREATE TABLE x();\n\\unrestrict random\n' + (b'GRANT SELECT ON x TO anon;\n' if (self.failure == 'schema' or stack.get('post_init_corruption') == 'post_init_schema') and stack['index'] == 1 else b'')
                elif 'mkdir' not in command[-1] and 'chown postgres:postgres' not in command[-1]:
                    raise AssertionError(command)
            elif command[0] == 'psql':
                assert not any('DROP DATABASE' in arg for arg in command), 'keep the image database present'
                if '-f' in command:
                    sql = stack['files'][command[-1]].decode()
                    if 'paired-content' in sql:
                        assert 'jsonb_agg' in sql and 'ORDER BY' in sql and 'last_value' in sql
                        data = dict(stack['data'])
                        if self.failure == 'content' and stack['index'] == 1:
                            self.injected = True
                            data['corrupt'] = True
                        out = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                    elif 'paired-security' in sql:
                        assert 'pg_auth_members' in sql and 'has_table_privilege' in sql and 'relforcerowsecurity' in sql
                        self.injected |= self.failure == 'acl' and stack['index'] == 1
                        out = hashlib.sha256(('bad' if (self.failure == 'acl' or stack.get('post_init_corruption') == 'post_init_acl') and stack['index'] == 1 else 'security').encode()).hexdigest()
                    elif 'paired-audit' in sql:
                        assert all(x in sql for x in ('actor_user_id', 'project_id', 'document_id', 'document.uploaded', 'completed'))
                        assert all(x not in sql for x in (USER, PROJECT, DOC))
                        self.injected |= self.failure == 'audit'
                        out = '' if self.failure == 'audit' else hashlib.sha256(':'.join((USER, PROJECT, DOC)).encode()).hexdigest()
                    else:
                        raise AssertionError(sql)
                else:
                    out = '1'
            else:
                raise AssertionError(command)
        else:
            raise AssertionError(argv)
        child = Mock(pid=99999999, returncode=0)
        child.communicate.return_value = (out.encode(), SECRET.encode())
        if self.failure == 'backup_exit' and 'exec' in argv and 'pg_dump' in argv[-1] and '--format=custom' in argv[-1]:
            self.injected = True
            child.returncode = 1
        if self.failure == 'backup_timeout' and 'exec' in argv and 'pg_dump' in argv[-1] and '--format=custom' in argv[-1]:
            self.injected = True
            child.communicate.side_effect = [subprocess.TimeoutExpired(argv, 1), (b'', SECRET.encode())]
        return child

    def cid(self, stack, service):
        return f"{stack['index'] + 1:032x}{self.module.smoke.SERVICES.index(service) + 1:032x}"

    def lookup(self, cid):
        return next((s, service) for s in self.stacks.values() for service in self.module.smoke.SERVICES
                    if self.cid(s, service) == cid)

    def http(self, req):
        stack = next(s for s in self.stacks.values() if req.host.endswith(':' + s['port']))
        path = req.selector
        self.requests.append((stack['index'], req.method, path))
        headers = email.message.Message()
        status, payload = 200, {'ok': True}
        cookie = req.get_header('Cookie')
        uid = OUTSIDER if cookie and 'outsider' in cookie else USER
        if path in ('/api/auth/signup', '/api/auth/login'):
            body = json.loads(req.data)
            self.secrets.append(body['password'])
            if path.endswith('signup'):
                status = 201
                stack['data'].setdefault('users', {})[body['email']] = body['password']
            else:
                assert stack['data']['users'][body['email']] == body['password']
                stack['data']['login_count'] = stack['data'].get('login_count', 0) + 1
            uid = OUTSIDER if body['email'].startswith('outsider-') else USER
            headers['Set-Cookie'] = 'session=' + ('outsider' if uid == OUTSIDER else SECRET) + '; Path=/'
            self.injected |= self.failure == 'identity' and stack['index'] == 1
            payload = {'user': {'id': 'wrong' if self.failure == 'identity' and stack['index'] == 1 else uid},
                       'requiresEmailConfirmation': False}
        elif path == '/api/auth/session':
            status = 200 if cookie else 401
            self.injected |= self.failure == 'identity' and stack['index'] == 1
            payload = {'user': {'id': 'wrong' if self.failure == 'identity' and stack['index'] == 1 else uid}}
        elif path == '/api/auth/logout':
            status = 204
            headers['Set-Cookie'] = 'session=; Max-Age=0; Path=/'
        elif path in ('/api/user/onboarding', '/api/user/profile'):
            payload = {'onboardingComplete': True, 'onboardingVersion': 1, 'organisation': 'Synthetic Smoke'}
        elif path == '/api/projects' and req.method == 'POST':
            status, payload = 201, {'id': PROJECT, 'name': 'Synthetic Smoke'}
            stack['data']['project'] = PROJECT
        elif path.endswith('/documents') and req.method == 'POST':
            self.uploads += 1
            stack['storage']['synthetic.docx'] = req.data.split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0]
            stack['data']['document'] = DOC
            status, payload = 201, {'id': DOC, 'status': 'ready'}
        elif path.startswith('/api/projects') or path.endswith('/docx'):
            if self.failure == 'post_http_content' and stack['index'] == 1:
                self.injected = True
                stack['data']['unexpected_http_row'] = True
            self.injected |= uid == OUTSIDER and self.failure == 'outsider'
            if uid == OUTSIDER and self.failure != 'outsider':
                status, payload = 404, {}
            elif path.endswith('/docx'):
                payload = stack['storage']['synthetic.docx']
                if self.failure == 'hash' and stack['index'] == 1:
                    self.injected = True
                    payload += b'corrupt'
            elif path.endswith('/documents'):
                payload = [{'id': stack['data']['document']}]
            else:
                self.injected |= self.failure == 'project' and stack['index'] == 1
                payload = {'id': 'wrong' if self.failure == 'project' and stack['index'] == 1 else stack['data']['project'], 'name': 'Synthetic Smoke'}
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        response = urllib.response.addinfourl(io.BytesIO(raw), headers, req.full_url, status)
        response.msg = 'synthetic'
        return response


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('paired', SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def exercise(self, failure=None, runtime=True):
        b = Boundary(failure)
        b.module = self.module
        with tempfile.TemporaryDirectory() as output, contextlib.ExitStack() as stack:
            stack.enter_context(patch('subprocess.Popen', b.process))
            stack.enter_context(patch('os.killpg'))
            sockets = stack.enter_context(patch.object(self.module.smoke.socket, 'socket'))
            sockets.return_value.getsockname.side_effect = [('127.0.0.1', 43127), ('127.0.0.1', 43128)]
            sockets.return_value.__enter__.return_value.connect_ex.return_value = 111
            stack.enter_context(patch('urllib.request.HTTPHandler.http_open', lambda _, req: b.http(req)))
            if failure == 'backup_files_cleanup':
                remove = shutil.rmtree
                def failing_remove(path, *args, **kwargs):
                    owner = next((s for s in b.stacks.values() if s['work'] == Path(path)), None)
                    if owner and owner['index'] == 0:
                        b.injected = True
                        raise OSError(SECRET)
                    return remove(path, *args, **kwargs)
                stack.enter_context(patch('shutil.rmtree', failing_remove))
            out = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            rc = self.module.main(cli(output, runtime))
            receipt = json.loads(out.getvalue())
            evidence = out.getvalue() + ''.join(p.read_text() for p in Path(output).rglob('*.json'))
            for secret in b.secrets:
                self.assertNotIn(secret, evidence)
            remaining = list(Path(output).glob('*-private'))
            self.assertEqual(len(remaining), 1 if failure == 'backup_files_cleanup' else 0)
            aggregate = list(Path(output).glob('litt-g-paired-*-receipt.json'))
            self.assertEqual(len(aggregate), 1)
            self.assertEqual(json.loads(aggregate[0].read_text())['status'], receipt['status'])
            self.assertEqual(aggregate[0].stat().st_mode & 0o777, 0o600)
            if failure:
                self.assertTrue(b.injected, 'failure injection never reached: ' + failure)
        return rc, receipt, b

    def test_contract_no_docker_or_http(self):
        rc, receipt, b = self.exercise(runtime=False)
        self.assertEqual(rc, 0)
        self.assertEqual(receipt['status'], 'CONTRACT_ONLY')
        self.assertFalse(b.requests)
        self.assertTrue(all(c[0] == 'git' for c in b.commands))

    def test_runtime_orchestration(self):
        rc, receipt, b = self.exercise()
        self.assertEqual(rc, 0, receipt)
        self.assertEqual(receipt['status'], 'PASS')
        self.assertIs(self.module.ObservedRunner.application, self.module.smoke.Runner.application)
        self.assertEqual(b.uploads, 1)
        self.assertEqual(b.inventory_reads, 3)
        self.assertEqual(len(b.stacks), 2)
        self.assertTrue(all(s['down'] for s in b.stacks.values()))
        self.assertLess(b.events.index(('stop', 0, 'storage')), b.events.index(('backup', 0)))
        self.assertLess(b.events.index(('restore', 1)), b.events.index(('start', 1)))
        self.assertLess(b.events.index(('start', 1)), b.events.index(('down', 0)))
        self.assertTrue(receipt['runtime_exercised'])
        target = next(s for s in b.stacks.values() if s['index'] == 1)
        self.assertEqual(target['init_runs'], 1)
        evidence = receipt['target']['paired_evidence']
        self.assertEqual(evidence['content_equality_phase'], 'post_http')
        self.assertEqual(evidence['final_security_and_storage_phase'], 'post_http')
        self.assertEqual(evidence['database_content_sha256'], evidence['post_http_database_content_sha256'])
        self.assertTrue(all(method == 'GET' for index, method, _ in b.requests if index == 1))
        source = next(s for s in b.stacks.values() if s['index'] == 0)
        self.assertEqual(source['data']['login_count'], target['data']['login_count'])

    def test_post_http_content_mutation_cannot_pass_as_an_observed_hash(self):
        rc, receipt, b = self.exercise('post_http_content')
        self.assertEqual(rc, 1, 'post-HTTP content corruption was accepted')
        self.assertEqual(receipt['status'], 'FAIL')
        self.assertNotIn('paired_evidence', receipt['target'])
        self.assertTrue(all(s['down'] for s in b.stacks.values()))

    def test_post_init_mutations_cannot_pass_on_pre_start_fingerprints(self):
        for failure in ('post_init_content', 'post_init_storage', 'post_init_acl', 'post_init_schema', 'post_inventory_storage'):
            with self.subTest(failure=failure):
                rc, receipt, b = self.exercise(failure)
                self.assertEqual(rc, 1, 'post-init corruption was accepted')
                self.assertEqual(receipt['status'], 'FAIL')
                self.assertNotIn('paired_evidence', receipt['target'])
                self.assertTrue(all(s['down'] for s in b.stacks.values()))

    def test_failures_are_fatal_and_cleanup_is_independent(self):
        for failure in ('inventory_empty', 'inventory_unavailable', 'target_prepare', 'target_create', 'backup', 'backup_exit', 'backup_timeout', 'restore', 'content', 'acl', 'schema',
                        'identity', 'project', 'hash', 'storage', 'outsider', 'audit', 'labels', 'signal', 'signal_target_create', 'signal_restore', 'cleanup_source', 'cleanup_target', 'backup_files_cleanup'):
            with self.subTest(failure=failure):
                rc, receipt, b = self.exercise(failure)
                self.assertEqual(rc, 1)
                self.assertEqual(receipt['status'], 'FAIL')
                if failure == 'backup_exit':
                    self.assertEqual(receipt['error'], 'subprocess_exit')
                    self.assertEqual(receipt['subprocess_exit_code'], 1)
                for s in b.stacks.values():
                    if s['created'] and failure != 'labels':
                        self.assertIn(('down', s['index']), b.events)
                self.assertLessEqual(b.uploads, 1)
                if failure in ('content', 'acl', 'schema', 'storage'):
                    self.assertNotIn(('start', 1), b.events)
                if failure == 'labels':
                    self.assertFalse(any('exec' in c or 'cp' in c or 'stop' in c or 'down' in c for c in b.commands))

    def test_storage_post_start_excludes_only_named_scanner_temporaries(self):
        with tempfile.TemporaryDirectory() as output:
            runner = Mock(deadline=time.monotonic() + 60)
            root = Path(output)
            stable = root / '.minio.sys/config/iam/policies/private.json'
            stable.parent.mkdir(parents=True)
            stable.write_bytes(b'private policy')
            (root / 'application.docx').write_bytes(b'persisted bytes')
            before = self.module.storage_hash(runner, root, post_start=True)
            physical_before = self.module.storage_hash(runner, root)
            for relative in ('.minio.sys/tmp/.trash/temporary/xl.meta',
                             '.minio.sys/buckets/.bloomcycle.bin/xl.meta',
                             '.minio.sys/buckets/.usage.json/xl.meta',
                             '.minio.sys/buckets/litt-recovery/.metacache/page-id/block-0.s2/xl.meta',
                             '.minio.sys/buckets/litt-recovery/.usage-cache.bin.bkp/xl.meta'):
                p = root / relative
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b'scanner changed')
            self.assertEqual(before, self.module.storage_hash(runner, root, post_start=True))
            self.assertNotEqual(physical_before, self.module.storage_hash(runner, root))
            stable.write_bytes(b'public policy')
            self.assertNotEqual(before, self.module.storage_hash(runner, root, post_start=True))
            stable.write_bytes(b'private policy')
            for relative in ('.minio.sys/buckets/litt-recovery/policy.json',
                             '.minio.sys/config/config.json', '.usage.json',
                             'litt-recovery/.usage-cache.bin/xl.meta'):
                p = root / relative
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b'must not be ignored')
                self.assertNotEqual(before, self.module.storage_hash(runner, root, post_start=True))
                p.unlink()

    def test_schema_hash_ignores_only_dump_framing(self):
        with tempfile.TemporaryDirectory() as output:
            runner = Mock(deadline=time.monotonic() + 60)
            path = Path(output) / 'schema.sql'
            path.write_bytes(b'-- PostgreSQL database dump\n\\restrict tokenA\nCREATE TABLE x();\n\\unrestrict tokenA\n')
            first = self.module.file_hash(runner, path, schema=True)
            path.write_bytes(b'-- PostgreSQL database dump\n\\restrict tokenB\nCREATE TABLE x();\n\\unrestrict tokenB\n')
            self.assertEqual(first, self.module.file_hash(runner, path, schema=True))
            path.write_bytes(b'CREATE TABLE x();\nGRANT SELECT ON x TO anon;\n')
            self.assertNotEqual(first, self.module.file_hash(runner, path, schema=True))

    def test_schema_hash_preserves_sql_literal_lines_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as output:
            runner = Mock(deadline=time.monotonic() + 60)
            path = Path(output) / 'schema.sql'
            original = b"CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ SELECT $q$start\n-- meaningful\n\nend$q$; $$;\n"
            path.write_bytes(original)
            first = self.module.file_hash(runner, path, schema=True)
            for changed in (original.replace(b'-- meaningful', b'-- changed'), original.replace(b'\n\n', b'\n')):
                path.write_bytes(changed)
                self.assertNotEqual(first, self.module.file_hash(runner, path, schema=True))

    def test_repository_output_rejected_without_mutation(self):
        with patch.object(Path, 'mkdir') as mkdir, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.module.main(cli(SCRIPT.parent, runtime=False)), 1)
        mkdir.assert_not_called()

    def test_import_is_inert(self):
        spec = importlib.util.spec_from_file_location('paired_import', SCRIPT)
        with patch('subprocess.Popen', side_effect=AssertionError), patch('pathlib.Path.mkdir', side_effect=AssertionError):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))

    def test_cli_rejects_bad_pin_without_echo(self):
        with tempfile.TemporaryDirectory() as output, contextlib.redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(SystemExit):
                self.module.main(cli(output) + ['--db-image', SECRET])
            self.assertNotIn(SECRET, err.getvalue())
            self.assertFalse(list(Path(output).iterdir()))


if __name__ == '__main__':
    unittest.main()
