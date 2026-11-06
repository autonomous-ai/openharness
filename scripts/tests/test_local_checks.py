import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("local_receipt_planner", SCRIPTS / "ci-plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def receipt(check="cli-core", **changes):
    return dict(dict(check=check, command="npm run test:core", cwd="cli", head="a" * 40,
                     passed=12, status="passed", platform="macos"), **changes)


def plan(paths=("cli/src/core/agents/create.ts",), **changes):
    return dict(dict(schema=1, kind="ci-plan", event="pull_request", draft=False, head="a" * 40,
                     tree="b" * 40, base="c" * 40, paths=list(paths), suites=["cli"], reused={},
                     required_jobs=["cli-tests", "cli-typecheck", "process-checks"], local_checks=["cli-core"]), **changes)


def needs(receipts=None):
    result = {name: dict(result="success") for name in ("plan", "process-checks", "cli-tests", "cli-typecheck")}
    if receipts is not None:
        result["process-checks"]["outputs"] = dict(local_receipts=json.dumps(receipts))
    return result


class LocalGateTests(unittest.TestCase):
    def test_shell_environment_and_quoting_changes_require_native_startup_evidence(self):
        for name in ("loginShellEnv", "userShell", "shellQuote"):
            with self.subTest(name=name):
                self.assertEqual(planner.local_checks.required_checks([f"cli/src/lib/{name}.ts"]), ["cli-shell"])

    def test_a_mapped_pr_cannot_pass_ci_required_without_local_evidence(self):
        with self.assertRaisesRegex(ValueError, "cli-core"):
            planner.verify(plan(), needs(), "a" * 40)

    def test_a_passing_receipt_is_retained_in_the_ci_required_artifact(self):
        result = planner.verify(plan(), needs([receipt()]), "a" * 40)
        self.assertEqual(result.get("local_receipts"), [receipt()])

    def test_bad_evidence_never_satisfies_the_gate(self):
        for change in [dict(head="d" * 40), dict(head="a" * 7), dict(passed=0), dict(passed=-1),
                       dict(passed=True), dict(passed="12"), dict(status="failed"), dict(status="skipped"),
                       dict(command="npm run test:core -- --testNamePattern one"), dict(cwd="backend"),
                       dict(platform="unknown")]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "cli-core"):
                planner.verify(plan(), needs([receipt(**change)]), "a" * 40)

    def test_a_missing_requirement_cannot_be_removed_from_the_plan(self):
        with self.assertRaisesRegex(ValueError, "local check"):
            planner.verify(plan(local_checks=[]), needs([]), "a" * 40)

    def test_the_required_macos_check_cannot_use_a_linux_receipt(self):
        p = plan(["desktop/macos/Runner/MainFlutterWindow.swift"], local_checks=["desktop-macos"])
        r = receipt("desktop-macos", command="make desktop-test", cwd=".", platform="linux")
        with self.assertRaisesRegex(ValueError, "desktop-macos"):
            planner.verify(p, needs([r]), "a" * 40)

    def test_multiple_checks_need_all_receipts(self):
        p = plan(["cli/src/core/api.ts", "cli/src/harnessd/main.ts"], local_checks=["cli-core", "cli-harnessd"])
        with self.assertRaisesRegex(ValueError, "cli-harnessd"):
            planner.verify(p, needs([receipt()]), "a" * 40)

    def test_unmapped_manual_and_merge_group_runs_keep_their_contract(self):
        for p in [plan(["README.md"], local_checks=[]), plan(event="merge_group", local_checks=[]),
                  plan(event="workflow_dispatch", local_checks=[])]:
            with self.subTest(event=p["event"]):
                self.assertEqual(planner.verify(p, needs(), "a" * 40)["status"], "passed")


class LocalProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_check(self, body, p=None, event_head=None):
        p = p or plan()
        event = self.root / "event.json"
        output = self.root / "output"
        output.write_text("")
        event.write_text(json.dumps(dict(pull_request=dict(head=dict(sha=event_head or p["head"]), body=body))))
        env = dict(os.environ, CI_PLAN=json.dumps(p), CI_SOURCE_SHA=p["head"], GITHUB_EVENT_PATH=str(event),
                   GITHUB_EVENT_NAME=p["event"], GITHUB_OUTPUT=str(output))
        result = subprocess.run([sys.executable, str(SCRIPTS / "local-checks.py")], env=env,
                                cwd=self.root, text=True, capture_output=True, timeout=10)
        return result, output.read_text()

    @staticmethod
    def body(receipts):
        return "Unrelated PR prose\n```harness-local-checks\n" + json.dumps(receipts) + "\n```\n"

    def test_the_process_check_fails_with_a_missing_list_and_passes_with_the_receipt(self):
        result, output = self.run_check("Tests pass, trust me")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("cli-core", result.stdout + result.stderr)
        self.assertEqual(output, "")
        result, output = self.run_check(self.body([receipt()]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.removeprefix("local_receipts=")), [receipt()])

    def test_receipt_text_is_data_never_a_command_or_error_payload(self):
        marker = self.root / "must-not-exist"
        secret = "private-content-do-not-echo"
        bad = receipt(command=f"touch {marker}; echo {secret}")
        result, _ = self.run_check(self.body([bad]))
        self.assertEqual(result.returncode, 1)
        self.assertFalse(marker.exists())
        self.assertNotIn(secret, result.stdout + result.stderr)

    def test_malformed_duplicate_overlarge_and_ambiguous_evidence_is_rejected(self):
        for body in ["```harness-local-checks\nnot json\n```", self.body([receipt(), receipt()]),
                     self.body([receipt()]) * 2, self.body([receipt()] * 33), "x" * 65537,
                     self.body({"not": "a list"}), self.body([None]), self.body([dict(head="a" * 40)])]:
            with self.subTest(length=len(body)):
                result, output = self.run_check(body)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(output, "")

    def test_event_source_mismatch_fails_and_drafts_do_not_need_receipts(self):
        result, _ = self.run_check(self.body([receipt()]), event_head="f" * 40)
        self.assertEqual(result.returncode, 1)
        result, output = self.run_check("", plan(draft=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.removeprefix("local_receipts=")), [])


class LocalMappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "maintenance.auto", "false")
        self.write("README.md")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True, stderr=subprocess.PIPE).strip()

    def write(self, path):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n")

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def select(self):
        head = self.git("rev-parse", "HEAD")
        event = dict(pull_request=dict(head=dict(sha=head), base=dict(sha=self.base)))
        return planner.make_plan(self.root, "pull_request", event, source=head)

    def test_each_local_area_is_selected_from_real_git_paths(self):
        cases = {
            "cli/src/core/agents/create.ts": ["cli-core"], "cli/src/services/edge.ts": ["cli-core"],
            "cli/src/harnessd/start.spec.ts": ["cli-harnessd"], "cli/src/lib/resumeStoppedAgent.ts": ["cli-resume"],
            "cli/src/orchestrator/main.ts": ["cli-orchestrator"], "cli/src/sharing/permissions.ts": ["cli-sharing"],
            "cli/src/lib/viewerForwarder.ts": ["cli-remote-viewers"], "cli/src/dsh/materialize.ts": ["cli-portability"],
            "cli/src/lib/localModels.ts": ["cli-local-models"], "cli/src/cable/serial.real.spec.ts": ["cli-serial"],
            "cli/src/lib/tmuxBackend.ts": ["cli-pty"], "cli/src/lib/ptyHost/stream.ts": ["cli-pty"],
            "pty/src/lib.rs": ["cli-pty"], "term/src/grid.rs": ["cli-pty"],
            "cli/src/lib/engineLaunch.ts": ["cli-shell"],
            "desktop/macos/Runner/MainFlutterWindow.swift": ["desktop-macos"],
            "desktop/test/macos_microphone_permission_test.dart": ["desktop-macos"],
            "desktop/lib/core/mac_responsibility_probe_native.dart": ["desktop-macos"],
            "cli/vitest.core.config.ts": ["cli-core"], "cli/vitest.viewer.config.ts": ["cli-remote-viewers"],
            "docs/guide.md": [], "cli/src/superTabs/cards.ts": [], "desktop/windows/runner/main.cpp": [],
            "cli/src/lib/viewerForwarderNote.md": [], "cli/src/coreish/other.ts": [],
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.git("reset", "--hard", self.base)
                self.write(path)
                self.commit()
                self.assertEqual(self.select().get("local_checks"), expected)

    def test_dependency_changes_require_every_cli_check(self):
        self.write("cli/package-lock.json")
        self.commit()
        self.assertEqual(self.select().get("local_checks"), ["cli-core", "cli-harnessd", "cli-local-models",
                         "cli-orchestrator", "cli-portability", "cli-pty", "cli-remote-viewers", "cli-resume",
                         "cli-serial", "cli-sharing", "cli-shell"])

    def test_deletes_and_renames_cannot_drop_the_old_area_even_when_sparse(self):
        self.write("cli/src/core/old.ts")
        self.base = self.commit()
        (self.root / "cli/src/core/old.ts").unlink()
        self.write("cli/src/harnessd/moved.ts")
        self.commit()
        self.git("sparse-checkout", "set", "scripts")
        self.assertEqual(self.select().get("local_checks"), ["cli-core", "cli-harnessd"])


if __name__ == "__main__":
    unittest.main()
