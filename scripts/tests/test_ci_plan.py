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
    def test_docs_workflows_scripts_and_unknown_paths_need_only_process_checks(self):
        for path in ["docs/guide.md", "README.md", "docs/images/poster.png", "scripts/ci-plan.py",
                     ".github/workflows/ci.yml", "Makefile", "store/tools/runtimes.sh", "surprise.py"]:
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], set())

    def test_each_component_selects_only_its_own_suite(self):
        for path, expected in {
            "cli/src/lib/relayFrames.ts": {"cli"}, "tests/fixture.ts": {"cli"},
            "desktop/test/log_redact_test.dart": {"desktop"}, "tui/src/main.rs": {"tui"},
            "backend/src/app.ts": {"backend"}, "companions/src/a.ts": {"companions"},
            "website/app/page.tsx": {"website"}, "os/root/usr/lib/session": {"os"},
            "provider/spec.md": {"provider"}, "devices/harness-device/firmware/main/main.c": {"firmware"},
            "mobile/pubspec.lock": {"mobile"}, "daemons/tools/card.mjs": {"daemons"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)

    def test_invalid_paths_fail(self):
        for path in ["../cli/code.ts", "/absolute", ""]:
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

    def plan(self, event="pull_request", base=None, draft=False):
        head = self.git("rev-parse", "HEAD")
        base = base or self.base
        payload = ({"pull_request": {"head": {"sha": head}, "base": {"sha": base}, "draft": draft}} if event == "pull_request" else
                   {"action": "checks_requested", "merge_group": {"head_sha": head, "base_sha": base}})
        return planner.make_plan(self.root, event, payload, source=head)

    def test_draft_preserves_required_coverage_for_ready_event(self):
        self.write("cli/src/lib/relayFrames.ts")
        self.commit()
        draft = self.plan(draft=True)
        ready = self.plan()
        self.assertTrue(draft["draft"])
        self.assertFalse(ready["draft"])
        self.assertEqual(draft["suites"], ready["suites"])
        self.assertEqual(draft["required_jobs"], ready["required_jobs"])
        self.assertIn("cli-tests", draft["required_jobs"])
        with self.assertRaisesRegex(ValueError, "invalid PR draft state"):
            self.plan(draft="false")

    def test_manual_and_merge_candidates_always_require_full_selected_validation(self):
        self.assertFalse(self.plan("merge_group")["draft"])
        self.assertFalse(planner.make_plan(self.root, "workflow_dispatch", {}, "all")["draft"])

    def test_all_paths_are_read_even_above_github_file_limits(self):
        for index in range(350):
            self.write(f"docs/page-{index}.md")
        self.write("website/changed.ts")
        self.commit()
        plan = self.plan()
        self.assertEqual(len(plan["paths"]), 351)
        self.assertEqual(plan["suites"], ["website"])

    def test_sparse_checkout_keeps_complete_component_selection(self):
        self.write("cli/src/changed.ts")
        self.write("desktop/lib/changed.dart")
        self.write("scripts/planner.py")
        self.commit()
        self.git("sparse-checkout", "set", ".github", "scripts")
        self.assertFalse((self.root / "cli/src/changed.ts").exists())
        plan = self.plan()
        self.assertEqual(plan["paths"], ["cli/src/changed.ts", "desktop/lib/changed.dart", "scripts/planner.py"])
        self.assertEqual(plan["suites"], ["cli", "desktop"])

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

    def test_group_records_every_change_but_reruns_only_process_checks(self):
        self.write("website/new.txt")
        self.commit()
        self.write("os/new.txt")
        self.commit()
        plan = self.plan("merge_group")
        self.assertEqual(plan["paths"], ["os/new.txt", "website/new.txt"])
        self.assertEqual(plan["suites"], [])
        self.assertEqual(plan["required_jobs"], ["process-checks"])
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
                         draft=False,
                         suites=["desktop"], required_jobs=sorted({"process-checks"} | planner.JOBS["desktop"]))
        self.needs = {name: {"result": "success"} for name in self.plan["required_jobs"] + ["plan"]}
        self.needs["cli-tests"] = {"result": "skipped"}

    def test_gate_accepts_only_explicit_nonapplicable_skips(self):
        result = planner.verify(self.plan, self.needs, self.head)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["source_sha"], self.head)

    def test_draft_or_missing_state_never_claims_passing_full_validation(self):
        for state in [True, None, "false", 0]:
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, "deferred"):
                planner.verify(dict(self.plan, draft=state), self.needs, self.head)
        plan = copy.deepcopy(self.plan)
        del plan["draft"]
        with self.assertRaises(ValueError):
            planner.verify(plan, self.needs, self.head)

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
