import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("local_receipt_planner", SCRIPTS / "ci-plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)
checks = planner.local_checks


def receipt(check="cli-core", **changes):
    return dict(dict(check=check, command="npm run test:core", cwd="cli", head="a" * 40,
                     passed=12, status="passed", platform="macos"), **changes)


def plan(paths=("cli/src/core/agents/create.ts",), **changes):
    return dict(dict(schema=1, kind="ci-plan", event="pull_request", draft=False, head="a" * 40,
                     tree="b" * 40, base="c" * 40, paths=list(paths), suites=["cli"], reused={},
                     required_jobs=["cli-tests", "cli-typecheck", "process-checks"], local_checks=["cli-core"]), **changes)


def train(members=(("d" * 40, ["cli-core"]), ("e" * 40, [])), **changes):
    return plan(train_members=[dict(head=head, local_checks=checks) for head, checks in members], **changes)


def needs(receipts=None):
    result = {name: dict(result="success") for name in ("plan", "process-checks", "cli-tests", "cli-typecheck")}
    if receipts is not None:
        result["process-checks"]["outputs"] = dict(local_receipts=json.dumps(receipts))
    return result


# What the fake checks print and do, in the throwaway repository's cli/: Vitest's summary without a suite.
FAKE = r"""
import pathlib, subprocess, sys, time

def summary(n):
    print(f"\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m{n} passed\x1b[39m\x1b[22m\x1b[90m ({n})\x1b[39m", flush=True)

mode = sys.argv[1]
if mode == "pass":
    summary(sys.argv[2])
elif mode == "mark":
    pathlib.Path(sys.argv[2]).write_text("ran\n")
    summary(1)
elif mode == "fail":
    print("      Tests  1 failed | 2 passed (3)")
    sys.exit(1)
elif mode == "nocount":
    print("ok")
elif mode == "skipped":
    print("      Tests  2 skipped (2)")
elif mode == "long":
    summary(4)
    sys.stdout.buffer.write(b"\xff src/file.ts | 100 | 100 | 100 | 100 |\n" * 6000)
elif mode == "move":
    subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "moved"], check=True)
    summary(1)
elif mode == "litter":
    pathlib.Path("left-behind.txt").write_text("left\n")
    summary(1)
elif mode == "hang":
    # Passed, not inherited, so the child holds the pipe on Windows too.
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], stdout=sys.stdout)
    time.sleep(600)
"""


def fake(mode, platform=None, area="a"):
    return dict(command=f'"{sys.executable}" fake.py {mode}', cwd="cli", platform=platform, paths=(f"area/{area}/*",))


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

    def test_the_desktop_suite_may_set_its_budget_and_workers_but_never_narrow_its_tests(self):
        p = plan(["desktop/macos/Runner/MainFlutterWindow.swift"], local_checks=["desktop-macos"])

        def desktop(command):
            return receipt("desktop-macos", command=command, cwd=".", platform="macos")

        for command in ['make desktop-test', 'make desktop-test ARGS="--timeout 3600"',
                        'make desktop-test ARGS="--workers 4"',
                        'make desktop-test ARGS="--workers 4 --timeout 3600"']:
            with self.subTest(command=command):
                self.assertEqual(planner.verify(p, needs([desktop(command)]), "a" * 40)["local_receipts"],
                                 [desktop(command)])
        for command in ['make desktop-test ARGS="test/one_test.dart"',
                        'make desktop-test ARGS="--timeout 3600 test/one_test.dart"',
                        'make desktop-test ARGS="--timeout 3600 --timeout 60"',
                        'make desktop-test ARGS="--workers 0"', 'make desktop-test ARGS="--timeout -1"',
                        'make desktop-test ARGS="--timeout 1e9"', 'make desktop-test ARGS="--timeout  3600"',
                        'make desktop-test ARGS=""', 'make desktop-test ARGS="--plain-name x"',
                        'make desktop-test ARGS="--workers 4"; touch x', "make desktop-test ARGS='--workers 4'",
                        'make desktop-test ARGS="--workers 999"', 'make desktop-test ARGS="--timeout 1"',
                        'make desktop-test ARGS="--workers=4"', 'make desktop-test -- --maxWorkers=2']:
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, "desktop-macos"):
                planner.verify(p, needs([desktop(command)]), "a" * 40)
        with self.assertRaisesRegex(ValueError, "cli-core"):
            planner.verify(plan(), needs([receipt(command='npm run test:core ARGS="--workers 4"')]), "a" * 40)

    def test_multiple_checks_need_all_receipts(self):
        p = plan(["cli/src/core/api.ts", "cli/src/harnessd/main.ts"], local_checks=["cli-core", "cli-harnessd"])
        with self.assertRaisesRegex(ValueError, "cli-harnessd"):
            planner.verify(p, needs([receipt()]), "a" * 40)

    # Train #4115, 2026-11-11: its head is a merge commit nobody ran anything on, so no cli-core receipt could name it, and
    # no CLI pull request could land.
    def test_a_train_needs_each_member_receipt_at_that_member_head(self):
        member = receipt(head="d" * 40)
        self.assertEqual(planner.verify(train(), needs([member]), "a" * 40)["local_receipts"], [member])
        for receipts in ([], [receipt()], [receipt(head="e" * 40)], [receipt(head="f" * 40)]):
            with self.subTest(receipts=receipts), self.assertRaisesRegex(ValueError, "cli-core at ddddddd"):
                planner.verify(train(), needs(receipts), "a" * 40)

    def test_every_member_of_a_train_needs_its_own_receipts(self):
        p = train([("d" * 40, ["cli-core"]), ("e" * 40, ["cli-core", "cli-harnessd"])],
                  paths=["cli/src/core/api.ts", "cli/src/harnessd/main.ts"], local_checks=["cli-core", "cli-harnessd"])
        with self.assertRaisesRegex(ValueError, r"receipts: cli-core at eeeeeee, cli-harnessd at eeeeeee\."):
            planner.verify(p, needs([receipt(head="d" * 40)]), "a" * 40)
        every = [receipt(head="d" * 40), receipt(head="e" * 40),
                 receipt("cli-harnessd", command="npm run test:harnessd", head="e" * 40)]
        self.assertEqual(planner.verify(p, needs(every[::-1]), "a" * 40)["local_receipts"], every)

    def test_a_train_plan_cannot_drop_or_move_what_its_paths_need(self):
        for members in [[], [("d" * 40, [])], [("d" * 40, ["cli-core"]), ("d" * 40, [])], [("d" * 7, ["cli-core"])],
                        [("d" * 40, ["cli-core", "cli-core"])], [("d" * 40, ["cli-harnessd", "cli-core"])],
                        [("d" * 40, ["cli-core", "unknown"])], [("d" * 40, "cli-core")],
                        [(f"{i:040x}", ["cli-core"]) for i in range(21)]]:
            p = train(members) if members else plan(train_members="not a list")
            with self.subTest(members=members), self.assertRaisesRegex(ValueError, "local check"):
                planner.verify(p, needs([receipt(head="d" * 40)]), "a" * 40)

    def test_a_refused_body_says_how_to_make_the_receipts(self):
        with self.assertRaisesRegex(ValueError, r"receipts: cli-core\. Run python3 scripts/local-checks\.py --run "):
            planner.verify(plan(), needs(), "a" * 40)

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

    def test_a_train_passes_with_its_members_receipts_and_fails_without(self):
        result, output = self.run_check("Harness's train into main", train())
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("cli-core at ddddddd", result.stderr)
        self.assertEqual(output, "")
        result, output = self.run_check(self.body([receipt(head="d" * 40)]), train())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.removeprefix("local_receipts=")), [receipt(head="d" * 40)])

    def test_event_source_mismatch_fails_and_drafts_do_not_need_receipts(self):
        result, _ = self.run_check(self.body([receipt()]), event_head="f" * 40)
        self.assertEqual(result.returncode, 1)
        result, output = self.run_check("", plan(draft=True))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.removeprefix("local_receipts=")), [])


class GitFixture:
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

    def write(self, path, text="fixture\n"):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")


class LocalMappingTests(GitFixture, unittest.TestCase):
    def select(self, ref="pip/1"):
        head = self.git("rev-parse", "HEAD")
        event = dict(pull_request=dict(head=dict(sha=head, ref=ref), base=dict(sha=self.base)))
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

    def test_dependency_and_shared_test_setup_changes_require_every_cli_check(self):
        for path in ("cli/package-lock.json", "cli/src/__fixtures__/vitestRun.ts"):
            with self.subTest(path=path):
                self.git("reset", "--hard", self.base)
                self.write(path)
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

    def branch(self, name, path):
        self.git("checkout", "-qb", name, self.base)
        self.write(path)
        return self.commit()

    def test_a_train_names_each_member_head_with_the_checks_its_own_merge_needs(self):
        core, docs = self.branch("pip/1", "cli/src/core/agents/create.ts"), self.branch("pip/2", "docs/guide.md")
        self.git("checkout", "-qb", "harness-train/1", self.base)
        self.git("merge", "-q", "--no-ff", "-m", "Train: #1", core)
        self.git("merge", "-q", "--no-ff", "-m", "Train: #2", docs)
        train = self.select("harness-train/1")
        self.assertEqual(train["local_checks"], ["cli-core"])
        self.assertEqual(train["train_members"], [dict(head=core, local_checks=["cli-core"]),
                                                  dict(head=docs, local_checks=[])])
        # The same commits on any other branch are one pull request's, whose receipt names its own head.
        self.assertEqual(self.select("pip/3")["train_members"], [])

    def test_what_a_train_merge_adds_beyond_its_member_is_that_member_to_prove(self):
        docs = self.branch("pip/2", "docs/guide.md")
        self.git("checkout", "-qb", "harness-train/1", self.base)
        self.git("merge", "-q", "--no-ff", "--no-commit", docs)
        self.write("cli/src/harnessd/main.ts")
        self.commit()
        self.assertEqual(self.select("harness-train/1")["train_members"], [dict(head=docs, local_checks=["cli-harnessd"])])

    def test_a_train_branch_with_a_commit_that_merges_no_member_has_no_plan(self):
        core = self.branch("pip/1", "cli/src/core/agents/create.ts")
        self.git("checkout", "-qb", "harness-train/1", self.base)
        self.git("merge", "-q", "--no-ff", "-m", "Train: #1", core)
        self.write("cli/src/harnessd/main.ts")
        self.commit()
        with self.assertRaisesRegex(ValueError, "train"):
            self.select("harness-train/1")


class LocalRunRuleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "cli").mkdir()
        (self.root / "cli/package.json").write_text(json.dumps(dict(scripts={
            "test:core": "vitest run --config vitest.core.config.ts",
            "test:orchestrator": "vitest run src/orchestrator --maxWorkers=1 --coverage",
            "test:terminal-contract": "vitest run a.spec.ts --maxWorkers=1 --passWithNoTests"})))

    def test_the_platform_is_the_running_os(self):
        for name, expected in (("darwin", "macos"), ("linux", "linux"), ("win32", "windows"), ("freebsd14", None)):
            with mock.patch.object(checks.sys, "platform", name):
                self.assertEqual(checks.host_platform(), expected)

    def test_run_adds_only_the_caps_validation_accepts(self):
        with mock.patch.object(checks.os, "cpu_count", return_value=8):
            self.assertEqual(checks.run_command(self.root, "cli-core"), "npm run test:core -- --maxWorkers=4")
            # No such script in the fixture: capped, and the command then fails by itself.
            self.assertEqual(checks.run_command(self.root, "cli-harnessd"), "npm run test:harnessd -- --maxWorkers=4")
            for name in ("cli-serial", "cli-shell"):                 # npx vitest … --maxWorkers=1, as they are
                self.assertEqual(checks.run_command(self.root, name), checks.CHECKS[name]["command"])
            self.assertEqual(checks.run_command(self.root, "desktop-macos"), 'make desktop-test ARGS="--timeout 3600"')
        for cpus, workers in ((1, 1), (None, 1), (3, 1), (400, 99)):
            with mock.patch.object(checks.os, "cpu_count", return_value=cpus):
                self.assertEqual(checks.run_command(self.root, "cli-core"), f"npm run test:core -- --maxWorkers={workers}")

    # Vitest refuses --maxWorkers twice, and cli/package.json sets it inside test:orchestrator and test:terminal-contract.
    def test_a_script_that_already_sets_max_workers_gets_no_cap_and_a_plain_receipt(self):
        package = self.root / "cli/package.json"
        with mock.patch.object(checks.os, "cpu_count", return_value=8):
            for name, command in (("cli-orchestrator", "npm run test:orchestrator"),
                                  ("cli-pty", "npm run test:terminal-contract")):
                self.assertEqual(checks.run_command(self.root, name), command)
                r = receipt(name, command=command, cwd="cli", platform="macos")
                self.assertEqual(checks.validate_receipts({"a" * 40: [name]}, [r]), [r])
            # A package.json that cannot be read is no reason to drop the cap, and never a traceback.
            for text in ("not json", "[]", '{"scripts": []}', '{"scripts": {"test:orchestrator": 1}}', None):
                package.write_text(text) if text is not None else package.unlink()
                self.assertEqual(checks.run_command(self.root, "cli-orchestrator"),
                                 "npm run test:orchestrator -- --maxWorkers=4")

    def test_every_command_run_makes_a_receipt_validation_accepts(self):
        for name, contract in checks.CHECKS.items():
            r = receipt(name, command=checks.run_command(self.root, name), cwd=contract["cwd"],
                        platform=contract["platform"] or "linux")
            self.assertEqual(checks.validate_receipts({"a" * 40: [name]}, [r]), [r])

    def test_the_count_is_the_last_vitest_summary_without_colour(self):
        for output, count in [
                (" Test Files  2 passed (2)\n      Tests  12 passed (12)\n", 12),
                ("\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m7 passed\x1b[39m\x1b[22m\x1b[90m (7)\x1b[39m\n", 7),
                ("      Tests  1 failed | 5 passed (6)\n", 5), ("      Tests  3 passed | 2 skipped (5)\r\n", 3),
                ("      Tests  999 passed (999)\nlater\n      Tests  4 passed (4)\n", 4),
                ("      Tests  2 skipped (2)\n", 0), (" Test Files  2 passed (2)\n", 0), ("12 passed\n", 0), ("", 0)]:
            self.assertEqual(checks.passed_count("cli-core", output), count)

    def test_the_desktop_count_comes_from_the_receipt_its_output_names(self):
        path = self.root / "receipt.json"
        path.write_text(json.dumps(dict(status="passed", coverage=dict(files=3, passed=41, skipped=1))))
        self.assertEqual(checks.passed_count("desktop-macos", f"desktop-vm: 41 passed\npassed: {path}\n"), 41)
        self.assertEqual(checks.passed_count("desktop-macos", f"passed_after_startup_retry: {path}\n"), 41)
        for output in (f"failed: {path}\n", "passed: /nowhere/receipt.json\n", "      Tests  12 passed (12)\n", ""):
            self.assertEqual(checks.passed_count("desktop-macos", output), 0)
        for bad in ("not json", "[]", '{"coverage": {"passed": "41"}}', '{"coverage": {"passed": true}}'):
            path.write_text(bad)
            self.assertEqual(checks.passed_count("desktop-macos", f"passed: {path}\n"), 0)


class LocalRunTests(GitFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.write("cli/fake.py", FAKE)
        self.base = self.commit()
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        self.marker = Path(outside.name) / "marker"

    def change(self, *areas):
        for area in areas:
            self.write(f"area/{area}/1")
        return self.commit()

    def run_checks(self, table, base=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(checks.CHECKS, table, clear=True):
            code = checks.run(self.root, base or self.base, out, err)
        return code, out.getvalue(), err.getvalue()

    def cli(self, *args, cwd=None):
        return subprocess.run([sys.executable, SCRIPTS / "local-checks.py", *args], cwd=cwd or self.root,
                              text=True, capture_output=True, timeout=60)

    def test_the_printed_fence_is_what_ci_accepts_at_this_head(self):
        self.write(".gitignore", "ignored/\n")
        head = self.change("a", "b")
        self.write("ignored/log")                                    # an ignored file leaves the tree clean
        table = {"fake-b": fake("pass 5", area="b"), "fake-a": fake("pass 3", area="a")}
        code, out, err = self.run_checks(table)
        receipts = [dict(check=name, command=table[name]["command"], cwd="cli", head=head, status="passed",
                         passed=passed, platform=checks.host_platform()) for name, passed in (("fake-a", 3), ("fake-b", 5))]
        self.assertEqual(code, 0, err)
        self.assertEqual(out, "```harness-local-checks\n" + json.dumps(receipts, indent=2) + "\n```\n")
        self.assertIn("3 passed", err)                               # a check's output streams to stderr
        event = dict(pull_request=dict(head=dict(sha=head), body="What changed\n\n" + out))
        with mock.patch.dict(checks.CHECKS, table, clear=True):
            self.assertEqual(checks.check(plan(["area/a/1", "area/b/1"], head=head,
                                               local_checks=["fake-a", "fake-b"]), event), receipts)

    def test_a_dirty_tree_is_refused_before_anything_runs(self):
        self.change("a")
        for dirty in ("staged", "unstaged", "untracked"):
            with self.subTest(dirty=dirty):
                self.git("reset", "-q", "--hard"), self.git("clean", "-qfd")
                (self.root / ("new.txt" if dirty == "untracked" else "README.md")).write_text("changed\n")
                if dirty == "staged":
                    self.git("add", "README.md")
                code, out, err = self.run_checks({"fake-a": fake(f'mark "{self.marker}"')})
                self.assertEqual((code, out, err), (1, "", "Local checks not run: the tree has uncommitted changes.\n"))
                self.assertFalse(self.marker.exists())

    def test_the_checks_are_the_ones_the_paths_since_the_base_need(self):
        first = self.change("a")
        (self.root / "area/a/1").unlink(), self.write("area/c/1"), self.write("area/b/1"), self.commit()
        table = {f"fake-{area}": fake("pass 1", area=area) for area in "abcd"}
        names = lambda result: [r["check"] for r in json.loads(checks.FENCE.findall(result[1])[0])]
        self.assertEqual(names(self.run_checks(table, base=first)), ["fake-a", "fake-b", "fake-c"])  # a move counts twice
        self.assertEqual(names(self.run_checks(table)), ["fake-b", "fake-c"])

    def test_no_required_check_prints_nothing_and_passes(self):
        self.write("docs/guide.md"), self.commit()
        self.assertEqual(self.run_checks({"fake-a": fake("fail")}), (0, "", "No local check is required.\n"))

    def test_every_failed_check_is_named_and_no_fence_is_printed(self):
        self.change("a", "b", "c", "d")
        code, out, err = self.run_checks({"fake-a": fake("fail", area="a"), "fake-b": fake(f'mark "{self.marker}"', area="b"),
                                          "fake-c": fake("nocount", area="c"), "fake-d": fake("skipped", area="d")})
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(self.marker.exists())                        # a later check runs after one fails
        self.assertTrue(err.endswith("fake-a failed: exit 1\nfake-c failed: no passed count\nfake-d failed: no passed count\n"))

    def test_a_check_for_another_platform_is_refused_before_anything_runs(self):
        self.change("a", "b")
        host = checks.host_platform()
        other = "linux" if host == "macos" else "macos"
        table = {"fake-a": fake(f'mark "{self.marker}"', area="a"), "fake-b": fake("pass 1", platform=other, area="b")}
        self.assertEqual(self.run_checks(table), (1, "", f"Local checks not run: fake-b needs {other}; this is {host}.\n"))
        with mock.patch.object(checks, "host_platform", return_value=None):
            self.assertEqual(self.run_checks(table), (1, "", "Local checks not run: this is not macOS, Linux or Windows.\n"))
        self.assertFalse(self.marker.exists())

    def test_a_run_that_moves_head_or_dirties_the_tree_is_void(self):
        self.change("a")
        for mode in ("move", "litter"):
            with self.subTest(mode=mode):
                code, out, err = self.run_checks({"fake-a": fake(mode)})
                self.assertEqual((code, out), (1, ""))
                self.assertTrue(err.endswith("Local checks void: HEAD or the tree changed during the run.\n"))
                self.git("clean", "-qfd")

    # The child holds the check's stdout, so run() returns only once the whole group is dead. Asking the process table
    # instead would be flaky: a killed orphan stays a zombie until init reaps it.
    def test_a_check_past_its_limit_is_killed_with_its_children_and_named(self):
        self.change("a", "b")
        started = time.monotonic()
        with mock.patch.object(checks, "RUN_SECONDS", 3):
            code, out, err = self.run_checks({"fake-a": fake("hang", area="a"),
                                              "fake-b": fake(f'mark "{self.marker}"', area="b")})
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err.endswith("fake-a failed: timed out\n"))
        self.assertTrue(self.marker.exists())
        self.assertLess(time.monotonic() - started, 60)

    def test_the_count_survives_a_long_report_after_the_summary(self):
        self.change("a")
        code, out, err = self.run_checks({"fake-a": fake("long")})
        self.assertEqual((code, json.loads(checks.FENCE.findall(out)[0])[0]["passed"]), (0, 4))
        self.assertGreater(len(err), 200000)                         # all of it streamed

    def test_a_command_validation_would_refuse_never_becomes_a_fence(self):
        self.change("a")
        out = io.StringIO()
        narrowed = lambda root, name: checks.CHECKS[name]["command"] + " -t one"
        with mock.patch.dict(checks.CHECKS, {"fake-a": fake("pass 3")}, clear=True), \
                mock.patch.object(checks, "run_command", narrowed), self.assertRaisesRegex(ValueError, "receipts: fake-a"):
            checks.run(self.root, self.base, out, io.StringIO())
        self.assertEqual(out.getvalue(), "")

    # Windows writes "\n" on a text stdout as "\r\n", and CI's FENCE takes no "\r" before the closing line, so main()
    # sets the line end itself. This stream does on every platform what a Windows stdout does.
    def test_the_fence_on_stdout_ends_its_lines_as_ci_reads_them(self):
        self.change("a")
        raw = io.BytesIO()
        stdout = io.TextIOWrapper(raw, encoding="utf-8", newline="\r\n")
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.root)
        with mock.patch.dict(checks.CHECKS, {"fake-a": fake("pass 3")}, clear=True), \
                mock.patch.object(sys, "argv", ["local-checks.py", "--run", "--base", self.base]), \
                mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", io.StringIO()), \
                self.assertRaises(SystemExit) as done:
            checks.main()
        stdout.flush()
        self.assertEqual(done.exception.code, 0)
        self.assertNotIn(b"\r", raw.getvalue())
        self.assertEqual(len(checks.FENCE.findall(raw.getvalue().decode())), 1)

    def test_the_command_line_runs_from_any_folder_and_refuses_what_git_cannot_compare(self):
        self.write("docs/guide.md"), self.commit()
        result = self.cli("--run", "--base", self.base, cwd=self.root / "docs")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", "No local check is required.\n"))
        refused = "Local checks not run: git cannot compare the base with HEAD; fetch it or pass --base REF.\n"
        for args in (["--base=no-such-ref"], ["--base=--output=leak"], []):   # [] is origin/main, which is not here
            result = self.cli("--run", *args)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", refused))
        self.assertEqual(list(self.root.glob("leak*")), [])
        result = self.cli("--run", cwd=self.marker.parent)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "Local checks not run: this is not a git repository.\n"))
        self.assertEqual(self.cli("--run", "--list", "x").returncode, 2)
        self.assertEqual(json.loads(self.cli("--list", "cli/src/core/api.ts").stdout),
                         {"cli-core": dict(command="npm run test:core", cwd="cli", platform=None)})


class PullRequestTemplateTests(unittest.TestCase):
    # A body opened from the template and given --run's output must hold one fence: two are refused.
    def test_the_template_names_run_and_carries_no_fence_of_its_own(self):
        template = (SCRIPTS.parent / ".github/pull_request_template.md").read_text()
        self.assertIn("`python3 scripts/local-checks.py --run`", template)
        self.assertNotIn("--list", template)
        self.assertEqual(checks.FENCE.findall(template), [])


if __name__ == "__main__":
    unittest.main()
