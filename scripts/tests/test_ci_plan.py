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
            "devices/harness-pro/firmware/main/app/pro_app.c": {"firmware", "pro"},
            "devices/harness-pro/README.md": {"firmware", "pro"}, "devices/harness-pro-other/x.c": {"firmware"},
            "mobile/pubspec.lock": {"mobile"}, "daemons/tools/card.mjs": {"daemons"},
            "pty/src/stream.rs": {"pty"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)

    def test_the_cli_ptyhost_backend_and_the_vendored_terminal_also_select_the_pty_suite(self):
        for path, expected in {
            "cli/src/lib/ptyHost/stream.ts": {"cli", "pty"}, "cli/src/lib/ptyHostBackend.ts": {"cli", "pty"},
            "cli/src/lib/ptyHostBackend.contract.spec.ts": {"cli", "pty"},
            "cli/src/lib/terminalBackend.contract.ts": {"cli", "pty"},
            "tui/vendor/alacritty_terminal/src/term/mod.rs": {"tui", "pty"},
            "cli/src/lib/ptyHostile.ts": {"cli"}, "cli/src/lib/tmuxBackend.ts": {"cli"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)

    def test_the_windows_installer_selects_the_pty_suite(self):
        # installer/'s model and steps are plain Rust that tests on Linux; pty-checks runs them (installer spec §4.1).
        for path in ("installer/src/model.rs", "installer/tests/entry-vectors.json", "installer/Cargo.lock"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"pty"})

    def test_the_pipe_auth_vectors_also_select_the_desktop_suite(self):
        # desktop/test/windows_pipe_auth_test.dart reads them from cli/: a new vector runs both halves.
        self.assertEqual(planner.select(["cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json"])[0], {"cli", "desktop"})
        self.assertEqual(planner.select(["cli/src/lib/windows/pipeAuth.ts"])[0], {"cli"})

    def test_the_shared_terminal_crate_selects_both_the_pty_host_and_the_tui(self):
        # term/ is a dependency of the PTY host and of the shipped TUI (`hn`): both suites run.
        for path in ("term/src/capture.rs", "term/Cargo.toml"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"pty", "tui"})

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


class FakeEvidence:
    """Passed ci/required gates by commit, as the GitHub reader returns them after its own checks."""

    def __init__(self):
        self.gates, self.failure, self.lookups = {}, None, []

    def add(self, root, sha, suites, run_id, reused=None):
        tree = subprocess.check_output(["git", "rev-parse", f"{sha}^{{tree}}"], cwd=root, text=True).strip()
        receipt = dict(schema=1, kind="ci-required", status="passed", source_sha=sha, source_tree=tree,
                       event="pull_request", suites=sorted(suites), reused=reused or {}, run_id=run_id, run_attempt=1)
        self.gates[sha] = dict(run_id=run_id, run_attempt=1, url=f"https://github.com/o/r/actions/runs/{run_id}",
                               receipt=receipt)

    def passed_gate(self, sha):
        self.lookups.append(("gate", sha))
        if self.failure:
            raise self.failure
        if sha not in self.gates:
            raise ValueError("the passed head's latest ci/required is not a pass")
        return copy.deepcopy(self.gates[sha])

    def ran(self, sha, run_id, run_attempt, suite):
        self.lookups.append(("ran", sha, run_id, suite))
        gate = self.gates.get(sha)
        if (not gate or gate["run_id"] != run_id or gate["run_attempt"] != run_attempt
                or suite not in gate["receipt"]["suites"] or suite in gate["receipt"]["reused"]):
            raise ValueError("the recorded run did not run this suite")
        return dict(tree=gate["receipt"]["source_tree"], url=gate["url"])


class ReuseTests(unittest.TestCase):
    """After GitHub merges main into a head whose ci/required passed, reuse what main's commits left untouched."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")
        for path in ["README.md", "docs/guide.md", "docs/images/poster.png", "mobile/lib/app.dart", "backend/src/app.ts",
                     "backend/src/types/productUsage.ts", "cli/src/a.ts", "desktop/lib/a.dart", "scripts/ci-plan.py",
                     ".github/workflows/ci.yml", "Makefile", "store/catalog.json", "cli/package-lock.json",
                     "mobile/pubspec.lock", "tui/rust-toolchain.toml", ".gitmodules"]:
            self.write(path, "base " + path)
        self.base = self.commit()
        self.evidence = FakeEvidence()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def write(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def commit(self, message="fixture"):
        self.git("add", "-A")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def branch(self, start, paths, name):
        self.git("checkout", "-q", "-B", name, start)
        for path in paths:
            self.write(path, f"{name} {path}")
        return self.commit(name)

    def update(self, passed, main):
        """GitHub's Update branch: merge main into the passed head, first parent the head."""
        self.git("checkout", "-q", "--detach", passed)
        self.git("merge", "-q", "--no-ff", "--no-edit", main)
        return self.git("rev-parse", "HEAD")

    def plan(self, head, base, evidence=True, draft=False):
        self.git("checkout", "-q", "--detach", head)
        payload = {"pull_request": {"head": {"sha": head}, "base": {"sha": base}, "draft": draft}}
        return planner.make_plan(self.root, "pull_request", payload, source=head,
                                 evidence=self.evidence if evidence else None)

    def scenario(self, pr_paths, main_paths, passed_suites=None):
        passed = self.branch(self.base, pr_paths, "pr")
        suites = passed_suites if passed_suites is not None else planner.select(pr_paths)[0]
        self.evidence.add(self.root, passed, suites, run_id=11)
        main = self.branch(self.base, main_paths, "main")
        return passed, main, self.update(passed, main)

    def assertRerunsAll(self, plan, reason):
        self.assertEqual(plan["reused"], {})
        self.assertEqual(plan["reuse"]["status"], "none")
        self.assertIn(reason, plan["reuse"]["reason"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | set().union(*(planner.JOBS[s] for s in plan["suites"]))))

    def test_an_unrelated_main_change_reuses_the_passed_heads_result(self):
        passed, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["mobile"])
        self.assertEqual(plan["required_jobs"], ["process-checks"])
        reused = plan["reused"]["mobile"]
        self.assertEqual(reused["origin_sha"], passed)
        self.assertEqual(reused["origin_tree"], self.git("rev-parse", f"{passed}^{{tree}}"))
        self.assertEqual((reused["run_id"], reused["run_attempt"]), (11, 1))
        self.assertEqual(reused["run_url"], "https://github.com/o/r/actions/runs/11")
        self.assertIn("backend/src/app.ts", reused["reason"])
        self.assertEqual(plan["reuse"]["status"], "applied")
        self.assertEqual((plan["reuse"]["passed_head"], plan["reuse"]["main_parent"]), (passed, main))

    def test_docs_and_top_level_notes_on_main_do_not_force_a_rerun(self):
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["docs/guide.md", "README.md"])
        self.assertEqual(list(self.plan(head, main)["reused"]), ["mobile"])

    def test_a_related_main_change_reruns_only_that_component(self):
        _, main, head = self.scenario(["mobile/lib/app.dart", "backend/src/app.ts"], ["backend/src/other.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["backend", "mobile"])
        self.assertEqual(list(plan["reused"]), ["mobile"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS["backend"]))
        self.assertIn("backend/src/other.ts", plan["reuse"]["rerun"]["backend"])

    def test_a_file_another_component_reads_reruns_the_reader(self):
        # mobile's measurement tests read the backend's product usage types.
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/types/productUsage.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("backend/src/types/productUsage.ts", plan["reuse"]["rerun"]["mobile"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS["mobile"]))

    def test_shared_inputs_on_main_rerun_every_component(self):
        for path in [".github/workflows/ci.yml", "scripts/ci-plan.py", "Makefile", ".gitmodules", "cli/package-lock.json",
                     "mobile/pubspec.lock", "tui/rust-toolchain.toml", "store/catalog.json", "docs/images/poster.png",
                     "unknown-top-level.txt"]:
            with self.subTest(path=path):
                self.setUp()
                _, main, head = self.scenario(["mobile/lib/app.dart", "desktop/lib/a.dart"], [path])
                plan = self.plan(head, main)
                self.assertRerunsAll(plan, path)
                self.assertEqual(plan["suites"], ["desktop", "mobile"])

    def test_a_pr_that_edits_the_planner_or_workflows_never_reuses(self):
        for path in ["scripts/ci-plan.py", ".github/workflows/ci.yml", "scripts/merge-validated-pr.py", "Makefile"]:
            with self.subTest(path=path):
                self.setUp()
                _, main, head = self.scenario(["mobile/lib/app.dart", path], ["backend/src/app.ts"], passed_suites={"mobile"})
                self.assertRerunsAll(self.plan(head, main), path)

    def test_a_head_that_is_not_exactly_main_merged_into_the_passed_head_reruns(self):
        passed, main, merged = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        # A plain commit on top of the passed head.
        self.git("checkout", "-q", "--detach", passed)
        self.write("mobile/lib/app.dart", "edited")
        plain = self.commit()
        self.assertRerunsAll(self.plan(plain, main), "not a merge")
        # An octopus merge.
        other = self.branch(self.base, ["backend/src/other.ts"], "other")
        self.git("checkout", "-q", "--detach", passed)
        self.git("merge", "-q", "--no-ff", "--no-edit", main, other)
        self.assertRerunsAll(self.plan(self.git("rev-parse", "HEAD"), main), "not a merge")
        # A second parent that is not on the PR's base branch.
        side = self.branch(self.base, ["backend/src/side.ts"], "side")
        self.assertRerunsAll(self.plan(self.update(passed, side), main), "not on the base branch")
        # Main merged into a commit with no passed gate.
        unpassed = self.branch(passed, ["mobile/lib/app.dart"], "later")
        self.assertRerunsAll(self.plan(self.update(unpassed, main), main), "not a pass")
        # Parents reversed: main first.
        self.git("checkout", "-q", "--detach", main)
        self.git("merge", "-q", "--no-ff", "--no-edit", passed)
        self.assertRerunsAll(self.plan(self.git("rev-parse", "HEAD"), main), "not on the base branch")

    def test_unreadable_evidence_or_no_reader_reruns(self):
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        self.assertRerunsAll(self.plan(head, main, evidence=False), "no CI evidence reader")
        for error in [RuntimeError("GitHub lookup failed (1): api"), TimeoutError("deadline"), KeyError("jobs"),
                      ValueError("summary archive digest mismatch"), OSError("gh missing")]:
            with self.subTest(error=error):
                self.evidence.failure = error
                self.assertRerunsAll(self.plan(head, main), "could not be verified")

    def test_a_component_the_passed_run_did_not_cover_reruns(self):
        _, main, head = self.scenario(["mobile/lib/app.dart", "cli/src/a.ts"], ["backend/src/app.ts"], passed_suites={"mobile"})
        plan = self.plan(head, main)
        self.assertEqual(list(plan["reused"]), ["mobile"])
        self.assertIn("did not run", plan["reuse"]["rerun"]["cli"])

    def test_a_merge_resolution_inside_a_component_reruns_it(self):
        passed, main, _ = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        self.git("checkout", "-q", "--detach", passed)
        self.git("merge", "-q", "--no-ff", "--no-commit", main)
        self.write("mobile/lib/app.dart", "resolved by hand")
        self.git("add", "-A")
        self.git("commit", "-qm", "merge main")
        plan = self.plan(self.git("rev-parse", "HEAD"), main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("mobile/lib/app.dart", plan["reuse"]["rerun"]["mobile"])

    def test_a_second_update_reuses_the_run_where_the_component_ran(self):
        passed, main, first = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        reused = self.plan(first, main)["reused"]
        self.evidence.add(self.root, first, {"mobile"}, run_id=12, reused=reused)
        later_main = self.branch(main, ["backend/src/other.ts"], "main")
        second = self.update(first, later_main)
        plan = self.plan(second, later_main)
        self.assertEqual(plan["reused"]["mobile"]["origin_sha"], passed)
        self.assertEqual(plan["reused"]["mobile"]["run_id"], 11)
        self.assertIn(("ran", passed, 11, "mobile"), self.evidence.lookups)
        # The origin run can no longer be verified: rerun.
        del self.evidence.gates[passed]
        self.assertRerunsAll(self.plan(second, later_main), "could not be verified")

    def test_a_recorded_origin_that_is_not_an_ancestor_reruns(self):
        passed, main, first = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        stranger = self.branch(self.base, ["mobile/lib/app.dart"], "stranger")
        self.evidence.add(self.root, stranger, {"mobile"}, run_id=99)
        forged = {"mobile": dict(origin_sha=stranger, origin_tree=self.git("rev-parse", f"{stranger}^{{tree}}"),
                                 run_id=99, run_attempt=1, run_url="https://github.com/o/r/actions/runs/99", reason="x")}
        self.evidence.add(self.root, first, {"mobile"}, run_id=12, reused=forged)
        later_main = self.branch(main, ["backend/src/other.ts"], "main")
        plan = self.plan(self.update(first, later_main), later_main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("not an ancestor", plan["reuse"]["rerun"]["mobile"])

    def test_draft_and_merge_group_plans_never_reuse(self):
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        self.assertEqual(self.plan(head, main, draft=True)["reused"], {})
        self.assertEqual(self.evidence.lookups, [])
        payload = {"action": "checks_requested", "merge_group": {"head_sha": head, "base_sha": main}}
        self.assertEqual(planner.make_plan(self.root, "merge_group", payload, source=head, evidence=self.evidence)["reused"], {})
        self.assertEqual(self.evidence.lookups, [])


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


class ReusedGateTests(unittest.TestCase):
    def setUp(self):
        self.head = "a" * 40
        self.record = dict(origin_sha="e" * 40, origin_tree="f" * 40, run_id=11, run_attempt=1,
                           run_url="https://github.com/o/r/actions/runs/11", reason="passed in run 11")
        self.plan = dict(schema=1, kind="ci-plan", head=self.head, tree="b" * 40, event="pull_request", base="c" * 40,
                         draft=False, suites=["backend", "mobile"], reused={"mobile": self.record},
                         reuse=dict(status="applied", passed_head="e" * 40, main_parent="c" * 40, rerun={}, reason="x"),
                         required_jobs=sorted({"process-checks"} | planner.JOBS["backend"]))
        self.needs = {name: {"result": "success"} for name in self.plan["required_jobs"] + ["plan"]}
        self.needs["mobile-checks"] = {"result": "skipped"}

    def test_a_reused_suite_may_skip_and_the_receipt_names_its_run(self):
        result = planner.verify(self.plan, self.needs, self.head)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["suites"], ["backend", "mobile"])
        self.assertEqual(result["required_jobs"], sorted({"process-checks"} | planner.JOBS["backend"]))
        self.assertEqual(result["reused"], {"mobile": self.record})
        self.assertEqual(result["reuse"]["passed_head"], "e" * 40)

    def test_a_suite_that_was_not_reused_must_still_pass(self):
        needs = copy.deepcopy(self.needs)
        needs["backend-desk"]["result"] = "skipped"
        with self.assertRaisesRegex(ValueError, "backend-desk"):
            planner.verify(self.plan, needs, self.head)
        with self.assertRaisesRegex(ValueError, "incomplete job coverage"):
            planner.verify(dict(self.plan, required_jobs=["process-checks"]), self.needs, self.head)

    def test_a_reused_suite_whose_job_ran_or_failed_is_rejected(self):
        for result in ["success", "failure", "cancelled"]:
            needs = copy.deepcopy(self.needs)
            needs["mobile-checks"]["result"] = result
            with self.subTest(result=result), self.assertRaises(ValueError):
                planner.verify(self.plan, needs, self.head)

    def test_malformed_or_unplanned_reuse_is_rejected(self):
        bad = [dict(origin_sha="short"), dict(origin_tree=None), dict(run_id=0), dict(run_id="11"), dict(run_id=True),
               dict(run_attempt=0), dict(run_url="http://evil.example/runs/11"), dict(run_url=None), dict(origin_sha=self.head)]
        for patch in bad:
            with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, "malformed reused result: mobile"):
                planner.verify(dict(self.plan, reused={"mobile": dict(self.record, **patch)}), self.needs, self.head)
        for plan in [dict(self.plan, reused={"cli": self.record}), dict(self.plan, reused=[]),
                     dict(self.plan, event="merge_group"), dict(self.plan, event="workflow_dispatch")]:
            with self.subTest(plan=plan["event"]), self.assertRaisesRegex(ValueError, "reuse"):
                planner.verify(plan, self.needs, self.head)


if __name__ == "__main__":
    unittest.main()
