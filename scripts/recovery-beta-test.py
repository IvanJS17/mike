#!/usr/bin/env python3
"""Focal offline harness tests; synthetic HTTP/command boundaries, not runtime."""

import base64
import copy
import hashlib
import http.cookiejar
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location(
    "beta", Path(__file__).with_name("recovery-beta.py")
)
assert spec is not None and spec.loader is not None
beta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beta)


def cookie(name, value):
    return http.cookiejar.Cookie(
        0,
        name,
        value,
        None,
        False,
        "127.0.0.1",
        False,
        False,
        "/",
        True,
        False,
        None,
        True,
        None,
        None,
        {},
    )


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


class Tests(unittest.TestCase):
    def test_private_cli_file_is_owned_before_evidence_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            args = SimpleNamespace(
                output_dir=folder,
                timeout_seconds=6000,
                docker_socket="/var/run/docker.sock",
                runtime=True,
                **{
                    s.replace("-", "_") + "_image": "sha256:" + "a" * 64
                    for s in beta.paired.IMAGE_SERVICES
                },
            )
            runner = beta.BetaRunner(args)
            runner.work.mkdir(mode=0o700)
            runner.fixture.update(
                user=uid(1),
                organization=uid(2),
                matter=uid(3),
                project=uid(4),
                document=uid(5),
                hash="a" * 64,
            )
            value = "base64-" + base64.urlsafe_b64encode(
                json.dumps({"access_token": "synthetic-token"}).encode()
            ).decode().rstrip("=")
            runner.cookies.set_cookie(cookie("mike-session", value))
            normalized = []
            catalog = []

            def seed_catalog(query):
                self.assertIn("replace_mike_workflows", query)
                catalog.append(True)
                return "1"

            def command(argv, **kwargs):
                if "-e" in argv:
                    return json.dumps({"workflow_key": "civil-commercial-mx-triage",
                        "source_commit": "b" * 40, "content_hash": "a" * 64})
                if "sh" in argv:
                    self.assertIn("chown 0:0 /tmp/litt-beta-input.json", argv[-1])
                    self.assertIn("chmod 600 /tmp/litt-beta-input.json", argv[-1])
                    normalized.append(True)
                    return ""
                self.assertTrue(catalog, "catalog was not persisted before evidence")
                self.assertTrue(normalized, "private input ownership was not prepared")
                return json.dumps(
                    dict(
                        provider_calls=1,
                        execution_id=runner.fixture["execution"],
                        document_id=uid(5),
                        **{
                            k: "a" * 64
                            for k in (
                                "document_sha256",
                                "page_sha256",
                                "output_sha256",
                                "receipt_sha256",
                                "workflow_content_hash",
                            )
                        },
                    )
                )

            with (
                patch.object(runner, "copy"),
                patch.object(runner, "resource", return_value="a" * 64),
                patch.object(runner, "command", side_effect=command),
                patch.object(runner, "sql", side_effect=seed_catalog),
            ):
                runner.produce_evidence()
            self.assertEqual(normalized, [True])
            self.assertFalse((runner.work / "beta-input.json").exists())

    def test_cli_failure_keeps_only_fixed_phase_and_observed_call_count(self):
        raw = b"private-token-must-not-survive BETA_EVIDENCE_FAILED:source:0\n"
        self.assertEqual(
            beta.smoke.failure_signatures(raw), ("beta_evidence_source_calls_0",)
        )

    def test_application_calls_evidence_and_review_after_real_foundation(self):
        with tempfile.TemporaryDirectory() as folder:
            args = SimpleNamespace(
                output_dir=folder,
                timeout_seconds=6000,
                docker_socket="/var/run/docker.sock",
                runtime=True,
                **{
                    s.replace("-", "_") + "_image": "sha256:" + "a" * 64
                    for s in beta.paired.IMAGE_SERVICES
                },
            )
            runner = beta.BetaRunner(args)
            calls = []
            with (
                patch.object(
                    beta.paired.smoke.Runner,
                    "application",
                    lambda s, keep_session=False: calls.append(
                        ("foundation", keep_session)
                    ),
                ),
                patch.object(
                    runner, "produce_evidence", lambda: calls.append(("evidence", True))
                ),
                patch.object(
                    runner, "review_and_publish", lambda: calls.append(("review", True))
                ),
            ):
                runner.application()
            self.assertEqual(
                calls, [("foundation", True), ("evidence", True), ("review", True)]
            )

    def test_private_tenancy_is_prepared_at_project_response_before_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            args = SimpleNamespace(
                output_dir=folder,
                timeout_seconds=6000,
                docker_socket="/var/run/docker.sock",
                runtime=True,
                **{
                    s.replace("-", "_") + "_image": "sha256:" + "a" * 64
                    for s in beta.paired.IMAGE_SERVICES
                },
            )
            runner = beta.BetaRunner(args)
            calls = []
            with (
                patch.object(
                    beta.paired.smoke.Runner, "http", return_value={"id": uid(4)}
                ),
                patch.object(
                    runner,
                    "setup_tenancy",
                    lambda: calls.append(runner.fixture["project"]),
                ),
            ):
                runner.http("project_create", "POST", "/api/projects")
            self.assertEqual(calls, [uid(4)])

    def test_totp_rfc6238_sha1_six_digits(self):
        self.assertEqual(beta.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59), "287082")

    def test_only_complete_single_session_cookie_yields_access_token(self):
        value = "base64-" + base64.urlsafe_b64encode(
            json.dumps(
                {"access_token": "fixture-access", "refresh_token": "not-access"}
            ).encode()
        ).decode().rstrip("=")
        # Actual backend/src/lib/authSession.ts local HTTP cookie contract.
        root = "mike-session"
        self.assertEqual(
            beta.access_token(
                [cookie(root + ".1", value[24:]), cookie(root + ".0", value[:24])]
            ),
            "fixture-access",
        )
        for cookies in (
            [cookie(root + ".1", value)],
            [cookie(root, value), cookie(root + ".0", value)],
            [cookie(root, value), cookie("__Host-mike-session", value)],
            [cookie("sb-proxy-auth-token", value)],
        ):
            with self.assertRaises(beta.Failure):
                beta.access_token(cookies)

    def test_http_review_uses_distinct_actor_and_unknown_retry_reconciles_without_upload(
        self,
    ):
        with tempfile.TemporaryDirectory() as folder:
            args = SimpleNamespace(
                output_dir=folder,
                timeout_seconds=6000,
                docker_socket="/var/run/docker.sock",
                runtime=True,
                **{
                    s.replace("-", "_") + "_image": "sha256:" + "a" * 64
                    for s in beta.paired.IMAGE_SERVICES
                },
            )
            runner = beta.BetaRunner(args)
            runner.role = "source"
            runner.fixture.update(
                user=uid(1),
                reviewer=uid(2),
                outsider=uid(3),
                project=uid(4),
                matter=uid(5),
                execution=uid(6),
                sessions={
                    role: [cookie("role", role)]
                    for role in ("owner", "reviewer", "outsider")
                },
            )
            requests = []
            edited = "R6: reviewer edited synthetic finding."
            out = io.BytesIO()
            with zipfile.ZipFile(out, "w") as z:
                z.writestr(
                    "word/document.xml",
                    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:t>'
                    + edited
                    + "</w:t><w:t>R9: abstain; synthetic fixture has insufficient context.</w:t></w:document>",
                )
            docx = out.getvalue()
            digest = hashlib.sha256(docx).hexdigest()
            review: dict = dict(
                review_id=uid(7),
                execution_author_user_id=uid(1),
                reviewer_user_id=uid(2),
                revision=1,
                status="draft",
                items=[
                    {
                        "item_id": f"{uid(7)}:{r}",
                        "item_key": r,
                        "citation": {"citation_id": r},
                        "finding_text": r
                        + ": abstain; synthetic fixture has insufficient context.",
                    }
                    for r in ("R4", "R6", "R9")
                ],
            )
            publication = dict(publication_id=uid(8), outcome="unknown_outcome")

            def http(name, method, path, expected=200, body=None, **kw):
                role = next(iter(runner.cookies)).value
                requests.append((name, method, path, copy.deepcopy(body), role))
                if name == "beta_self_review_denied":
                    self.assertEqual((role, expected), ("owner", 400))
                    return {"code": "invalid_review"}
                if name == "beta_review_create":
                    self.assertEqual((role, expected), ("reviewer", 201))
                    return {"review": copy.deepcopy(review)}
                if name.startswith("beta_decision_"):
                    review["revision"] += 1
                    return {"review": copy.deepcopy(review)}
                if name == "beta_review_complete":
                    review.update(revision=review["revision"] + 1, status="approved")
                    return {"review": copy.deepcopy(review)}
                if name == "beta_redline_create":
                    return {
                        "bundle": {
                            "actions": [
                                {"replacement_text": edited},
                                {
                                    "replacement_text": "R9: abstain; synthetic fixture has insufficient context."
                                },
                            ]
                        }
                    }
                if name in ("beta_report_create", "beta_report_replay"):
                    return {
                        "export_id": uid(9),
                        "artifact": {"artifact_sha256": digest},
                    }
                if name == "beta_report_download":
                    return docx
                if name == "beta_drive_reconcile":
                    publication["outcome"] = "reconciled"
                if name.startswith("beta_drive_"):
                    return {
                        "publication": copy.deepcopy(publication),
                        "outcome": publication["outcome"],
                        "disposition": "replayed",
                    }
                raise AssertionError(name)

            def fake_copy(service, local, remote, inbound=False):
                self.assertEqual(service, "backend")
                self.assertFalse(inbound)
                Path(local).write_text(
                    json.dumps(
                        {
                            "format": 1,
                            "uploadCount": 1,
                            "findCount": 1,
                            "objects": [
                                {
                                    "sha256": digest,
                                    "size_bytes": len(docx),
                                    "bytes_base64": base64.b64encode(docx).decode(),
                                }
                            ],
                        }
                    )
                )

            runner.work.mkdir(mode=0o700)
            with (
                patch.object(runner, "http", side_effect=http),
                patch.object(runner, "copy", side_effect=fake_copy),
            ):
                runner.review_and_publish()
            names = [r[0] for r in requests]
            self.assertIn("beta_review_create", names)
            decisions = [r for r in requests if r[0].startswith("beta_decision_")]
            self.assertEqual(
                [r[3]["decision"] for r in decisions],
                ["rejected", "edited", "accepted"],
            )
            self.assertEqual({r[4] for r in decisions}, {"reviewer"})
            self.assertLess(
                names.index("beta_drive_publish"),
                names.index("beta_drive_retry_unknown"),
            )
            self.assertLess(
                names.index("beta_drive_retry_unknown"),
                names.index("beta_drive_reconcile"),
            )
            self.assertLess(
                names.index("beta_drive_reconcile"), names.index("beta_drive_replay")
            )
            self.assertEqual(runner.fixture["publication"], uid(8))
            self.assertEqual(runner.fixture["approved_hash"], digest)


if __name__ == "__main__":
    unittest.main()
