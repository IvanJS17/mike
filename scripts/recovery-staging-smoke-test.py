#!/usr/bin/env python3
"""Offline entrypoint tests: Docker process and urllib transport boundaries only."""
import contextlib
import email.message
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.response

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name('recovery-staging-smoke.py')
BACK = 'sha256:' + 'a' * 64
FRONT = 'sha256:' + 'b' * 64
SERVICES = 'db auth rest db-init backend frontend proxy storage storage-init'.split()


class Boundary:
    def __init__(self, fail=None):
        self.fail = fail
        self.commands = []
        self.requests = []
        self.work = None
        self.upload = None
        self.down = False
        self.last_deadline = None
        self.before_down = None
        self.secrets = ['NEVER-LOG-THIS', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature',
                        'cookie-secret', 'postgres://user:connection-secret@host/db',
                        'assignment-secret', 'opaque-secret']
        self.noise = '\n'.join(self.secrets) + '\nCookie: session=cookie-secret\nPASSWORD = assignment-secret'


    def popen(self, argv, **kw):
        self.commands.append(argv)
        assert kw['cwd'] == SCRIPT.resolve().parents[1]
        assert kw['start_new_session']
        assert 'STAGING_JWT_SECRET' not in kw['env']
        result = ''
        rc = 0
        if argv[0] == 'git':
            result = ('1d8ae26399ce14b994661ce0febd5463603be294\n'
                      'b46cbcc23c55992602783f1d6c0585df14d47634\n')
        elif 'image' in argv and 'inspect' in argv:
            result = argv[-1] if argv[-1].startswith('sha256:') else BACK
        elif '--env-file' in argv:
            self.work = Path(argv[argv.index('--env-file') + 1]).parent
            assert (self.work / 'synthetic.env').stat().st_mode & 0o777 == 0o600
            override = (self.work / 'images.yml').read_text()
            assert override == f'services:\n  backend:\n    image: {BACK}\n  frontend:\n    image: {FRONT}\n'
            if 'create' in argv:
                assert '--no-build' in argv and argv[argv.index('--pull') + 1] == 'never'
                if self.fail == 'signal':
                    os.kill(os.getpid(), signal.SIGTERM)
                if self.fail == 'up':
                    rc = 1
            if 'start' in argv and self.fail and self.fail.startswith('start'):
                rc = 1
                self.secrets.extend(line.split('=', 1)[1] for line in
                                    (self.work / 'synthetic.env').read_text().splitlines()
                                    if any(key in line.split('=', 1)[0] for key in
                                           ('PASSWORD', 'SECRET', 'KEY')))
                self.noise += '\n' + '\n'.join(self.secrets)
            if 'down' in argv:
                self.before_down = json.loads(next(self.work.parent.glob('*-receipt.json')).read_text())
                self.down = True
                if self.fail == 'down':
                    rc = 1
            if 'ps' in argv:
                result = json.dumps([
                    {'Service': s, 'State': 'exited' if s.endswith('init') else 'running',
                     'ExitCode': 1 if self.fail == 'readiness' and s == 'db-init' else 0,
                     'Health': 'healthy' if s in ('db', 'auth', 'backend', 'frontend', 'proxy') else '',
                     'ID': 'c' * 64 if s != 'frontend' else 'd' * 64}
                    for s in SERVICES])
        elif 'ps' in argv and '--no-trunc' in argv:
            assert not self.down
            labels = [argv[i + 1] for i, arg in enumerate(argv) if arg == '--filter']
            assert len(labels) == 3
            assert 'label=com.litt.recovery.owner=' + self.work.name[len('litt-g-smoke-'):-len('-private')] in labels
            assert 'label=com.docker.compose.project=' + self.work.name[:-len('-private')] in labels
            service = labels[-1].split('=')[-1]
            assert service in SERVICES
            if self.fail == 'start_diagnostic_error':
                raise OSError(self.noise)
            if self.fail == 'start_diagnostic_timeout':
                raise subprocess.TimeoutExpired(argv, 8, output=self.noise, stderr=self.noise)
            result = 'c' * 64 if service == 'db-init' else ''
            if self.fail == 'start_duplicate_id':
                result = 'c' * 64 + '\n' + 'd' * 64
            if self.fail == 'start_untrusted_id':
                result = self.noise
        elif 'container' in argv and 'inspect' in argv:
            assert not self.down
            assert argv[-1] == 'c' * 64
            template = argv[argv.index('--format') + 1]
            for key in ('com.litt.recovery.owner', 'com.docker.compose.project', 'com.docker.compose.service'):
                assert '(eq (index .Config.Labels "' + key + '") "' in template
            assert '.State.Error' not in template and '.State.Health.Log' not in template
            result = json.dumps({'state': 'exited', 'exit_code': 66, 'oom_killed': False,
                                 'health': '', 'error': self.noise[:200]})
            if self.fail == 'start_oom':
                result = json.dumps({'state': 'exited', 'exit_code': 137, 'oom_killed': True, 'health': ''})
            if self.fail == 'start_bad_facts':
                result = json.dumps(dict.fromkeys(('state', 'exit_code', 'oom_killed', 'health'), self.noise))
        elif 'inspect' in argv:
            result = FRONT if argv[-1] == 'd' * 64 else BACK
        elif self.down and self.fail == 'query_error' and 'com.litt.recovery.owner=' in argv[-1]:
            rc = 1
        elif self.down and self.fail in ('containers', 'volumes', 'networks'):
            match = {'containers': 'ps', 'volumes': 'volume', 'networks': 'network'}[self.fail]
            if match in argv:
                result = 'e' * 64
        obj = unittest.mock.Mock(pid=99999999, returncode=rc)
        obj.communicate.return_value = (result.encode(), (self.noise + '\nport is already allocated').encode())
        if self.fail == 'timeout' and 'create' in argv:
            obj.communicate.side_effect = [subprocess.TimeoutExpired(argv, 1), (b'', b'')]
        return obj

    def transport(self, request):
        path = request.selector
        self.requests.append((request.method, path, request.get_header('Cookie')))
        headers = email.message.Message()
        status = 200
        payload = {'ok': True}
        if path == '/':
            status = 307
            headers['Location'] = '/assistant'  # frontend/src/app/page.tsx
        if path.startswith('/api/'):
            assert request.get_header('Origin').startswith('http://127.0.0.1:')
        if path == '/api/auth/signup':
            status = 201
            payload = {'user': {'id': '11111111-1111-4111-8111-111111111111'}, 'requiresEmailConfirmation': False}
            if self.fail != 'missing_cookie':
                headers['Set-Cookie'] = 'session=synthetic-cookie; Path=/; HttpOnly'
        elif path == '/api/auth/login':
            payload = {'user': {'id': '11111111-1111-4111-8111-111111111111'}}
            if self.fail != 'missing_cookie':
                headers['Set-Cookie'] = 'session=synthetic-cookie; Path=/; HttpOnly'
        elif path == '/api/auth/session':
            status = 200 if request.get_header('Cookie') else 401
            payload = {'user': {'id': '11111111-1111-4111-8111-111111111111'}}
        elif path == '/api/auth/logout':
            status = 204
            headers['Set-Cookie'] = 'session=; Max-Age=0; Path=/'
        elif path == '/api/user/onboarding' or (path == '/api/user/profile' and request.method == 'GET'):
            payload = {'onboardingComplete': True, 'onboardingVersion': 1, 'organisation': 'Synthetic Smoke'}
        elif path == '/api/projects' and request.method == 'POST':
            status = 201
            payload = {'id': '22222222-2222-4222-8222-222222222222', 'name': 'Synthetic Smoke'}
        elif path.endswith('/documents') and request.method == 'POST':
            self.upload_timeout = request.timeout
            if self.fail == 'http_timeout_direct':
                raise TimeoutError('NEVER-LOG-THIS')
            if self.fail == 'http_timeout_wrapped':
                raise urllib.error.URLError(TimeoutError('NEVER-LOG-THIS'))
            status = 201
            self.upload = request.data.split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n--', 1)[0]
            payload = {'id': '33333333-3333-4333-8333-333333333333', 'status': 'ready'}
        elif path.endswith('/documents'):
            payload = [{'id': '33333333-3333-4333-8333-333333333333'}]
        if self.fail == 'redirect' and path == '/login':
            status = 302
            headers['Location'] = 'https://external.invalid/NEVER-LOG-THIS'
        if self.fail == path:
            status = 500
            payload = {'error': 'NEVER-LOG-THIS', 'access_token': 'SECRET-TOKEN'}
        raw = self.upload if path.endswith('/docx') else json.dumps(payload).encode()
        if self.fail == 'slow_http' and path == '/login':
            os.kill(os.getpid(), signal.SIGALRM)
        if self.fail == 'bytes' and path.endswith('/docx'):
            raw = b'wrong bytes'
        response = urllib.response.addinfourl(io.BytesIO(raw), headers, request.full_url, status)
        response.msg = 'synthetic'
        return response


class SmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if SCRIPT.exists():
            spec = importlib.util.spec_from_file_location('smoke', SCRIPT)
            cls.runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.runner)

    def test_00_contract_real_cli(self):
        with tempfile.TemporaryDirectory() as output:
            proc = subprocess.run([sys.executable, str(SCRIPT.resolve()), '--contract-only',
                                   '--backend-image', BACK, '--frontend-image', FRONT,
                                   '--output-dir', output], capture_output=True, timeout=15, cwd=output)
            self.assertEqual(proc.returncode, 0, proc.stderr.decode())
            receipt = json.loads(next(Path(output).glob('*-receipt.json')).read_text())
            self.assertEqual(receipt['status'], 'CONTRACT_ONLY')
            self.assertFalse(receipt['runtime_exercised'])

    def exercise(self, failure=None, contract=False):
        boundary = Boundary(failure)
        with tempfile.TemporaryDirectory() as output, contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(self.runner.subprocess, 'Popen', boundary.popen))
            stack.enter_context(patch.object(self.runner.os, 'killpg'))
            sock = stack.enter_context(patch.object(self.runner.socket, 'socket'))
            sock.return_value.getsockname.return_value = ('127.0.0.1', 43127)
            sock.return_value.__enter__.return_value.connect_ex.return_value = 0 if failure == 'listener' else 111
            stack.enter_context(patch('urllib.request.HTTPHandler.http_open', lambda _, req: boundary.transport(req)))
            if failure == 'files':
                stack.enter_context(patch.object(self.runner.shutil, 'rmtree', side_effect=OSError('NEVER-LOG-THIS')))
            if failure == 'prepare_signal':
                original_mkdir = Path.mkdir

                def signalled_mkdir(path, *args, **kwargs):
                    result = original_mkdir(path, *args, **kwargs)
                    if path.name.endswith('-private'):
                        os.kill(os.getpid(), signal.SIGTERM)
                    return result

                stack.enter_context(patch.object(Path, 'mkdir', signalled_mkdir))
            if failure in ('start_save_error', 'start_persistent_save_error'):
                original_save = self.runner.Runner.save
                failed = False
                def save(runner):
                    nonlocal failed
                    if 'start_diagnostics' in runner.receipt and (not failed or failure == 'start_persistent_save_error'):
                        failed = True
                        raise OSError(boundary.noise)
                    return original_save(runner)
                stack.enter_context(patch.object(self.runner.Runner, 'save', save))
            stream = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            rc = self.runner.main(['--contract-only' if contract else '--runtime',
                                   '--backend-image', BACK, '--frontend-image', FRONT, '--output-dir', output])
            boundary.final_receipt = json.loads(stream.getvalue())
            receipt = json.loads(next(Path(output).glob('*-receipt.json')).read_text())
            evidence = json.dumps(receipt) + stream.getvalue()
            if failure and failure.startswith('start'):
                evidence += ''.join(path.read_text() for path in Path(output).rglob('*') if path.is_file())
                for secret in boundary.secrets:
                    self.assertNotIn(secret, evidence)
            for forbidden in ('NEVER-LOG-THIS', 'SECRET-TOKEN', 'synthetic-cookie'):
                self.assertNotIn(forbidden, evidence)
            if boundary.work and failure != 'files':
                self.assertFalse(boundary.work.exists())
            return rc, receipt, boundary

    def test_start_failure_diagnosed_and_saved_before_down(self):
        rc, receipt, boundary = self.exercise('start')
        self.assertEqual(rc, 1)
        self.assertEqual(receipt['error'], 'subprocess_exit')
        self.assertEqual(receipt['subprocess_exit_code'], 1)
        self.assertEqual(receipt['stage'], 'start')
        self.assertTrue(all(receipt['cleanup'].values()))
        diagnostic = receipt['start_diagnostics']
        self.assertEqual(boundary.before_down['start_diagnostics'], diagnostic)
        self.assertEqual(diagnostic['signatures'], ['port_unavailable'])
        self.assertEqual(set(diagnostic['services']), set(SERVICES))
        self.assertEqual(diagnostic['services']['db-init'], {
            'container_id': 'c' * 64, 'state': 'exited', 'exit_code': 66,
            'oom_killed': False, 'health': '', 'classification': 'schema_unavailable'})
        self.assertLess(len(json.dumps(diagnostic)), 4096)

    def test_diagnostic_failures_keep_start_error_and_cleanup(self):
        for failure in ('start_diagnostic_error', 'start_diagnostic_timeout', 'start_untrusted_id',
                        'start_duplicate_id', 'start_bad_facts'):
            with self.subTest(failure=failure):
                rc, receipt, boundary = self.exercise(failure)
                self.assertEqual(rc, 1)
                self.assertEqual(receipt['error'], 'subprocess_exit')
                self.assertEqual(receipt['subprocess_exit_code'], 1)
                self.assertTrue(all(receipt['cleanup'].values()))
                self.assertEqual(receipt['start_diagnostics']['services']['db-init']['classification'],
                                 'diagnostic_unavailable')
                if failure in ('start_untrusted_id', 'start_duplicate_id'):
                    self.assertFalse(any('container' in c and 'inspect' in c for c in boundary.commands))

    def test_diagnostics_do_not_spend_cleanup_reserve(self):
        original = self.runner.Runner.command
        def command(runner, argv, timeout=30):
            if argv[-1] == 'start':
                runner.deadline = time.monotonic() - 1
                raise self.runner.SmokeFailure('subprocess_timeout')
            return original(runner, argv, timeout)
        with patch.object(self.runner.Runner, 'command', command):
            rc, receipt, boundary = self.exercise('start')
        self.assertEqual(rc, 1)
        self.assertEqual(receipt['error'], 'subprocess_timeout')
        self.assertEqual(receipt['start_diagnostics']['status'], 'budget_exhausted')
        self.assertFalse(any('--no-trunc' in c for c in boundary.commands))
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_diagnostic_persistence_error_does_not_mask_start_or_skip_down(self):
        rc, receipt, boundary = self.exercise('start_save_error')
        self.assertEqual(rc, 1)
        self.assertEqual(receipt['error'], 'subprocess_exit')
        self.assertEqual(receipt['subprocess_exit_code'], 1)
        self.assertEqual(receipt['start_diagnostics']['status'], 'diagnostic_unavailable')
        self.assertTrue(boundary.down)
        self.assertTrue(all(receipt['cleanup'].values()))

    def test_persistent_receipt_failure_keeps_original_error_in_stdout(self):
        rc, _, boundary = self.exercise('start_persistent_save_error')
        self.assertEqual(rc, 1)
        self.assertTrue(boundary.down)
        self.assertEqual(boundary.final_receipt['error'], 'subprocess_exit')
        self.assertEqual(boundary.final_receipt['subprocess_exit_code'], 1)
        self.assertTrue(all(boundary.final_receipt['cleanup'].values()))

    def test_oom_evidence_is_distinct_from_init_exit(self):
        _, receipt, _ = self.exercise('start_oom')
        fact = receipt['start_diagnostics']['services']['db-init']
        self.assertEqual(fact['classification'], 'oom_killed')
        self.assertIs(fact['oom_killed'], True)
        self.assertEqual(fact['exit_code'], 137)

    def test_diagnostic_calls_share_a_bounded_work_deadline(self):
        runner = object.__new__(self.runner.Runner)
        runner.deadline, runner.owner, runner.project = 110, 'owner', 'project'
        runner.docker, runner.receipt = ['docker'], {}
        now = [100]
        calls = []
        def command(argv, timeout):
            calls.append(timeout)
            now[0] += timeout + 3
            raise self.runner.SmokeFailure('subprocess_timeout')
        runner.command = command
        runner.save = lambda: None
        with patch.object(self.runner.time, 'monotonic', side_effect=lambda: now[0]):
            runner.diagnose_start(self.runner.SmokeFailure('subprocess_exit', 1))
        self.assertEqual(calls, [7])
        self.assertEqual(now[0], 110)
        self.assertEqual(runner.deadline, 110)
        self.assertEqual(runner.receipt['start_diagnostics']['status'], 'budget_exhausted')

    def test_stderr_signature_prefix_is_bounded_and_has_no_retained_text(self):
        self.assertEqual(self.runner.failure_signatures(b'x' * 16384 + b'permission denied'), ())
        for secret in Boundary().secrets:
            self.assertEqual(self.runner.failure_signatures(
                (secret + '\nno space left on device\n' + secret).encode()), ('disk_full',))

    def test_http_socket_timeout_is_named_without_error_text(self):
        for failure in ('http_timeout_direct', 'http_timeout_wrapped'):
            with self.subTest(failure=failure):
                rc, receipt, _ = self.exercise(failure)
                self.assertEqual(rc, 1)
                self.assertEqual(receipt['stage'], 'document_upload')
                self.assertEqual(receipt['error'], 'http_socket_timeout')
                self.assertTrue(all(receipt['cleanup'].values()))
                self.assertNotIn('NEVER-LOG-THIS', json.dumps(receipt))

    def test_receipt_identifies_the_actual_proxy_config(self):
        import hashlib
        _, receipt, _ = self.exercise()
        proxy = SCRIPT.resolve().parents[1] / 'docker/staging/proxy.conf'
        self.assertEqual(receipt['source']['proxy_sha256'], hashlib.sha256(proxy.read_bytes()).hexdigest())

    def test_runtime_stages_and_cookie_session(self):
        rc, receipt, boundary = self.exercise()
        self.assertEqual(boundary.upload_timeout, 90)
        self.assertEqual(rc, 0)
        self.assertEqual(receipt['status'], 'PASS')
        self.assertTrue(boundary.down)
        self.assertTrue(receipt['cleanup']['files'])
        self.assertEqual(len(receipt['checks']), 50)
        sessions = [cookie for _, path, cookie in boundary.requests if path == '/api/auth/session']
        self.assertEqual(sessions, [None, 'session=synthetic-cookie', 'session=synthetic-cookie', None])
        self.assertTrue(boundary.upload.startswith(b'PK'))

    def test_serial_creation_is_separate_from_startup(self):
        rc, _, boundary = self.exercise()
        self.assertEqual(rc, 0)
        commands = [cmd for cmd in boundary.commands if 'compose' in cmd]
        self.assertTrue(all('--parallel' in cmd and cmd[cmd.index('--parallel') + 1] == '1'
                            for cmd in commands))
        creates = [i for i, cmd in enumerate(commands) if 'create' in cmd]
        starts = [i for i, cmd in enumerate(commands) if 'start' in cmd]
        self.assertEqual(len(creates), 1)
        self.assertEqual(len(starts), 1)
        self.assertLess(creates[0], starts[0])
        self.assertFalse(any('up' in cmd for cmd in commands))

    def test_contract_never_calls_docker_or_http(self):
        rc, _, boundary = self.exercise(contract=True)
        self.assertEqual(rc, 0)
        self.assertFalse(boundary.requests)
        self.assertTrue(all(cmd[0] == 'git' for cmd in boundary.commands))

    def test_independent_cleanup_failures_are_fatal(self):
        for failure in ('down', 'containers', 'volumes', 'networks', 'listener', 'query_error', 'files'):
            with self.subTest(failure=failure):
                rc, receipt, boundary = self.exercise(failure)
                self.assertEqual(rc, 1)
                self.assertEqual(receipt['status'], 'FAIL')
                self.assertEqual(receipt['cleanup']['files'], failure != 'files')
                self.assertTrue(boundary.down)
                for resource in ('containers', 'volumes', 'networks', 'listener'):
                    self.assertIn(resource, receipt['cleanup'])
                queries = [cmd for cmd in boundary.commands if '--filter' in cmd]
                self.assertEqual(len(queries), 12)
                self.assertTrue(all('label=com.' in cmd[-1] for cmd in queries))

    def test_stage_failures_cleanup_and_preserve_stage(self):
        for failure in ('up', 'readiness', '/api/auth/signup', '/api/user/onboarding', 'bytes', 'signal', 'timeout', 'missing_cookie', 'redirect', 'slow_http'):
            with self.subTest(failure=failure):
                rc, receipt, boundary = self.exercise(failure)
                self.assertEqual(rc, 1)
                self.assertEqual(receipt['status'], 'FAIL')
                self.assertNotEqual(receipt['stage'], 'complete')
                self.assertTrue(boundary.down)
                self.assertTrue(all(receipt['cleanup'].values()))


    def test_signal_during_directory_creation_cleans_registered_path(self):
        rc, receipt, boundary = self.exercise('prepare_signal')
        self.assertEqual(rc, 1)
        self.assertFalse(boundary.down)
        self.assertTrue(receipt['cleanup']['files'])
        self.assertEqual(receipt['error'], 'interrupted')

    def test_import_has_no_mutation(self):
        spec = importlib.util.spec_from_file_location('smoke_import', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        with patch('subprocess.Popen', side_effect=AssertionError('process on import')), \
                patch('pathlib.Path.mkdir', side_effect=AssertionError('mkdir on import')), \
                patch('signal.signal', side_effect=AssertionError('signal on import')):
            spec.loader.exec_module(module)

    def test_timeout_kills_descendant_pipe_holder(self):
        with tempfile.TemporaryDirectory() as output:
            pidfile = Path(output) / 'child.pid'
            code = ("import subprocess, sys, time; from pathlib import Path; "
                    "p=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                    "Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)")
            started = time.monotonic()
            with self.assertRaisesRegex(self.runner.SmokeFailure, 'subprocess_timeout'):
                self.runner.run_process([sys.executable, '-c', code, str(pidfile)],
                                        {'PATH': os.environ['PATH']}, 1)
            self.assertLess(time.monotonic() - started, 5)
            pid = int(pidfile.read_text())
            statefile = Path(f'/proc/{pid}/stat')
            for _ in range(50):
                if not statefile.exists() or statefile.read_text().split()[2] == 'Z':
                    break
                time.sleep(0.02)
            else:
                self.fail('descendant survived process-group timeout')

    def test_output_in_repository_rejected_without_mutation(self):
        with patch.object(self.runner.Path, 'mkdir') as mkdir, \
                contextlib.redirect_stdout(io.StringIO()):
            rc = self.runner.main(['--contract-only', '--backend-image', BACK,
                                   '--frontend-image', FRONT, '--output-dir', str(SCRIPT.parent)])
        self.assertEqual(rc, 1)
        mkdir.assert_not_called()

    def test_cli_requires_image_ids_and_exclusive_modes(self):
        for extra in (['--backend-image', 'secret-not-an-image'], ['--runtime', '--contract-only']):
            with tempfile.TemporaryDirectory() as output, contextlib.redirect_stderr(io.StringIO()) as err:
                with self.assertRaises(SystemExit) as result:
                    self.runner.main(['--backend-image', BACK, '--frontend-image', FRONT,
                                      '--output-dir', output] + extra)
                self.assertEqual(result.exception.code, 2)
                self.assertNotIn('secret-not-an-image', err.getvalue())
                self.assertFalse(list(Path(output).iterdir()))


if __name__ == '__main__':
    unittest.main()
