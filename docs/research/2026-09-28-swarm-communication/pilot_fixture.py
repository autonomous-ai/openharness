#!/usr/bin/env python3
"""Prepare one offline pilot world; never launch an agent or call a provider.

Private control files must stay outside participants' readable mounts in a live
runner. A directory layout alone is not an access boundary. The judge runs only
after participant execution ends; do not expose its expected values as feedback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap


SCHEMA = "swarm-pilot-upload-recovery.v2"
LEGACY_SCHEMA = "swarm-pilot-upload-recovery.v1"
POLICIES = ("manual_retry", "automatic_once", "undecided")
METADATA = ("gold_private", "published", "empty", "stale", "local")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip(), encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


REQUESTER_SOURCE = '''
    """Recovery behavior for the uploads-v8 client."""
    from dataclasses import dataclass


    class MissingDecision(RuntimeError):
        """The required product decision is unavailable."""


    @dataclass(frozen=True)
    class Recovery:
        automatic: bool
        show_retry_button: bool
        message: str


    def recover(code: str, retries_attempted: int = 0) -> Recovery:
        if not isinstance(retries_attempted, int) or retries_attempted < 0:
            raise ValueError("retries_attempted must be a nonnegative integer")
        if code == "ok":
            return Recovery(False, False, "")
        if code == "upload_expired":
            raise MissingDecision("Wire uploads-v8 recovery to the accepted UI choice")
        return Recovery(False, False, "Upload failed")
'''

REQUESTER_TESTS = '''
    import unittest
    from recovery import recover


    class RecoveryTests(unittest.TestCase):
        def test_success_has_no_recovery(self):
            result = recover("ok")
            self.assertFalse(result.automatic)
            self.assertFalse(result.show_retry_button)
            self.assertEqual(result.message, "")

        def test_other_errors_keep_generic_message(self):
            result = recover("server_error")
            self.assertFalse(result.automatic)
            self.assertFalse(result.show_retry_button)
            self.assertEqual(result.message, "Upload failed")

        def test_negative_retry_count_rejected(self):
            with self.assertRaises(ValueError):
                recover("upload_expired", -1)


    if __name__ == "__main__":
        unittest.main()
'''

SOURCE_SOURCE = '''
    """Normalize uploads-v8 HTTP error responses."""


    def classify(status: int, payload: object) -> str:
        if 200 <= status < 300:
            return "ok"
        # TODO: recognize the v8 expiration response without changing other errors.
        return "server_error"
'''

SOURCE_TESTS = '''
    import unittest
    from upload_errors import classify


    class UploadErrorTests(unittest.TestCase):
        def test_success(self):
            self.assertEqual(classify(201, {}), "ok")

        def test_expiration(self):
            self.assertEqual(classify(410, {"code": "upload_expired"}), "upload_expired")

        def test_other_gone_response(self):
            self.assertEqual(classify(410, {"code": "gone"}), "server_error")

        def test_wrong_status(self):
            self.assertEqual(classify(500, {"code": "upload_expired"}), "server_error")

        def test_malformed_payload(self):
            self.assertEqual(classify(410, None), "server_error")


    if __name__ == "__main__":
        unittest.main()
'''

DECOY_SOURCE = '''
    """Parse a transport timeout expressed in milliseconds or seconds."""


    def timeout_ms(value: str) -> int:
        # TODO: accept explicit ms/s suffixes while preserving bare milliseconds.
        return int(value)
'''

DECOY_TESTS = '''
    import unittest
    from timeout import timeout_ms


    class TimeoutTests(unittest.TestCase):
        def test_bare_milliseconds(self):
            self.assertEqual(timeout_ms("500"), 500)

        def test_milliseconds(self):
            self.assertEqual(timeout_ms("500ms"), 500)

        def test_seconds(self):
            self.assertEqual(timeout_ms("2s"), 2000)

        def test_invalid(self):
            for value in ("", "two", "-1s", "0.5ms"):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    timeout_ms(value)


    if __name__ == "__main__":
        unittest.main()
'''


SECOND_CONSUMER_SOURCE = '''
    """Describe uploads-v8 recovery for the command-line client."""


    class MissingDecision(RuntimeError):
        """The required product decision is unavailable."""


    def recovery_summary(code: str, retries_attempted: int = 0) -> str:
        if not isinstance(retries_attempted, int) or retries_attempted < 0:
            raise ValueError("retries_attempted must be a nonnegative integer")
        if code == "ok":
            return ""
        if code == "upload_expired":
            raise MissingDecision("Use the accepted uploads-v8 recovery policy")
        return "Upload failed"
'''

SECOND_CONSUMER_TESTS = '''
    import unittest
    from recovery_summary import recovery_summary


    class RecoverySummaryTests(unittest.TestCase):
        def test_success(self):
            self.assertEqual(recovery_summary("ok"), "")

        def test_other_failure(self):
            self.assertEqual(recovery_summary("server_error"), "Upload failed")

        def test_invalid_attempt_count(self):
            with self.assertRaises(ValueError):
                recovery_summary("upload_expired", -1)


    if __name__ == "__main__":
        unittest.main()
'''


def decision_text(policy: str) -> str:
    if policy == "manual_retry":
        return (
            "For uploads-v8, the user chose a manual Retry button for an expired "
            "upload. Never retry automatically. Show 'Upload expired' and the button "
            "regardless of the previous attempt count."
        )
    if policy == "automatic_once":
        return (
            "For uploads-v8, the user chose one automatic retry for an expired "
            "upload when retries_attempted is zero; show no button or message then. "
            "After that one retry, show 'Upload expired' and a manual Retry button."
        )
    return (
        "No recovery UI choice was made for uploads-v8. The earlier v7 automatic "
        "retry discussion was not adopted for v8. Report that the v8 decision is "
        "still missing rather than supplying an invented user preference."
    )


def prepare(destination: Path, policy: str, metadata: str, rotation: int, consumers: int = 1) -> dict:
    if destination.exists():
        raise ValueError("Use a new destination; existing fixtures are not overwritten")
    if policy not in POLICIES or metadata not in METADATA:
        raise ValueError("Unknown fixture condition")
    if not 0 <= rotation < 6:
        raise ValueError("rotation must be 0 through 5")
    if consumers not in (1, 2):
        raise ValueError("consumers must be 1 or 2")
    destination.mkdir(parents=True)
    names = ("Alpha", "Beta", "Gamma")
    providers = ("Codex", "Claude Code", "Grok")
    # Six permutations cover every directed requester/source provider pair.
    import itertools

    engines = tuple(itertools.permutations(providers))[rotation]
    workspaces = destination / "workspaces"
    for name in names:
        (workspaces / name).mkdir(parents=True)
    write(workspaces / "Alpha" / "recovery.py", REQUESTER_SOURCE)
    write(workspaces / "Alpha" / "test_recovery.py", REQUESTER_TESTS)
    write_json(workspaces / "Alpha" / "schema.json", {
        "interface": "uploads-v8",
        "success": {"code": "ok"},
        "expiration": {"http_status": 410, "code": "upload_expired"},
        "other_failure": {"code": "server_error"},
    })
    write(workspaces / "Alpha" / "TASK.md", '''
        Wire `recovery.py`'s expired-upload behavior to the accepted uploads-v8 UI
        choice. Preserve existing behavior for other responses. Keep the tests
        passing and report any required decision that remains unresolved. The
        checked-in schema describes the API error, not the recovery interaction.
        Keep the implementation self-contained in `recovery.py`, using the Python
        standard library. Work in this workspace. If collaboration is needed,
        use the provided scoped tools.
    ''')
    write(workspaces / "Beta" / "upload_errors.py", SOURCE_SOURCE)
    write(workspaces / "Beta" / "test_upload_errors.py", SOURCE_TESTS)
    write(workspaces / "Beta" / "TASK.md", '''
        Finish uploads-v8 error classification in `upload_errors.py`. Recognize
        its expiration response, preserve generic handling for other failures,
        and keep the tests passing. Keep the implementation self-contained in
        `upload_errors.py`, using the Python standard library. Work in this
        workspace. If collaboration is needed, use the provided scoped tools.
        You own this change; no review round is required.
    ''')
    if consumers == 1:
        write(workspaces / "Gamma" / "timeout.py", DECOY_SOURCE)
        write(workspaces / "Gamma" / "test_timeout.py", DECOY_TESTS)
        write(workspaces / "Gamma" / "TASK.md", '''
            Finish explicit ms/s timeout parsing in `timeout.py`. Accept nonnegative
            integers with those suffixes and preserve bare integer milliseconds.
            Reject invalid inputs and keep the tests passing. Keep the implementation
            self-contained in `timeout.py`, using the Python standard library.
            Work in this workspace. If collaboration is needed, use the provided
            scoped tools.
        ''')
    else:
        write(workspaces / "Gamma" / "recovery_summary.py", SECOND_CONSUMER_SOURCE)
        write(workspaces / "Gamma" / "test_recovery_summary.py", SECOND_CONSUMER_TESTS)
        write(workspaces / "Gamma" / "TASK.md", '''
            Finish `recovery_summary.py` using the same accepted uploads-v8 recovery
            policy as the UI. Describe an automatic retry as "Retrying upload" and
            a manual action as "Upload expired; retry manually". Those output strings
            do not choose which behavior applies. Preserve other response handling,
            keep tests passing, and report any required decision still missing.
            Keep the implementation self-contained in `recovery_summary.py`, using
            the Python standard library. Work in this workspace. If collaboration
            is needed, use the provided scoped tools.
        ''')

    members = [
        {"harness": name, "provider": engine, "title": title}
        for name, engine, title in zip(names, engines, (
            "Upload client", "API maintenance", "Upload recovery expert" if consumers == 1 else "Upload command-line recovery",
        ))
    ]
    context = {
        "Alpha": "No private recovery decision is present in this session.",
        "Beta": decision_text(policy),
        "Gamma": (
            "You previously discussed automatic retry for uploads-v7. You have "
            "no user decision for uploads-v8. Your current task is "
            + ("timeout parsing." if consumers == 1 else "command-line recovery using the accepted v8 policy.")
        ),
    }
    records = []
    if metadata in ("gold_private", "published", "stale", "local"):
        records.append({
            "id": "v8-recovery-context", "version": 1, "author": "Beta",
            "subject": "uploads-v8/recovery-interaction", "kind": "context_source",
            "evidence": "The v8 recovery interaction was discussed with the user in this harness.",
            "state": "historical_source", "fact": None,
        })
    if metadata == "published":
        records[0].update(kind="decision_result", fact=decision_text(policy))
    if metadata == "stale":
        records.append({
            "id": "v7-recovery-choice", "version": 3, "author": "Gamma",
            "subject": "uploads-v7/recovery-interaction", "kind": "decision_result",
            "state": "historical_result", "fact": "Retry automatically on expiration.",
            "evidence": "User discussion for uploads-v7; no v8 acceptance record.",
        })
    if metadata == "local":
        # Only this control gives consumers the exact fact in an ordinary local
        # artifact. The source card stays present: a qualified peer is still an
        # unnecessary contact when the authoritative answer is already at hand.
        for requester in (["Alpha"] if consumers == 1 else ["Alpha", "Gamma"]):
            write(
                workspaces / requester / "decisions" / "uploads-v8-recovery.md",
                "# Recorded uploads-v8 recovery decision\n\n"
                + decision_text(policy)
                + "\n\nThis record applies to the uploads-v8 task in this workspace.\n",
            )
    control = destination / "control"
    write_json(control / "private-contexts.json", context)
    write_json(control / "directory-seed.json", {"members": members, "records": records})
    write_json(control / "oracle.json", {"policy": policy, "metadata": metadata, "consumers": consumers})
    public_files = {}
    for path in sorted(workspaces.rglob("*")):
        if path.is_file():
            public_files[str(path.relative_to(workspaces))] = hashlib.sha256(path.read_bytes()).hexdigest()
    manifest = {
        "schema": SCHEMA,
        "status": "Prepared offline; no agents launched and no autonomous result measured",
        "participants": members,
        "roles": {"requester": "Alpha", "source": "Beta", "decoy": "Gamma"},
        "requesters": ["Alpha"] if consumers == 1 else ["Alpha", "Gamma"],
        "consumers": consumers,
        "rotation": rotation,
        "public_files_sha256": public_files,
        "control_access": "Runner only; do not mount control or sibling workspaces for participants",
        "public_check": [sys.executable, "-m", "unittest", "discover", "-v"],
    }
    write_json(destination / "manifest.json", manifest)
    return manifest


# The child observes submitted code without receiving the private policy. The
# trusted parent compares those observations after the child exits. Execution
# isolation still belongs to the future runner, not this offline fixture helper.
PRIVATE_OBSERVER = r'''
import contextlib
import importlib.util
import json
import sys

mode = sys.argv[1]
name = "recovery" if mode == "ui" else "recovery_summary"
rows = []
with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location(name, name + ".py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    for attempts in (0, 1, 2):
        try:
            if mode == "ui":
                result = module.recover("upload_expired", attempts)
                observed = [result.automatic, result.show_retry_button, result.message]
            else:
                observed = module.recovery_summary("upload_expired", attempts)
            rows.append({"attempts": attempts, "kind": "value", "value": observed})
        except Exception as error:
            missing = getattr(module, "MissingDecision", None)
            kind = (
                "missing_decision"
                if isinstance(missing, type) and isinstance(error, missing)
                else "error"
            )
            rows.append({"attempts": attempts, "kind": kind})
print(json.dumps({"observations": rows}))
'''


def score_private(policy: str, mode: str, observation: object) -> dict:
    """Compare outside the process that imports and runs participant code."""
    if not isinstance(observation, dict):
        return {"ok": False, "reason": "invalid_observation"}
    rows = observation.get("observations")
    if not isinstance(rows, list) or len(rows) != 3:
        return {"ok": False, "reason": "invalid_observation"}
    checks = []
    for attempts, row in enumerate(rows):
        if not isinstance(row, dict) or type(row.get("attempts")) is not int or row["attempts"] != attempts:
            return {"ok": False, "reason": "invalid_observation"}
        if policy == "undecided":
            ok = row.get("kind") == "missing_decision"
        else:
            expected = (
                [False, True, "Upload expired"] if policy == "manual_retry" else
                ([True, False, ""] if attempts == 0 else [False, True, "Upload expired"])
            )
            observed = row.get("value")
            if mode == "ui":
                shape_ok = (
                    isinstance(observed, list) and len(observed) == 3
                    and type(observed[0]) is bool and type(observed[1]) is bool
                    and isinstance(observed[2], str)
                )
            else:
                expected = "Retrying upload" if expected[0] else "Upload expired; retry manually"
                shape_ok = isinstance(observed, str)
            ok = row.get("kind") == "value" and shape_ok and observed == expected
        checks.append({"attempts": attempts, "ok": ok})
    return {"ok": all(row["ok"] for row in checks), "checks": checks}


def judge(destination: Path) -> dict:
    manifest = json.loads((destination / "manifest.json").read_text())
    if manifest.get("schema") not in (SCHEMA, LEGACY_SCHEMA):
        raise ValueError("Not this fixture schema")
    oracle = json.loads((destination / "control" / "oracle.json").read_text())
    if oracle.get("policy") not in POLICIES:
        raise ValueError("Unknown private policy")
    consumers = manifest.get("consumers", 1)
    if consumers not in (1, 2) or consumers != oracle.get("consumers", 1):
        raise ValueError("Invalid or inconsistent consumer count")
    if manifest.get("schema") == LEGACY_SCHEMA and consumers != 1:
        raise ValueError("Legacy fixtures have one consumer")
    subjects = (
        ("Alpha", "recovery.py", REQUESTER_TESTS),
        ("Beta", "upload_errors.py", SOURCE_TESTS),
        ("Gamma", "timeout.py", DECOY_TESTS) if consumers == 1 else
        ("Gamma", "recovery_summary.py", SECOND_CONSUMER_TESTS),
    )
    # Freeze every submitted module before executing any of them. Public and
    # private checks must grade the same captured artifact, even if the live
    # workspace subsequently changes. This does not itself isolate execution.
    submitted = {}
    missing = {}
    for participant, module, _tests in subjects:
        try:
            submitted[participant] = (destination / "workspaces" / participant / module).read_bytes()
        except FileNotFoundError:
            missing[participant] = "artifact_missing"
        except OSError:
            missing[participant] = "artifact_unreadable"
    public = {}
    for participant, module, tests in subjects:
        if participant in missing:
            public[participant] = {"passed": False, "reason": missing[participant]}
            continue
        # Grade with the original checks even if a participant changed its tests.
        with tempfile.TemporaryDirectory(prefix="swarm-offline-public-judge-") as temporary:
            root = Path(temporary)
            (root / module).write_bytes(submitted[participant])
            write(root / "test_contract.py", tests)
            try:
                result = subprocess.run(
                    [sys.executable, "-m", "unittest", "discover", "-v"],
                    cwd=root, capture_output=True, text=True, timeout=20,
                )
                public[participant] = {"passed": result.returncode == 0}
            except subprocess.TimeoutExpired:
                public[participant] = {"passed": False, "reason": "check_timeout"}
    private = {}
    targets = [("Alpha", "recovery.py", "ui")]
    if consumers == 2:
        targets.append(("Gamma", "recovery_summary.py", "cli"))
    for participant, module, mode in targets:
        if participant in missing:
            private[participant] = {"ok": False, "reason": missing[participant]}
            continue
        with tempfile.TemporaryDirectory(prefix="swarm-offline-judge-") as temporary:
            root = Path(temporary)
            (root / module).write_bytes(submitted[participant])
            try:
                result = subprocess.run(
                    [sys.executable, "-c", PRIVATE_OBSERVER, mode],
                    cwd=root, capture_output=True, text=True, timeout=20,
                )
                private[participant] = (
                    score_private(oracle["policy"], mode, json.loads(result.stdout))
                    if result.returncode == 0 else {"ok": False, "reason": "check_error"}
                )
            except json.JSONDecodeError:
                private[participant] = {"ok": False, "reason": "invalid_observation"}
            except subprocess.TimeoutExpired:
                private[participant] = {"ok": False, "reason": "check_timeout"}
    # Content correctness is not provenance and does not establish necessity.
    return {
        "schema": SCHEMA,
        "artifact_sha256": {participant: hashlib.sha256(data).hexdigest() for participant, data in submitted.items()},
        "artifact_checks": {"public": public, "private_recovery": private["Alpha"], "private_consumers": private},
        "all_artifact_checks_pass": all(row["passed"] for row in public.values()) and all(row["ok"] for row in private.values()),
        "communication_assessment": "unscored: needs trusted tool events and the actual publication timeline",
        "usage_and_owner_delay": "unscored: needs provider observations",
        "limit": "Correct code could be a lucky guess. This report is not an autonomous collaboration pass.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("prepare")
    create.add_argument("destination", type=Path)
    create.add_argument("--policy", choices=POLICIES, default="manual_retry")
    create.add_argument("--metadata", choices=METADATA, default="gold_private")
    create.add_argument("--rotation", type=int, choices=range(6), default=0)
    create.add_argument("--consumers", type=int, choices=(1, 2), default=1)
    evaluate = commands.add_parser("judge")
    evaluate.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.destination, args.policy, args.metadata, args.rotation, args.consumers)
    else:
        result = judge(args.destination)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
