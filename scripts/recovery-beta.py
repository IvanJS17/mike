#!/usr/bin/env python3
"""Integrated synthetic Beta and paired recovery, local owned stacks only.

Uses the existing paired lifecycle; no remote provider, Drive or Word host.
Auth/MFA, HTTP routers, application SQL and MinIO are real in --runtime.
The AI sender/credential and external Drive are explicitly synthetic fixtures.
"""

import base64
import copy
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
import zipfile

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location(
    "beta_paired", Path(__file__).with_name("recovery-backup-restore.py")
)
assert _spec is not None and _spec.loader is not None
paired = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(paired)
Failure = paired.Failure
smoke = paired.smoke


def totp(secret, timestamp):
    if not isinstance(secret, str) or not re.fullmatch("[A-Z2-7]{16,128}", secret):
        raise Failure("invalid_totp_fixture")
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(
        key, (int(timestamp) // 30).to_bytes(8, "big"), hashlib.sha1
    ).digest()
    offset = digest[-1] & 15
    return f"{(int.from_bytes(digest[offset : offset + 4], 'big') & 0x7FFFFFFF) % 1000000:06d}"


def access_token(cookies):
    groups = {}
    for cookie in cookies:
        match = re.fullmatch(r"((?:__Host-)?mike-session)(?:\.(\d+))?", cookie.name)
        if match:
            chunks = groups.setdefault(match[1], {})
            index = None if match[2] is None else int(match[2])
            if index in chunks or index is not None and index > 15:
                raise Failure("ambiguous_auth_cookie")
            chunks[index] = cookie.value
    if len(groups) != 1:
        raise Failure("ambiguous_auth_cookie")
    chunks = next(iter(groups.values()))
    if None in chunks:
        if len(chunks) != 1:
            raise Failure("ambiguous_auth_cookie")
        raw = chunks[None]
    else:
        if sorted(chunks) != list(range(len(chunks))):
            raise Failure("incomplete_auth_cookie")
        raw = "".join(chunks[i] for i in range(len(chunks)))
    try:
        if not raw.startswith("base64-") or len(raw) > 16384:
            raise ValueError()
        raw = raw[7:]
        value = json.loads(
            base64.b64decode(raw + "=" * (-len(raw) % 4), altchars=b"-_", validate=True)
        )
        token = value["access_token"]
        if (
            not isinstance(token, str)
            or not token
            or len(token) > 8192
            or re.search(r"\s", token)
        ):
            raise ValueError()
        return (
            token  # Identity and AAL2 are independently verified by GoTrue in the CLI.
        )
    except (ValueError, KeyError, TypeError):
        raise Failure("invalid_auth_cookie") from None


class BetaRunner(paired.ObservedRunner):
    def __init__(self, args):
        super().__init__(args)
        self.fake_receipt = "/tmp/litt-beta-" + self.owner + "-drive.json"
        self.receipt["scope"] = (
            "Integrated synthetic Beta plus paired application evidence recovery"
        )
        self.receipt["limitations"] = [
            "Synthetic data and fake AI sender/credential; no real provider or DB BYOK acceptance",
            "Source evidence uses one logical page; no rendered pagination or legal validation",
            "Fake Drive remote is outside application backup; restored publication/approved bytes are checked read-only",
            "No real Word/Drive host, browser rendering, supported upgrade or full Phase3 acceptance",
            "Same-image stopped-writer local recovery only; no production RPO/RTO claim",
            "Contract/offline modes are not runtime proof",
        ]

    def review_path(self):
        return (
            "/api/projects/"
            + self.fixture["project"]
            + "/ai-executions/"
            + self.fixture["execution"]
            + "/review"
        )

    def prepare(self):
        super().prepare()
        self.mounts = {
            name: smoke.ROOT / "backend/scripts" / name
            for name in ("recovery-beta-server.cjs", "recovery-beta-evidence.cjs")
        }
        self.receipt["beta_sources"] = {
            name: hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in self.mounts.items()
        }
        self.receipt["beta_sources"]["driver"] = hashlib.sha256(
            Path(__file__).read_bytes()
        ).hexdigest()
        if self.args.runtime:
            text = "services:\n"
            for service in smoke.SERVICES:
                text += (
                    "  "
                    + service
                    + ":\n    image: "
                    + self.pins["db" if service == "db-init" else service]
                    + "\n"
                )
                if service == "backend":
                    argument = (
                        self.fake_receipt if self.role == "source" else "--read-only"
                    )
                    text += (
                        "    command: "
                        + json.dumps(
                            ["node", "/app/scripts/recovery-beta-server.cjs", argument]
                        )
                        + "\n    volumes:\n"
                    )
                    for name, path in self.mounts.items():
                        text += (
                            "      - "
                            + json.dumps(str(path) + ":/app/scripts/" + name + ":ro")
                            + "\n"
                        )
            self.override.write_text(text)
            self.command(self.compose + ["config", "--quiet"])

    def start(self, runtime_only=False):
        super().start(runtime_only)
        backend = self.resource("backend", {"running"})
        mounts = json.loads(
            self.command(
                self.docker
                + ["container", "inspect", "--format", "{{json .Mounts}}", backend]
            )
        )
        for name, source in self.mounts.items():
            bound = [m for m in mounts if m["Destination"] == "/app/scripts/" + name]
            self.check(
                "beta_readonly_mount_" + name,
                len(bound) == 1
                and bound[0]["Type"] == "bind"
                and bound[0]["Source"] == str(source)
                and bound[0]["RW"] is False,
            )
        for name, source in self.mounts.items():
            digest = self.receipt["beta_sources"][name]
            self.check(
                "beta_unchanged_" + name,
                hashlib.sha256(source.read_bytes()).hexdigest() == digest,
            )
            actual = self.command(
                self.docker + ["exec", backend, "sha256sum", "/app/scripts/" + name]
            )
            self.check(
                "beta_mounted_" + name, actual == digest + "  /app/scripts/" + name
            )
        paths = self.command(
            [
                "git",
                "ls-files",
                "-z",
                "--",
                "backend/src",
                "backend/package.json",
                "backend/package-lock.json",
            ]
        ).split("\0")
        paths = sorted(p for p in paths if p)
        manifest = [
            [p, hashlib.sha256((smoke.ROOT / p).read_bytes()).hexdigest()]
            for p in paths
        ]
        local = self.work / "source-manifest.json"
        local.write_text(
            json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
        )
        local.chmod(0o600)
        remote = "/tmp/litt-beta-source-manifest.json"
        self.copy("backend", local, remote, inbound=True)
        program = "const fs=require('fs'),c=require('crypto');const h=b=>c.createHash('sha256').update(b).digest('hex');const rows=JSON.parse(fs.readFileSync(process.argv[1]));const actual=rows.map(([p])=>[p,h(fs.readFileSync('/app/'+p.slice(8)))]);console.log(JSON.stringify({count:actual.length,sha256:h(JSON.stringify(actual))}));"
        actual = json.loads(
            self.command(self.docker + ["exec", backend, "node", "-e", program, remote])
        )
        expected = hashlib.sha256(local.read_bytes()).hexdigest()
        self.check(
            "beta_executed_source_attested",
            len(manifest) > 0
            and actual == {"count": len(manifest), "sha256": expected},
            sha256=expected,
        )

    def http(self, name, *args, **kwargs):
        result = super().http(name, *args, **kwargs)
        if name == "project_create":
            self.setup_tenancy()  # Runs before the inherited DOCX upload.
        # The session contract materializes the document only after the upload
        # is sealed, so the legacy `document_upload` handler in the base runner
        # never sees a response body to publish `fixture['document']` from.
        # The project listing is authoritative and always runs after the seal.
        if name == "document_list" and isinstance(result, list) and len(result) == 1:
            self.fixture["document"] = str(uuid.UUID(str(result[0]["id"])))
        return result

    def mfa_session(self, role, identity):
        factor = self.http(
            "beta_" + role + "_enroll",
            "POST",
            "/api/auth/mfa/enroll",
            expected=201,
            body={"friendlyName": "Synthetic Beta " + role},
        )
        factor_id = str(uuid.UUID(factor["id"]))
        challenge = self.http(
            "beta_" + role + "_challenge",
            "POST",
            "/api/auth/mfa/challenge",
            body={"factorId": factor_id},
        )
        verified = self.http(
            "beta_" + role + "_verify",
            "POST",
            "/api/auth/mfa/verify",
            body={
                "factorId": factor_id,
                "challengeId": str(uuid.UUID(challenge["id"])),
                "code": totp(factor["totp"]["secret"], time.time()),
            },
        )
        assurance = self.http(
            "beta_" + role + "_assurance", "GET", "/api/auth/mfa/assurance"
        )
        self.check(
            "beta_" + role + "_aal2",
            verified["user"]["id"] == identity and assurance["currentLevel"] == "aal2",
        )
        self.fixture["sessions"][role] = [copy.copy(c) for c in self.cookies]

    def setup_tenancy(self):
        self.stage("beta_auth_mfa_private_matter")
        f = self.fixture
        f["sessions"] = {}
        self.mfa_session("owner", f["user"])
        for role in ("reviewer", "outsider"):
            self.cookies.clear()
            result = self.http(
                "beta_" + role + "_signup",
                "POST",
                "/api/auth/signup",
                expected=201,
                body={
                    "email": role + "-" + self.owner + "@example.invalid",
                    "password": smoke.secrets.token_hex(32),
                },
            )
            f[role] = str(uuid.UUID(result["user"]["id"]))
            self.http("beta_" + role + "_profile", "POST", "/api/user/profile", body={})
            self.http(
                "beta_" + role + "_profile_name",
                "PATCH",
                "/api/user/profile",
                body={
                    "displayName": "Synthetic Beta",
                    "organisation": "Synthetic Beta",
                },
            )
            self.http(
                "beta_" + role + "_onboarding", "POST", "/api/user/onboarding", body={}
            )
            self.mfa_session(role, f[role])
        self.check(
            "beta_three_real_users",
            len({f[k] for k in ("user", "reviewer", "outsider")}) == 3,
        )
        self.restore_session(f, "owner")
        self.db_exec(["sh", "-ec", "umask 077; mkdir -m 700 /tmp/paired"])
        # Only validated synthetic IDs enter this private query file; tokens never do.
        org = self.sql(
            "SELECT onboarding_organization_id FROM public.user_profiles WHERE user_id='"
            + f["user"]
            + "';"
        )
        f["organization"] = str(uuid.UUID(org))
        workspace, matter = str(uuid.uuid4()), str(uuid.uuid4())
        f["matter"] = matter
        result = self.sql(f"""BEGIN;
INSERT INTO public.organization_memberships(organization_id,user_id,role,status) VALUES ('{org}','{f["reviewer"]}','editor','active');
INSERT INTO public.workspaces(id,organization_id,name,created_by) VALUES ('{workspace}','{org}','Synthetic Beta','{f["user"]}');
INSERT INTO public.workspace_memberships(workspace_id,user_id,role,status) VALUES
 ('{workspace}','{f["user"]}','workspace_admin','active'),('{workspace}','{f["reviewer"]}','editor','active');
INSERT INTO public.matters(id,workspace_id,name,created_by,project_id,visibility) VALUES
 ('{matter}','{workspace}','Synthetic Beta','{f["user"]}','{f["project"]}','private');
INSERT INTO public.matter_memberships(matter_id,user_id,role,status) VALUES
 ('{matter}','{f["user"]}','matter_owner','active'),('{matter}','{f["reviewer"]}','editor','active');
COMMIT;
SELECT count(*) FROM public.matters m JOIN public.workspaces w ON w.id=m.workspace_id
 JOIN public.matter_memberships mm ON mm.matter_id=m.id
 WHERE m.id='{matter}' AND m.visibility='private' AND m.project_id='{f["project"]}'
 AND w.organization_id='{org}' AND mm.user_id='{f["user"]}' AND mm.role='matter_owner' AND mm.status='active';
""")
        self.check("beta_private_matter_before_docx", result == "1")
        folder = self.http(
            "beta_folder_set",
            "PATCH",
            "/api/projects/" + f["project"] + "/matters/" + matter + "/drive-folder",
            body={"drive_folder_id": "beta_synthetic_folder"},
        )
        self.check(
            "beta_folder_persisted",
            folder["drive_folder_id"] == "beta_synthetic_folder",
        )

    def produce_evidence(self):
        self.stage("beta_catalog_seed")
        backend = self.resource("backend", {"running"})
        program = "require('tsx/cjs');const {MX_CIVIL_COMMERCIAL_SYNC_ENTRY:e}=require('/app/src/lib/recovery/workflows/mxCivilCommercialPlaybook.ts');process.stdout.write(JSON.stringify(e));"
        entry = json.loads(self.command(self.docker + ["exec", backend, "node", "-e", program]))
        self.check("beta_catalog_definition", isinstance(entry, dict)
            and entry.get("workflow_key") == "civil-commercial-mx-triage"
            and isinstance(entry.get("source_commit"), str)
            and re.fullmatch("[0-9a-f]{40}", entry["source_commit"])
            and isinstance(entry.get("content_hash"), str)
            and re.fullmatch("[0-9a-f]{64}", entry["content_hash"]))
        payload = json.dumps([entry], ensure_ascii=False).replace("'", "''")
        seeded = self.sql("SELECT public.replace_mike_workflows('" + entry["source_commit"]
            + "','" + payload + "'::jsonb); SELECT count(*) FROM public.mike_workflows"
            + " WHERE active AND workflow_key='civil-commercial-mx-triage';")
        self.check("beta_catalog_persisted", seeded == "1", workflow_key=entry["workflow_key"],
            workflow_content_hash=entry["content_hash"], workflow_source_commit=entry["source_commit"])
        self.stage("beta_source_provider_persistence")
        f = self.fixture

        def mark(name):
            self.receipt.setdefault("beta_evidence_trace", []).append(name)
            self.save()

        f["execution"] = str(uuid.uuid4())
        mark("execution_id")
        required = ("user", "organization", "matter", "project", "document")
        missing = [name for name in required if name not in f]
        if missing:
            mark("fixture_missing:" + ",".join(missing))
            raise Failure("fixture_keys_missing")
        try:
            owner_token = access_token(self.cookies)
        except Exception as error:
            mark("token_error:" + type(error).__name__)
            raise
        mark("token_read")
        value = dict(
            owner_user_id=f["user"],
            owner_access_token=owner_token,
            organization_id=f["organization"],
            matter_id=f["matter"],
            project_id=f["project"],
            document_id=f["document"],
            execution_id=f["execution"],
            idempotency_key="beta-evidence",
        )
        mark("input_built")
        local = self.work / "beta-input.json"
        local.write_text(json.dumps(value))
        local.chmod(0o600)
        mark("input_written")
        self.copy("backend", local, "/tmp/litt-beta-input.json", inbound=True)
        mark("input_copied")
        backend = self.resource("backend", {"running"})
        # docker cp may retain the host UID. Keep 0600 and the CLI's exact-owner guard.
        self.command(
            self.docker
            + [
                "exec",
                "--user",
                "root",
                backend,
                "sh",
                "-ec",
                "test -f /tmp/litt-beta-input.json && test ! -L /tmp/litt-beta-input.json && "
                "chown 0:0 /tmp/litt-beta-input.json && chmod 600 /tmp/litt-beta-input.json",
            ]
        )
        # Capture both streams plus the exit code inside the container: the CLI
        # classifies its failures on stderr, and a bare `json.loads` over the exec
        # stdout turns every failure mode into an undiagnosable generic error.
        # Raw text stays inside the container; the receipt keeps codes only.
        started = time.monotonic()
        self.command(
            self.docker
            + [
                "exec",
                backend,
                "sh",
                "-c",
                "node /app/scripts/recovery-beta-evidence.cjs /tmp/litt-beta-input.json "
                ">/tmp/litt-beta-evidence.stdout 2>/tmp/litt-beta-evidence.stderr; "
                "printf '%s' \"$?\" >/tmp/litt-beta-evidence.rc",
            ],
            timeout=150,
        )
        probe = {
            "elapsed_ms": int((time.monotonic() - started) * 1000),
            "exit_code": int(self.command(self.docker + ["exec", backend, "cat", "/tmp/litt-beta-evidence.rc"])),
        }
        self.receipt.setdefault("beta_evidence_probe", {}).update(probe)
        self.save()
        if probe["exit_code"] != 0:
            raise Failure(
                "beta_evidence_exit",
                probe["exit_code"],
                smoke.failure_signatures(
                    self.command(self.docker + ["exec", backend, "cat", "/tmp/litt-beta-evidence.stderr"]).encode()
                ),
            )
        output = self.command(self.docker + ["exec", backend, "cat", "/tmp/litt-beta-evidence.stdout"])
        if not output:
            raise Failure("beta_evidence_stdout_empty")
        try:
            result = json.loads(output)
        except json.JSONDecodeError:
            raise Failure("beta_evidence_stdout_malformed") from None
        self.check(
            "beta_one_governed_fake_call",
            result["provider_calls"] == 1
            and result["execution_id"] == f["execution"]
            and result["document_id"] == f["document"]
            and result["document_sha256"] == f["hash"],
        )
        self.receipt["beta_evidence"] = {
            k: result[k]
            for k in (
                "provider_calls",
                "document_sha256",
                "page_sha256",
                "output_sha256",
                "receipt_sha256",
                "workflow_content_hash",
            )
        }
        f["evidence"] = result
        local.unlink()

    def application(self):
        super().application(keep_session=True)
        self.produce_evidence()
        self.review_and_publish()

    def capture_restore_sessions(self):
        self.check(
            "beta_backed_up_sessions",
            set(self.fixture["sessions"]) == {"owner", "reviewer", "outsider"},
        )
        self.cookies.clear()

    def verify_http(self, fixture, restored=False):
        if restored:
            self.fixture = dict(fixture)
        # Always use existing AAL2 sessions: no post-backup login/refresh mutation.
        super().verify_http(fixture, restored=True)
        self.restore_session(fixture, "reviewer")
        path = self.review_path()
        review = self.http("beta_read_review", "GET", path)
        bundle = self.http(
            "beta_read_bundle", "GET", path + "/redline-bundle?revision=1"
        )
        publication = self.http(
            "beta_read_publication",
            "GET",
            path + "/drive-publications/" + fixture["publication"],
        )
        data = self.http(
            "beta_read_approved_docx",
            "GET",
            path + "/approved-report?revision=" + str(fixture["revision"]),
            binary=True,
        )
        self.check(
            "beta_restored_approved_bytes",
            hashlib.sha256(data).hexdigest() == fixture["approved_hash"],
        )
        observed = {"review": review, "bundle": bundle, "publication": publication}
        if restored:
            self.check(
                "beta_restored_persisted_state", observed == fixture["beta_readback"]
            )
        else:
            fixture["beta_readback"] = observed
            self.check(
                "beta_persisted_reconciled_state",
                publication["outcome"] == "reconciled",
            )
        self.restore_session(fixture, "outsider")
        for name, suffix in (
            ("review", ""),
            ("bundle", "/redline-bundle?revision=1"),
            ("report", "/approved-report?revision=" + str(fixture["revision"])),
            ("publication", "/drive-publications/" + fixture["publication"]),
        ):
            self.http("beta_outsider_" + name, "GET", path + suffix, expected=404)
        self.cookies.clear()

    def review_and_publish(self):
        f = self.fixture
        path = self.review_path()
        self.restore_session(f, "owner")
        self.http(
            "beta_self_review_denied",
            "POST",
            path,
            expected=400,
            body={
                "idempotency_key": "beta-self-review",
                "review_id": str(uuid.uuid4()),
            },
        )
        self.restore_session(f, "reviewer")
        created = self.http(
            "beta_review_create",
            "POST",
            path,
            expected=201,
            body={"idempotency_key": "beta-review", "review_id": str(uuid.uuid4())},
        )
        review = created["review"]
        self.check(
            "beta_distinct_reviewer",
            review["reviewer_user_id"] == f["reviewer"] != f["user"]
            and review["execution_author_user_id"] == f["user"],
        )
        items = {item["citation"]["citation_id"]: item for item in review["items"]}
        self.check(
            "beta_r4_r6_r9",
            set(items) == {"R4", "R6", "R9"} and len(review["items"]) == 3,
        )
        f["rejected_text"] = items["R4"]["finding_text"]
        edited = "R6: reviewer edited synthetic finding."
        for rule, decision in (
            ("R4", "rejected"),
            ("R6", "edited"),
            ("R9", "accepted"),
        ):
            body = {"idempotency_key": "beta-decision-" + rule, "decision": decision}
            if decision == "edited":
                body["finding_text"] = edited
            review = self.http(
                "beta_decision_" + rule,
                "POST",
                path
                + "/items/"
                + urllib.parse.quote(items[rule]["item_id"], safe="")
                + "/decision",
                body=body,
            )["review"]
        review = self.http(
            "beta_review_complete",
            "POST",
            path + "/complete",
            body={"idempotency_key": "beta-complete", "terminal_state": "approved"},
        )["review"]
        self.check(
            "beta_review_approved",
            review["status"] == "approved" and type(review["revision"]) is int,
        )
        f["revision"] = review["revision"]
        redline = self.http(
            "beta_redline_create",
            "POST",
            path + "/redline-bundle",
            expected=201,
            body={
                "idempotency_key": "beta-redline",
                "revision": 1,
                "expected_review_revision": f["revision"],
            },
        )
        actions = redline["bundle"]["actions"]
        self.check(
            "beta_two_approved_actions",
            len(actions) == 2
            and {a["replacement_text"] for a in actions}
            == {edited, items["R9"]["finding_text"]},
        )
        body = {
            "idempotency_key": "beta-report",
            "expected_review_revision": f["revision"],
        }
        report = self.http(
            "beta_report_create",
            "POST",
            path + "/approved-report",
            expected=201,
            body=body,
        )
        replay = self.http(
            "beta_report_replay", "POST", path + "/approved-report", body=body
        )
        f["export"] = str(uuid.UUID(report["export_id"]))
        f["approved_hash"] = report["artifact"]["artifact_sha256"]
        self.check(
            "beta_report_replay_identity",
            replay["export_id"] == f["export"]
            and replay["artifact"]["artifact_sha256"] == f["approved_hash"],
        )
        data = self.http(
            "beta_report_download",
            "GET",
            path + "/approved-report?revision=" + str(f["revision"]),
            binary=True,
        )
        self.check(
            "beta_approved_docx_hash",
            hashlib.sha256(data).hexdigest() == f["approved_hash"],
        )
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 4 * 1024 * 1024:
                raise Failure("invalid_report_size")
            text = "".join(ET.fromstring(archive.read(info)).itertext())
        self.check(
            "beta_approved_docx_content",
            edited in text
            and items["R9"]["finding_text"] in text
            and f["rejected_text"] not in text,
        )
        body = {"export_id": f["export"], "expected_review_revision": f["revision"]}
        publication = self.http(
            "beta_drive_publish", "POST", path + "/drive-publications", body=body
        )
        self.check(
            "beta_drive_unknown_ack", publication["outcome"] == "unknown_outcome"
        )
        f["publication"] = str(uuid.UUID(publication["publication"]["publication_id"]))
        retry = self.http(
            "beta_drive_retry_unknown", "POST", path + "/drive-publications", body=body
        )
        self.check(
            "beta_retry_same_unknown",
            retry["outcome"] == "unknown_outcome"
            and retry["publication"]["publication_id"] == f["publication"],
        )
        reconciled = self.http(
            "beta_drive_reconcile",
            "POST",
            path + "/drive-publications/" + f["publication"] + "/reconcile",
            body={},
        )
        self.check(
            "beta_drive_reconciled",
            reconciled["outcome"] == "reconciled"
            and reconciled["publication"]["publication_id"] == f["publication"],
        )
        replay = self.http(
            "beta_drive_replay", "POST", path + "/drive-publications", body=body
        )
        self.check(
            "beta_drive_rehydrated_replay",
            replay["outcome"] == "reconciled"
            and replay["disposition"] == "replayed"
            and replay["publication"]["publication_id"] == f["publication"],
        )
        local = self.work / "fake-drive.json"
        self.copy("backend", local, self.fake_receipt)
        with paired.bounded_files(self):
            local.chmod(0o600)
            if local.stat().st_size > 8 * 1024 * 1024:
                raise Failure("invalid_fake_receipt_size")
            state = json.loads(local.read_text())
        self.check(
            "beta_one_fake_drive_upload",
            state["format"] == 1
            and state["uploadCount"] == 1
            and state["findCount"] >= 1
            and len(state["objects"]) == 1,
        )
        obj = state["objects"][0]
        remote = base64.b64decode(obj["bytes_base64"], validate=True)
        self.check(
            "beta_fake_remote_approved_bytes",
            remote == data
            and obj["sha256"] == f["approved_hash"]
            and obj["size_bytes"] == len(data),
        )
        self.receipt["beta"] = {
            "fake_drive_uploads": state["uploadCount"],
            "approved_docx_sha256": f["approved_hash"],
        }


if __name__ == "__main__":
    raise SystemExit(paired.main(runner_type=BetaRunner))
