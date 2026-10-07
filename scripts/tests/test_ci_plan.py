import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ci_plan", Path(__file__).resolve().parents[1] / "ci-plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class SelectionTests(unittest.TestCase):
    def test_docs_still_require_process_checks_and_assets_are_inputs(self):
        self.assertEqual(planner.select(["docs/guide.md", "README.md"])[0], set())
        self.assertEqual(planner.select(["docs/images/poster.png"])[0], {"desktop"})

    def test_cli_and_process_changes_keep_conservative_core_coverage(self):
        for path in ["scripts/merge-validated-pr.py", "Makefile"]:
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], planner.CORE)

    def test_cli_changes_include_phone_protocol_contracts(self):
        self.assertEqual(planner.select(["cli/src/lib/relayFrames.ts"])[0], planner.CORE | {"mobile"})

    def test_shared_planner_or_job_graph_changes_validate_every_component(self):
        for path in ["scripts/ci-plan.py", ".github/workflows/ci.yml"]:
            self.assertEqual(planner.select([path])[0], planner.SUITES)

    def test_known_component_and_browser_inputs(self):
        for path, expected in {
            "website/app/page.tsx": {"website"}, "os/root/usr/lib/session": {"os"},
            "mobile/pubspec.lock": {"mobile", "desktop"}, "tui/src/main.rs": {"tui"},
            "provider/spec.md": {"provider"}, "devices/harness-device/firmware/main/main.c": {"firmware", "cli", "desktop"},
            "store/agents/home-assistant/src/a.py": {"desktop", "experience", "home-assistant"},
            "store/tools/runtimes.sh": {"desktop", "experience", "home-assistant", "authoring"},
            "desktop/test/log_redact_test.dart": {"desktop", "desktop-logging"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)

    def test_unknown_paths_fail_instead_of_getting_an_empty_green_plan(self):
        for path in ["new-component/code.ts", "surprise.py", "../cli/code.ts", "/absolute"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                planner.select([path])


class GitPlanTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")
        self.write("README.md", "base")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def write(self, path, value="content"):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def plan(self, event="pull_request", base=None):
        head = self.git("rev-parse", "HEAD")
        base = base or self.base
        payload = ({"pull_request": {"head": {"sha": head}, "base": {"sha": base}}} if event == "pull_request" else
                   {"action": "checks_requested", "merge_group": {"head_sha": head, "base_sha": base}})
        return planner.make_plan(self.root, event, payload, source=head)

    def test_all_paths_are_read_even_above_github_file_limits(self):
        for index in range(350):
            self.write(f"docs/page-{index}.md")
        self.write("website/changed.ts")
        self.commit()
        plan = self.plan()
        self.assertEqual(len(plan["paths"]), 351)
        self.assertEqual(plan["suites"], ["website"])

    def test_rename_selects_old_and_new_components(self):
        self.write("website/source.txt")
        self.base = self.commit()
        self.write("os/moved.txt")
        (self.root / "website/source.txt").unlink()
        self.commit()
        self.assertEqual(set(self.plan()["suites"]), {"os", "website"})

    def test_pr_uses_merge_base_without_claiming_unrelated_main_changes(self):
        self.write("os/new.txt")
        main = self.commit()
        self.git("checkout", "--detach", self.base)
        self.write("website/new.txt")
        self.commit()
        self.assertEqual(self.plan(base=main)["suites"], ["website"])

    def test_group_includes_every_change_ahead_of_this_pr(self):
        self.write("website/new.txt")
        self.commit()
        self.write("os/new.txt")
        self.commit()
        plan = self.plan("merge_group")
        self.assertEqual(set(plan["suites"]), {"os", "website"})
        self.assertEqual(plan["base"], self.base)

    def test_wrong_head_event_or_nonancestor_group_fails(self):
        head = self.git("rev-parse", "HEAD")
        for event, payload in [
            ("pull_request", {"pull_request": {"head": {"sha": "f" * 40}, "base": {"sha": self.base}}}),
            ("merge_group", {"action": "destroyed", "merge_group": {"head_sha": head, "base_sha": self.base}}),
            ("push", {}),
        ]:
            with self.subTest(event=event), self.assertRaises(ValueError):
                planner.make_plan(self.root, event, payload, source=head)
        self.write("os/later.txt")
        future = self.commit()
        self.git("checkout", "--detach", self.base)
        with self.assertRaises(subprocess.CalledProcessError):
            self.plan("merge_group", base=future)

    def test_manual_scopes_remain_explicit_and_invalid_scopes_fail(self):
        self.assertEqual(planner.make_plan(self.root, "workflow_dispatch", {}, "process")["required_jobs"], ["process-checks"])
        self.assertEqual(set(planner.make_plan(self.root, "workflow_dispatch", {}, "all")["suites"]), planner.SUITES)
        with self.assertRaises(ValueError):
            planner.make_plan(self.root, "workflow_dispatch", {}, "typo")


class GateTests(unittest.TestCase):
    def setUp(self):
        self.head = "a" * 40
        self.plan = dict(schema=1, kind="ci-plan", head=self.head, tree="b" * 40, event="merge_group", base="c" * 40,
                         suites=["desktop"], required_jobs=sorted({"process-checks"} | planner.JOBS["desktop"]))
        self.needs = {name: {"result": "success"} for name in self.plan["required_jobs"] + ["plan"]}
        self.needs["cli-tests"] = {"result": "skipped"}

    def test_gate_accepts_only_explicit_nonapplicable_skips(self):
        result = planner.verify(self.plan, self.needs, self.head)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["source_sha"], self.head)

    def test_missing_skipped_cancelled_or_failed_required_job_blocks(self):
        for status in [None, "skipped", "cancelled", "failure", "in_progress"]:
            needs = copy.deepcopy(self.needs)
            if status is None:
                del needs["desktop-tests"]
            else:
                needs["desktop-tests"]["result"] = status
            with self.subTest(status=status), self.assertRaises(ValueError):
                planner.verify(self.plan, needs, self.head)

    def test_unplanned_failure_or_failed_planning_cannot_be_hidden(self):
        for job in ["cli-tests", "plan"]:
            needs = copy.deepcopy(self.needs)
            needs[job]["result"] = "failure"
            with self.assertRaises(ValueError):
                planner.verify(self.plan, needs, self.head)

    def test_malformed_incomplete_or_wrong_source_plan_is_rejected(self):
        for patch in [{"head": "d" * 40}, {"tree": "bad"}, {"required_jobs": ["process-checks"]},
                      {"suites": ["unknown"]}, {"suites": ["desktop", "desktop"]}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                planner.verify(dict(self.plan, **patch), self.needs, self.head)


if __name__ == "__main__":
    unittest.main()
