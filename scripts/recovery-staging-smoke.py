#!/usr/bin/env python3
"""Owned, local full-application smoke; stdlib only, Linux/POSIX main thread.

Default is contract-only; --runtime explicitly permits the local Docker daemon.
Only compose.staging.yml is used, with a two-image override. No build, pull,
provider/Drive request, row deletion, backup, restore, or aggregate parity gate.
Receipts contain allowlisted evidence, never logs, bodies, environment or cookies.

Route/fixture provenance at the recorded source revision:
  docker/staging/proxy.conf -> frontend/src/app/api/[...path]/route.ts (Next BFF)
  backend/src/routes/auth.ts: signup/login/session/logout (cookie sessions)
  backend/src/routes/user.ts: profile/onboarding; e2e/onboarding.ts: skip with {}
  backend/src/routes/projects.ts: POST /, POST/GET /:projectId/documents
  backend/src/routes/documents.ts: GET /:documentId/docx (original stored bytes)
  backend/src/lib/convert.ts: local LibreOffice only, conversion is best effort.
The minimal synthetic DOCX below is generated, not a private repository fixture.
"""
import argparse
import base64
import errno
import hashlib
import hmac
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_SHA256 = 'd6646af51d5949b96a5809029e01850d321680f855fce7a2ca8025baec6bc5fd'
SERVICES = ('db', 'auth', 'rest', 'db-init', 'backend', 'frontend', 'proxy', 'storage', 'storage-init')
HEALTHY = {'db', 'auth', 'backend', 'frontend', 'proxy'}
INIT = {'db-init', 'storage-init'}
IMAGE_ID = re.compile(r'sha256:[0-9a-f]{64}\Z')


class SmokeFailure(Exception):
    """Only fixed, local error codes may enter the receipt."""

    def __init__(self, code, exit_code=None, signatures=()):
        super().__init__(code)
        self.exit_code = exit_code
        self.signatures = signatures


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never follow a server-controlled destination, even loopback.


def synthetic_docx():
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?>'
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                         '<Default Extension="xml" ContentType="application/xml"/>'
                         '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                         '</Types>')
        archive.writestr('_rels/.rels', '<?xml version="1.0"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                         '</Relationships>')
        archive.writestr('word/document.xml', '<?xml version="1.0"?>'
                         '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                         '<w:body><w:p><w:r><w:t>Synthetic smoke agreement. No client data.</w:t>'
                         '</w:r></w:p><w:sectPr/></w:body></w:document>')
    return out.getvalue()


def failure_signatures(stderr):
    # No text is retained, even after redaction. Inspect only a bounded prefix;
    # these codes are hints, not proof that stderr identified the root cause.
    sample = stderr[:16384].lower()
    return tuple(code for needle, code in (
        (b'port is already allocated', 'port_unavailable'),
        (b'address already in use', 'address_in_use'),
        (b'cannot connect to the docker daemon', 'daemon_unavailable'),
        (b'no space left on device', 'disk_full'),
        (b'permission denied', 'permission_denied'),
        (b'container is unhealthy', 'dependency_unhealthy'),
    ) if needle in sample) + tuple(
        'beta_evidence_' + phase + '_calls_' + str(calls)
        for phase in ('input', 'auth', 'source', 'provider', 'append', 'readback')
        for calls in (0, 1)
        if ('beta_evidence_failed:' + phase + ':' + str(calls) + '\n').encode() in sample
    )


def run_process(argv, env, timeout):
    """Reap the child and kill its process group on success, error, or signal.

    A new session covers ordinary descendants (including inherited pipe holders).
    Deliberately daemonized/setsid children are outside this CLI-process guarantee;
    Docker containers are separately removed and verified by ownership labels.
    """
    proc = None
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        try:
            proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, start_new_session=True)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise SmokeFailure('subprocess_timeout') from None
        if proc.returncode:
            raise SmokeFailure('subprocess_exit', proc.returncode, failure_signatures(stderr))
        return stdout.decode('utf-8', errors='strict').strip()
    finally:
        if proc is not None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # After SIGKILL this also closes pipes held by ordinary descendants.
            proc.communicate(timeout=3)


class Runner:
    def __init__(self, args):
        self.args = args
        self.owner = secrets.token_hex(24)
        self.project = 'litt-g-smoke-' + self.owner
        self.output = Path(args.output_dir).expanduser().resolve()
        # Identity/path registration precedes ALL mutation; no mkdtemp race.
        self.work = self.output / (self.project + '-private')
        self.receipt_path = self.output / (self.project + '-receipt.json')
        self.envfile = self.work / 'synthetic.env'
        self.override = self.work / 'images.yml'
        self.port = None
        self.port_guard = None
        self.started = False
        self.private_created = False
        self.deadline = time.monotonic() + args.timeout_seconds - 1200
        self.env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG') if key in os.environ}
        self.env['COMPOSE_DISABLE_ENV_FILE'] = '1'
        self.docker = ['docker', '--host', 'unix://' + args.docker_socket]
        self.compose = self.docker + ['compose', '--parallel', '1', '--project-directory', str(ROOT),
                                     '--project-name', self.project, '--env-file', str(self.envfile),
                                     '-f', str(ROOT / 'compose.staging.yml'), '-f', str(self.override)]
        self.cookies = http.cookiejar.CookieJar()
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                 urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect())
        self.receipt = {
            'owner': self.owner, 'project': self.project, 'stage': 'preflight', 'status': 'FAIL',
            'runtime_exercised': False, 'runtime_attempted': False, 'checks': [], 'cleanup': {},
            'images': {'backend': args.backend_image, 'frontend': args.frontend_image},
            'scope': 'Local Compose frontend/backend/Auth/onboarding/project/DOCX round trip',
            'limitations': ['No browser rendering assertion', 'No provider/AI/Drive calls requested',
                            'No PDF conversion assertion', 'No organization cardinality assertion',
                            'No backup/restore, migration-upgrade or aggregate Phase3 proof',
                            'No runtime proof in contract-only mode',
                            'Existing images are supplied by the caller; source provenance is not attested'],
        }

    def save(self):
        # Exclusive identity, atomic replace; no command output or response body.
        tmp = self.receipt_path.with_suffix('.tmp')
        with tmp.open('w', encoding='utf-8') as handle:
            json.dump(self.receipt, handle, indent=2)
            handle.write('\n')
        tmp.replace(self.receipt_path)

    def command(self, argv, timeout=30):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise SmokeFailure('stage_deadline')
        return run_process(argv, self.env, min(timeout, remaining))

    def check(self, name, ok, **evidence):
        self.receipt['checks'].append({'name': name, 'ok': bool(ok), **evidence})
        self.save()
        if not ok:
            raise SmokeFailure('check_failed')

    def stage(self, name):
        self.receipt['stage'] = name
        self.save()

    def prepare(self):
        if self.output == ROOT or ROOT in self.output.parents:
            raise SmokeFailure('output_inside_repository')
        self.output.mkdir(parents=True, exist_ok=True)
        self.save()
        source = self.command(['git', 'rev-parse', 'HEAD', 'HEAD^{tree}']).splitlines()
        if len(source) != 2 or not all(re.fullmatch('[0-9a-f]{40}', item) for item in source):
            raise SmokeFailure('invalid_source_identity')
        self.receipt['source'] = {'head': source[0], 'tree': source[1],
                                  'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                  'proxy_sha256': hashlib.sha256((ROOT / 'docker/staging/proxy.conf').read_bytes()).hexdigest()}
        digest = hashlib.sha256((ROOT / 'compose.staging.yml').read_bytes()).hexdigest()
        self.receipt['source']['compose_sha256'] = digest
        self.check('frozen_compose', digest == COMPOSE_SHA256)
        self.check('explicit_image_ids', bool(IMAGE_ID.fullmatch(self.args.backend_image)
                                            and IMAGE_ID.fullmatch(self.args.frontend_image)))
        if not self.args.runtime:
            self.receipt['status'] = 'CONTRACT_ONLY'
            return
        self.stage('prepare')
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            self.work.mkdir(mode=0o700)
            self.private_created = True
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        self.port_guard = socket.socket()
        self.port_guard.bind(('127.0.0.1', 0))
        self.port = self.port_guard.getsockname()[1]
        self.receipt['port'] = self.port
        self.origin = f'http://127.0.0.1:{self.port}'
        values = {'STAGING_OWNER': self.owner, 'STAGING_PROXY_PORT': str(self.port),
                  'STAGING_PUBLIC_URL': self.origin, 'STAGING_DISABLE_SIGNUP': 'false'}
        for name in ('POSTGRES_PASSWORD', 'JWT_SECRET', 'DOWNLOAD_SIGNING_SECRET',
                     'USER_API_KEYS_ENCRYPTION_SECRET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'):
            values['STAGING_' + name] = secrets.token_hex(32)
        for role, key in (('anon', 'STAGING_SUPABASE_ANON_KEY'),
                          ('service_role', 'STAGING_SUPABASE_SERVICE_ROLE_KEY')):
            def b64(data):
                return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')
            body = b64(b'{"alg":"HS256","typ":"JWT"}') + '.' + b64(json.dumps({
                'role': role, 'iss': 'supabase', 'iat': int(time.time()),
                'exp': int(time.time()) + self.args.timeout_seconds + 600}).encode())
            values[key] = body + '.' + b64(hmac.new(values['STAGING_JWT_SECRET'].encode(),
                                                   body.encode(), hashlib.sha256).digest())
        with self.envfile.open('x', encoding='utf-8') as handle:
            self.envfile.chmod(0o600)
            handle.write(''.join(key + '=' + value + '\n' for key, value in values.items()))
        self.override.write_text('services:\n  backend:\n    image: ' + self.args.backend_image
                                 + '\n  frontend:\n    image: ' + self.args.frontend_image + '\n')
        self.override.chmod(0o600)
        self.command(self.compose + ['config', '--quiet'])
        for name, image in self.receipt['images'].copy().items():
            actual = self.command(self.docker + ['image', 'inspect', '--format', '{{.Id}}', image])
            self.check('existing_image_' + name, actual == image)
        # Resolve installed infra identities without pulling, preserving the frozen tags.
        infra = ('supabase/postgres:17.6.1.136', 'supabase/gotrue:v2.189.0',
                 'postgrest/postgrest:v14.12', 'nginx:1.27.5-alpine',
                 'minio/minio:RELEASE.2025-09-07T16-13-09Z', 'amazon/aws-cli:2.27.41')
        self.receipt['infra_images'] = {}
        for tag in infra:
            actual = self.command(self.docker + ['image', 'inspect', '--format', '{{.Id}}', tag])
            if not IMAGE_ID.fullmatch(actual):
                raise SmokeFailure('invalid_image_identity')
            self.receipt['infra_images'][tag] = actual
        for resource in ('containers', 'volumes', 'networks'):
            self.check('unused_identity_' + resource, self.absent(resource))

    def absent(self, resource):
        args = {'containers': ['ps', '--all', '--quiet'], 'volumes': ['volume', 'ls', '--quiet'],
                'networks': ['network', 'ls', '--quiet']}[resource]
        # Separate queries prove absence for EITHER exact label, not just intersection.
        empty = True
        for label in ('com.litt.recovery.owner=' + self.owner,
                      'com.docker.compose.project=' + self.project):
            try:
                result = self.command(self.docker + args + ['--filter', 'label=' + label], timeout=8)
                empty = not result and empty
            except Exception:
                empty = False
        return empty

    def diagnose_start(self, error):
        # Separate, capped work budget; never borrow cleanup's reserved 1200s.
        deadline = min(self.deadline, time.monotonic() + 30)
        diagnostic = {
            'status': 'complete',
            'signatures': list(error.signatures) if isinstance(error, SmokeFailure) else [],
            'services': {},
        }
        self.receipt['start_diagnostics'] = diagnostic

        def query(argv):
            remaining = deadline - time.monotonic() - 3  # child reap allowance
            if remaining <= 0:
                raise SmokeFailure('diagnostic_budget')
            return self.command(argv, timeout=min(8, remaining))

        for name in SERVICES:
            fact = {'classification': 'diagnostic_unavailable'}
            diagnostic['services'][name] = fact
            try:
                # AND all exact ownership/service labels. Never discover by name
                # prefix, inspect a guessed name, or inspect a Compose ps result.
                labels = {
                    'com.litt.recovery.owner': self.owner,
                    'com.docker.compose.project': self.project,
                    'com.docker.compose.service': name,
                }
                args = self.docker + ['ps', '--all', '--quiet', '--no-trunc']
                for key, value in labels.items():
                    args += ['--filter', 'label=' + key + '=' + value]
                cid = query(args)
                if not cid:
                    fact['classification'] = 'container_absent'
                    continue
                if not re.fullmatch('[0-9a-f]{64}', cid):
                    raise SmokeFailure('invalid_diagnostic_identity')
                # Recheck immutable ownership labels in the format expression.
                # Read only selected facts, never Config/Env, State.Error,
                # healthcheck output, mounts, or logs.
                guard = ' '.join('(eq (index .Config.Labels ' + json.dumps(key) +
                                 ') ' + json.dumps(value) + ')' for key, value in labels.items())
                template = ('{{if and ' + guard + '}}' +
                            '{"state":{{json .State.Status}},"exit_code":{{json .State.ExitCode}},'
                            '"oom_killed":{{json .State.OOMKilled}},"health":'
                            '{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}}}'
                            '{{end}}')
                raw = query(self.docker + ['container', 'inspect', '--format', template, cid])
                if len(raw) > 1024:
                    raise SmokeFailure('invalid_diagnostic_facts')
                row = json.loads(raw)
                if (row.get('state') not in ('running', 'exited', 'created', 'restarting',
                                             'paused', 'dead', 'removing') or
                        row.get('health') not in ('', 'healthy', 'unhealthy', 'starting') or
                        type(row.get('exit_code')) is not int or
                        not 0 <= row['exit_code'] <= 255 or
                        type(row.get('oom_killed')) is not bool):
                    raise SmokeFailure('invalid_diagnostic_facts')
                classification = 'no_failure_observed'
                if row['oom_killed']:
                    classification = 'oom_killed'
                elif row['state'] == 'exited' and row['exit_code']:
                    # staging-db-init.sh's explicit exits; no SQL/log text needed.
                    classification = ({64: 'init_usage_error', 65: 'schema_digest_invalid',
                                       66: 'schema_unavailable'}.get(row['exit_code'], 'init_failed')
                                      if name == 'db-init' else 'container_exit_nonzero')
                elif row['health'] == 'unhealthy':
                    classification = 'healthcheck_failed'
                elif row['state'] in ('created', 'restarting', 'dead', 'removing', 'paused'):
                    classification = 'container_not_ready'
                fact.update(container_id=cid, state=row['state'], exit_code=row['exit_code'],
                            oom_killed=row['oom_killed'], health=row['health'],
                            classification=classification)
            except Exception as failure:
                diagnostic['status'] = ('budget_exhausted' if isinstance(failure, SmokeFailure)
                                        and str(failure) == 'diagnostic_budget' else 'partial')
                # Never persist exception messages or process output.
        self.save()  # Persist causal evidence before any container removal.

    def readiness(self):
        self.stage('readiness')
        deadline = min(self.deadline, time.monotonic() + 180)
        while time.monotonic() < deadline:
            raw = self.command(self.compose + ['ps', '--all', '--format', 'json'], timeout=10)
            rows = json.loads(raw) if raw.startswith('[') else [json.loads(line) for line in raw.splitlines()]
            state = {row['Service']: row for row in rows}
            self.receipt['services'] = {
                name: {
                    'state': row.get('State') if row.get('State') in
                    ('running', 'exited', 'created', 'restarting', 'paused', 'dead', 'removing') else 'unknown',
                    'health': row.get('Health') if row.get('Health') in
                    ('healthy', 'unhealthy', 'starting', '') else 'unknown',
                    'exit_code': row.get('ExitCode') if isinstance(row.get('ExitCode'), int) else None,
                } for name, row in state.items() if name in SERVICES
            }
            self.save()
            ready = set(state) == set(SERVICES)
            for name in SERVICES:
                row = state.get(name, {})
                status, health = row.get('State'), row.get('Health')
                if status in ('dead', 'removing') or health == 'unhealthy' or (
                    status == 'exited' and (name not in INIT or row.get('ExitCode') != 0)
                ):
                    raise SmokeFailure('service_failed')
                ready = ready and (status == 'exited' and row.get('ExitCode') == 0 if name in INIT
                                   else status == 'running' and (name not in HEALTHY or health == 'healthy'))
            if ready:
                for name in SERVICES:
                    row = state[name]
                    self.check('ready_' + name, True, state=row['State'],
                               health=self.receipt['services'][name]['health'],
                               exit_code=self.receipt['services'][name]['exit_code'])
                for name in ('backend', 'frontend'):
                    cid = state[name]['ID']
                    if not re.fullmatch('[0-9a-f]{12,64}', cid):
                        raise SmokeFailure('invalid_container_identity')
                    actual = self.command(self.docker + ['inspect', '--format', '{{.Image}}', cid])
                    self.check('running_image_' + name, actual == self.receipt['images'][name])
                return
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        raise SmokeFailure('readiness_timeout')

    def http(self, name, method, path, expected=200, body=None, content_type='application/json', binary=False):
        self.stage(name)
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        req = urllib.request.Request(self.origin + path, data=body, method=method,
                                     headers={'Origin': self.origin, 'Content-Type': content_type})
        # Socket timeout alone does not bound trickle responses. ITIMER_REAL bounds
        # connect + headers + entire body, including HTTPError reads and cookie work.
        duration = min(90 if name == 'document_upload' else 20, self.deadline - time.monotonic())
        if duration <= 0:
            raise SmokeFailure('stage_deadline')
        signal.setitimer(signal.ITIMER_REAL, duration)
        try:
            try:
                response = self.client.open(req, timeout=duration)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                code = response.code
                # Failed bodies can contain secrets. Do not read or report them.
                self.check(name, code == expected, http_code=code)
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise SmokeFailure('response_too_large')
                if binary:
                    return raw
                return json.loads(raw) if raw else None
        except TimeoutError:
            raise SmokeFailure('http_socket_timeout') from None
        except urllib.error.URLError as error:
            code = 'http_socket_timeout' if isinstance(error.reason, TimeoutError) else 'http_transport_error'
            raise SmokeFailure(code) from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def application(self, keep_session=False):
        self.http('proxy_http', 'GET', '/healthz', binary=True)
        self.http('frontend_http', 'GET', '/login', binary=True)
        health = self.http('backend_http', 'GET', '/api/health')
        self.check('backend_health_payload', health.get('ok') is True)
        self.http('auth_health', 'GET', '/auth/v1/health')
        self.http('anonymous_session', 'GET', '/api/auth/session', expected=401)
        credentials = {'email': self.owner + '@example.invalid', 'password': secrets.token_hex(32)}
        signup = self.http('signup', 'POST', '/api/auth/signup', expected=201, body=credentials)
        user_id = str(uuid.UUID(signup['user']['id']))
        self.check('signup_session_issued', signup.get('requiresEmailConfirmation') is False and bool(self.cookies))
        session = self.http('signup_session', 'GET', '/api/auth/session')
        self.check('signup_session_identity', session['user']['id'] == user_id)
        self.http('logout_before_login', 'POST', '/api/auth/logout', expected=204, body={})
        login = self.http('login', 'POST', '/api/auth/login', body=credentials)
        self.check('login_identity', login['user']['id'] == user_id)
        session = self.http('login_session', 'GET', '/api/auth/session')
        self.check('login_session_identity', session['user']['id'] == user_id)
        self.http('profile_create', 'POST', '/api/user/profile', body={})
        self.http('profile_update', 'PATCH', '/api/user/profile', body={
            'displayName': 'Synthetic Smoke', 'organisation': 'Synthetic Smoke'})
        for name in ('onboarding', 'onboarding_retry'):
            profile = self.http(name, 'POST', '/api/user/onboarding', body={})
            self.check(name + '_complete', profile.get('onboardingComplete') is True
                       and profile.get('onboardingVersion') == 1)
        profile = self.http('profile_read', 'GET', '/api/user/profile')
        self.check('profile_persisted', profile.get('onboardingComplete') is True
                   and profile.get('organisation') == 'Synthetic Smoke')
        project = self.http('project_create', 'POST', '/api/projects', expected=201,
                            body={'name': 'Synthetic Smoke'})
        project_id = str(uuid.UUID(project['id']))
        document = synthetic_docx()
        boundary = secrets.token_hex(24)
        multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.docx"\r\n'
                     'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n').encode()
        multipart += document + f'\r\n--{boundary}--\r\n'.encode()
        uploaded = self.http('document_upload', 'POST', f'/api/projects/{project_id}/documents',
                             expected=201, body=multipart, content_type='multipart/form-data; boundary=' + boundary)
        document_id = str(uuid.UUID(uploaded['id']))
        self.check('document_ready', uploaded.get('status') == 'ready')
        listing = self.http('document_list', 'GET', f'/api/projects/{project_id}/documents')
        self.check('document_listed', any(row.get('id') == document_id for row in listing))
        downloaded = self.http('document_download', 'GET', f'/api/single-documents/{document_id}/docx', binary=True)
        self.check('docx_round_trip', downloaded == document, sha256=hashlib.sha256(document).hexdigest())
        if not keep_session:
            self.http('logout', 'POST', '/api/auth/logout', expected=204, body={})
            self.http('logged_out_session', 'GET', '/api/auth/session', expected=401)

    def cleanup(self):
        self.deadline = time.monotonic() + 1200
        outcomes = self.receipt['cleanup']
        # Each independent action is attempted even when an earlier one fails.
        if self.port_guard is not None:
            try:
                self.port_guard.close()
            except Exception:
                outcomes['port_guard'] = False
        if self.started:
            try:
                self.command(self.compose + ['down', '--volumes', '--remove-orphans', '--timeout', '10'], timeout=1050)
                outcomes['down'] = True
            except Exception:
                outcomes['down'] = False
            for resource in ('containers', 'volumes', 'networks'):
                try:
                    outcomes[resource] = self.absent(resource)
                except Exception:
                    outcomes[resource] = False
            try:
                with socket.socket() as sock:
                    sock.settimeout(2)
                    outcomes['listener'] = sock.connect_ex(('127.0.0.1', self.port)) == errno.ECONNREFUSED
            except Exception:
                outcomes['listener'] = False
        if self.private_created:
            for name, path in (('secrets', self.envfile), ('override', self.override)):
                try:
                    path.unlink(missing_ok=True)
                    outcomes[name] = not path.exists()
                except Exception:
                    outcomes[name] = False
        try:
            if self.private_created:
                shutil.rmtree(self.work)
            outcomes['files'] = not self.work.exists()
        except Exception:
            outcomes['files'] = False
        self.cookies.clear()
        if not all(outcomes.values()):
            self.receipt['status'] = 'FAIL'
            self.receipt['cleanup_error'] = 'cleanup_failed'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--contract-only', action='store_true')
    mode.add_argument('--runtime', action='store_true')
    parser.add_argument('--backend-image', required=True)
    parser.add_argument('--frontend-image', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--timeout-seconds', type=int, default=2700, help='Total work + reserved 1200s cleanup (1260..3600)')
    parser.add_argument('--docker-socket', default='/var/run/docker.sock', help='Absolute local Unix socket only')
    args = parser.parse_args(argv)
    if not 1260 <= args.timeout_seconds <= 3600:
        parser.error('timeout must be between 1260 and 3600 seconds')
    if not args.docker_socket.startswith('/') or '\x00' in args.docker_socket:
        parser.error('Docker socket must be an absolute local path')
    # Reject before recording untrusted CLI values in an artifact.
    if not IMAGE_ID.fullmatch(args.backend_image) or not IMAGE_ID.fullmatch(args.frontend_image):
        parser.error('application images must be complete sha256 image IDs')
    runner = Runner(args)

    def interrupted(_signum, _frame):
        raise SmokeFailure('interrupted')

    def timed_out(_signum, _frame):
        raise SmokeFailure('http_deadline')

    old = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGALRM, timed_out)
    try:
        runner.prepare()
        if args.runtime:
            runner.stage('create')
            # Register possible partial creation before invoking Compose.
            runner.started = True
            runner.receipt['runtime_attempted'] = True
            runner.save()
            runner.port_guard.close()
            runner.command(runner.compose + ['create', '--no-build', '--pull', 'never'], timeout=900)
            runner.stage('start')
            runner.command(runner.compose + ['start'], timeout=600)
            runner.receipt['runtime_exercised'] = True
            runner.readiness()
            runner.application()
            runner.receipt['status'] = 'PASS'
        runner.receipt['stage'] = 'complete'
    except Exception as error:
        runner.receipt['status'] = 'FAIL'
        runner.receipt['error'] = str(error) if isinstance(error, SmokeFailure) else 'operation_failed'
        if isinstance(error, SmokeFailure) and error.exit_code is not None:
            runner.receipt['subprocess_exit_code'] = error.exit_code
        if runner.started and runner.receipt['stage'] == 'start':
            try:
                runner.diagnose_start(error)
            except Exception:
                runner.receipt.setdefault('start_diagnostics', {})['status'] = 'diagnostic_unavailable'
                # Preserve the triggering failure; finally always runs cleanup.

    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        # Repeated termination requests cannot interrupt independent teardown steps.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            runner.cleanup()
            # Invalid output locations must never receive a receipt.
            if runner.output != ROOT and ROOT not in runner.output.parents and runner.output.is_dir():
                runner.save()
        except Exception:
            runner.receipt['status'] = 'FAIL'
            runner.receipt.setdefault('error', 'receipt_or_cleanup_failed')
        finally:
            for sig, handler in old.items():
                signal.signal(sig, handler)
    print(json.dumps(runner.receipt))
    return 0 if runner.receipt['status'] in ('PASS', 'CONTRACT_ONLY') else 1


if __name__ == '__main__':
    raise SystemExit(main())
