#!/usr/bin/env python3
"""Verify offline pilot inputs and judges using hand-written reference code.

This runs no agents, provider calls, or communication evaluation. All generated
workspaces and reference executions are temporary. No private judge feedback is
returned to a participant.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
from unittest.mock import patch

sys.dont_write_bytecode = True
GENERATOR = Path(__file__).with_name("pilot_fixture.py")
spec = importlib.util.spec_from_file_location("pilot_fixture", GENERATOR)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

API_REFERENCE = '''
def classify(status, payload):
    if 200 <= status < 300:
        return "ok"
    if status == 410 and isinstance(payload, dict) and payload.get("code") == "upload_expired":
        return "upload_expired"
    return "server_error"
'''

TIMEOUT_REFERENCE = r'''
import re

def timeout_ms(value):
    match = re.fullmatch(r"(\d+)(ms|s)?", value)
    if not match:
        raise ValueError("Invalid timeout")
    return int(match.group(1)) * (1000 if match.group(2) == "s" else 1)
'''


def consumer_reference(policy: str, mode: str) -> str:
    if mode == "ui":
        template = textwrap.dedent(fixture.REQUESTER_SOURCE).lstrip()
        target = 'raise MissingDecision("Wire uploads-v8 recovery to the accepted UI choice")'
        if policy == "undecided":
            return template
        replacement = 'return Recovery(False, True, "Upload expired")'
        if policy == "automatic_once":
            replacement = 'if retries_attempted == 0:\n            return Recovery(True, False, "")\n        ' + replacement
    else:
        template = textwrap.dedent(fixture.SECOND_CONSUMER_SOURCE).lstrip()
        target = 'raise MissingDecision("Use the accepted uploads-v8 recovery policy")'
        if policy == "undecided":
            return template
        replacement = 'return "Upload expired; retry manually"'
        if policy == "automatic_once":
            replacement = 'if retries_attempted == 0:\n            return "Retrying upload"\n        ' + replacement
    assert template.count(target) == 1
    return template.replace(target, replacement)


def solve(root: Path, policy: str, consumers: int) -> None:
    workspaces = root / "workspaces"
    (workspaces / "Alpha" / "recovery.py").write_text(consumer_reference(policy, "ui"))
    (workspaces / "Beta" / "upload_errors.py").write_text(API_REFERENCE)
    if consumers == 1:
        (workspaces / "Gamma" / "timeout.py").write_text(TIMEOUT_REFERENCE)
    else:
        (workspaces / "Gamma" / "recovery_summary.py").write_text(consumer_reference(policy, "cli"))


def argv_probe_reference(mode: str) -> str:
    """A control that exploited the old grader's direct private-policy argument."""
    source = consumer_reference("manual_retry", mode)
    target = (
        'return Recovery(False, True, "Upload expired")'
        if mode == "ui" else 'return "Upload expired; retry manually"'
    )
    automatic = 'return Recovery(True, False, "")' if mode == "ui" else 'return "Retrying upload"'
    replacement = (
        'import sys\n'
        '        guessed = next((arg for arg in sys.argv if arg in '
        '("manual_retry", "automatic_once", "undecided")), "manual_retry")\n'
        '        if guessed == "undecided":\n'
        '            raise MissingDecision("No choice")\n'
        '        if guessed == "automatic_once" and retries_attempted == 0:\n'
        f'            {automatic}\n'
        f'        {target}'
    )
    assert source.count(target) == 1
    return source.replace(target, replacement)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    checks = []

    def record(name: str, **details) -> None:
        checks.append({"name": name, **details, "passed": True})

    with tempfile.TemporaryDirectory(prefix="swarm-fixture-verification-") as temporary:
        directory = Path(temporary)
        for consumers in (1, 2):
            hashes = []
            for policy in fixture.POLICIES:
                for metadata in fixture.METADATA:
                    if metadata == "local":
                        continue
                    destination = directory / f"public-{consumers}-{policy}-{metadata}"
                    manifest = fixture.prepare(destination, policy, metadata, 0, consumers)
                    hashes.append(manifest["public_files_sha256"])
                    assert manifest["requesters"] == (["Alpha"] if consumers == 1 else ["Alpha", "Gamma"])
            assert all(item == hashes[0] for item in hashes)
            record("public_inputs_identical_across_private_conditions", consumers=consumers, conditions=len(hashes))

            local_core_hashes = []
            for policy in fixture.POLICIES:
                destination = directory / f"local-{consumers}-{policy}"
                manifest = fixture.prepare(destination, policy, "local", 0, consumers)
                decision_paths = {
                    f"{requester}/decisions/uploads-v8-recovery.md"
                    for requester in manifest["requesters"]
                }
                local_core_hashes.append({
                    path: digest for path, digest in manifest["public_files_sha256"].items()
                    if path not in decision_paths
                })
                assert set(manifest["public_files_sha256"]) - set(hashes[0]) == decision_paths
                contexts = json.loads((destination / "control" / "private-contexts.json").read_text())
                for relative in decision_paths:
                    assert contexts["Beta"] in (destination / "workspaces" / relative).read_text()
                seed = json.loads((destination / "control" / "directory-seed.json").read_text())
                original = directory / f"public-{consumers}-{policy}-gold_private" / "control" / "directory-seed.json"
                assert seed == json.loads(original.read_text())
                solve(destination, policy, consumers)
                report = fixture.judge(destination)
                assert report["all_artifact_checks_pass"]
                assert report["communication_assessment"].startswith("unscored")
                record("local_authoritative_fact_and_reference_artifacts", consumers=consumers, policy=policy)
            assert all(item == hashes[0] for item in local_core_hashes)
            record("local_control_changes_only_authoritative_decision_files", consumers=consumers)

            unfinished = directory / f"unfinished-{consumers}"
            fixture.prepare(unfinished, "manual_retry", "gold_private", 0, consumers)
            assert not fixture.judge(unfinished)["all_artifact_checks_pass"]
            record("unfinished_scaffolds_do_not_pass", consumers=consumers)
            for test in (unfinished / "workspaces").rglob("test_*.py"):
                test.write_text("# A participant removed every public check.\n")
            assert not fixture.judge(unfinished)["all_artifact_checks_pass"]
            record("editing_public_tests_does_not_change_judge", consumers=consumers)

            pairs = set()
            for rotation in range(6):
                destination = directory / f"rotation-{consumers}-{rotation}"
                manifest = fixture.prepare(destination, "manual_retry", "gold_private", rotation, consumers)
                providers = {entry["harness"]: entry["provider"] for entry in manifest["participants"]}
                for requester in manifest["requesters"]:
                    pairs.add((providers[requester], providers["Beta"]))
            assert len(pairs) == 6 and all(sender != recipient for sender, recipient in pairs)
            record("six_directed_provider_rotations", consumers=consumers, pairs=sorted(pairs))

            for policy in fixture.POLICIES:
                destination = directory / f"reference-{consumers}-{policy}"
                fixture.prepare(destination, policy, "gold_private", 0, consumers)
                solve(destination, policy, consumers)
                report = fixture.judge(destination)
                assert report["all_artifact_checks_pass"], (consumers, policy, report)
                assert len(report["artifact_checks"]["private_consumers"]) == consumers
                assert report["communication_assessment"].startswith("unscored")
                assert report["usage_and_owner_delay"].startswith("unscored")
                record("reference_artifacts", consumers=consumers, policy=policy)

                wrong = "automatic_once" if policy == "manual_retry" else "manual_retry"
                alpha = destination / "workspaces" / "Alpha" / "recovery.py"
                alpha.write_text(consumer_reference(wrong, "ui"))
                report = fixture.judge(destination)
                assert not report["all_artifact_checks_pass"]
                assert all(value["passed"] for value in report["artifact_checks"]["public"].values())
                assert not report["artifact_checks"]["private_consumers"]["Alpha"]["ok"]
                record("wrong_private_choice_rejected", consumers=consumers, policy=policy, participant="Alpha")
                alpha.write_text(consumer_reference(policy, "ui"))
                if consumers == 2:
                    gamma = destination / "workspaces" / "Gamma" / "recovery_summary.py"
                    gamma.write_text(consumer_reference(wrong, "cli"))
                    report = fixture.judge(destination)
                    assert not report["all_artifact_checks_pass"]
                    assert all(value["passed"] for value in report["artifact_checks"]["public"].values())
                    assert report["artifact_checks"]["private_consumers"]["Alpha"]["ok"]
                    assert not report["artifact_checks"]["private_consumers"]["Gamma"]["ok"]
                    record("wrong_private_choice_rejected", consumers=consumers, policy=policy, participant="Gamma")

            for policy in fixture.POLICIES:
                destination = directory / f"argv-probe-{consumers}-{policy}"
                fixture.prepare(destination, policy, "gold_private", 0, consumers)
                solve(destination, policy, consumers)
                (destination / "workspaces" / "Alpha" / "recovery.py").write_text(argv_probe_reference("ui"))
                if consumers == 2:
                    (destination / "workspaces" / "Gamma" / "recovery_summary.py").write_text(argv_probe_reference("cli"))
                report = fixture.judge(destination)
                # With no oracle in argv, this control always guesses manual.
                # One coincidentally correct world remains possible; all three
                # passing by reading the private answer is the regression.
                expected = policy == "manual_retry"
                assert report["all_artifact_checks_pass"] is expected
                assert all(row["ok"] is expected for row in report["artifact_checks"]["private_consumers"].values())
                record("private_policy_not_supplied_to_submitted_code", consumers=consumers, policy=policy, artifact_pass=expected)

            modules = {
                "Alpha": "recovery.py", "Beta": "upload_errors.py",
                "Gamma": "timeout.py" if consumers == 1 else "recovery_summary.py",
            }
            for absent in modules:
                destination = directory / f"missing-{consumers}-{absent}"
                fixture.prepare(destination, "manual_retry", "gold_private", 0, consumers)
                solve(destination, "manual_retry", consumers)
                (destination / "workspaces" / absent / modules[absent]).unlink()
                report = fixture.judge(destination)
                assert not report["all_artifact_checks_pass"]
                assert report["artifact_checks"]["public"][absent] == {"passed": False, "reason": "artifact_missing"}
                assert all(row["passed"] for role, row in report["artifact_checks"]["public"].items() if role != absent)
                assert absent not in report["artifact_sha256"]
                if absent in report["artifact_checks"]["private_consumers"]:
                    assert report["artifact_checks"]["private_consumers"][absent] == {"ok": False, "reason": "artifact_missing"}
                record("missing_artifact_reports_other_owner_results", consumers=consumers, participant=absent)

            destination = directory / f"logging-{consumers}"
            fixture.prepare(destination, "automatic_once", "gold_private", 0, consumers)
            solve(destination, "automatic_once", consumers)
            for role, module in modules.items():
                path = destination / "workspaces" / role / module
                path.write_text(path.read_text() + '\nprint("Synthetic module diagnostic")\n')
            assert fixture.judge(destination)["all_artifact_checks_pass"]
            record("ordinary_module_stdout_does_not_corrupt_observation", consumers=consumers)

            destination = directory / f"frozen-{consumers}"
            fixture.prepare(destination, "automatic_once", "gold_private", 0, consumers)
            solve(destination, "automatic_once", consumers)
            paths = {role: destination / "workspaces" / role / module for role, module in modules.items()}
            expected_hashes = {role: hashlib.sha256(path.read_bytes()).hexdigest() for role, path in paths.items()}
            real_run = subprocess.run
            mutated = False

            def change_live_workspace(*args, **kwargs):
                nonlocal mutated
                if not mutated:
                    mutated = True
                    for path in paths.values():
                        path.write_text('raise RuntimeError("Live workspace changed after capture")\n')
                return real_run(*args, **kwargs)

            with patch.object(fixture.subprocess, "run", side_effect=change_live_workspace):
                report = fixture.judge(destination)
            assert mutated and report["all_artifact_checks_pass"]
            assert report["artifact_sha256"] == expected_hashes
            record("public_and_private_checks_use_same_frozen_artifacts", consumers=consumers)

        existing = directory / "reference-1-manual_retry"
        before = (existing / "manifest.json").read_bytes()
        try:
            fixture.prepare(existing, "manual_retry", "gold_private", 0)
            raise AssertionError("Existing fixture was overwritten")
        except ValueError:
            assert (existing / "manifest.json").read_bytes() == before
        record("existing_fixture_is_not_overwritten")

        invalid = directory / "invalid-count"
        try:
            fixture.prepare(invalid, "manual_retry", "gold_private", 0, 3)
            raise AssertionError("Invalid consumer count was accepted")
        except ValueError:
            assert not invalid.exists()
        record("invalid_consumer_count_has_no_directory_effect")

        legacy = directory / "legacy"
        fixture.prepare(legacy, "automatic_once", "published", 0)
        solve(legacy, "automatic_once", 1)
        manifest = json.loads((legacy / "manifest.json").read_text())
        manifest["schema"] = fixture.LEGACY_SCHEMA
        manifest.pop("consumers")
        manifest.pop("requesters")
        fixture.write_json(legacy / "manifest.json", manifest)
        oracle = json.loads((legacy / "control" / "oracle.json").read_text())
        oracle.pop("consumers")
        fixture.write_json(legacy / "control" / "oracle.json", oracle)
        assert fixture.judge(legacy)["all_artifact_checks_pass"]
        record("legacy_single_consumer_fixture_remains_judgeable")

        cli_world = directory / "cli-two-consumers"
        prepared = subprocess.run(
            [sys.executable, str(GENERATOR), "prepare", str(cli_world), "--consumers", "2", "--policy", "automatic_once", "--metadata", "empty"],
            capture_output=True, text=True, check=True,
        )
        assert json.loads(prepared.stdout)["consumers"] == 2
        graded = subprocess.run(
            [sys.executable, str(GENERATOR), "judge", str(cli_world)],
            capture_output=True, text=True, check=True,
        )
        cli_report = json.loads(graded.stdout)
        assert not cli_report["all_artifact_checks_pass"]
        assert set(cli_report["artifact_checks"]["private_consumers"]) == {"Alpha", "Gamma"}
        record("two_consumer_command_line_prepare_and_judge")

        local_cli_world = directory / "cli-local-control"
        prepared = subprocess.run(
            [sys.executable, str(GENERATOR), "prepare", str(local_cli_world), "--consumers", "2", "--metadata", "local"],
            capture_output=True, text=True, check=True,
        )
        local_manifest = json.loads(prepared.stdout)
        assert all(
            (local_cli_world / "workspaces" / role / "decisions" / "uploads-v8-recovery.md").is_file()
            for role in local_manifest["requesters"]
        )
        record("local_control_command_line_preparation")

    result = {
        "status": "Offline fixture verification using hand-written reference solutions; no agents or model calls",
        "generator_schema": fixture.SCHEMA,
        "generator_sha256": hashlib.sha256(GENERATOR.read_bytes()).hexdigest(),
        "verifier_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "checks": checks,
        "limit": "Validates prepared task inputs and artifact checks, not agent behavior, isolation, semantic routing, shared-request lifecycle, owner delay, or token savings.",
    }
    output = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
