import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import zipfile

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

    def test_a_style_allowlist_selects_the_suite_whose_job_checks_it(self):
        # mobile-checks and desktop-tests run scripts/check-ui-style.py --only against their area's list.
        self.assertEqual(planner.select(["scripts/ui-style-allowlist/mobile.json"])[0], {"mobile"})
        self.assertEqual(planner.select(["scripts/ui-style-allowlist/desktop.json"])[0], {"desktop"})
        self.assertEqual(planner.select(["scripts/ui-style-allowlist/website.json"])[0], set())

    def test_the_style_allowlist_map_matches_the_style_check_and_the_workflow(self):
        scripts = Path(__file__).resolve().parents[1]
        style_spec = importlib.util.spec_from_file_location("check_ui_style", scripts / "check-ui-style.py")
        style = importlib.util.module_from_spec(style_spec)
        style_spec.loader.exec_module(style)
        expected = {f"{style.ALLOWLISTS}/{area}.json": planner.select([folder + "/x.dart"])[0]
                    for folder, area in style.ROOTS.items()}
        self.assertEqual({path: {suite} for path, suite in planner.STYLE_ALLOWLISTS.items()}, expected)
        # Each area's check runs inside a job of the suite the list selects.
        workflow = (scripts.parent / ".github/workflows/ci.yml").read_text()
        jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", workflow))
        for folder, area in style.ROOTS.items():
            with self.subTest(area=area):
                suite = planner.STYLE_ALLOWLISTS[f"{style.ALLOWLISTS}/{area}.json"]
                checking = {name for name, body in jobs.items() if f"check-ui-style.py --only {folder}" in body}
                self.assertTrue(checking)
                self.assertLessEqual(checking, planner.JOBS[suite])

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


class ReuseFixture(unittest.TestCase):
    """A repository where GitHub's Update branch merges main into a head whose ci/required passed."""

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



class ReuseTests(ReuseFixture):
    """Reuse what main's new commits left untouched; rerun everything on any doubt."""

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

    def test_tests_outside_the_pr_suite_do_not_rerun_it(self):
        # backend-desk runs src/**/*.test.ts only; cli-tests and cli-typecheck cover cli/src only.
        _, main, head = self.scenario(["backend/src/app.ts", "cli/src/a.ts"], ["backend/integration/teams.test.ts", "cli/e2e/run.e2e.ts"])
        plan = self.plan(head, main)
        self.assertEqual(list(plan["reused"]), ["backend", "cli"])
        self.assertEqual(planner.select(["backend/integration/teams.test.ts"])[0], {"backend"})

    def test_a_style_allowlist_main_changed_reruns_the_suite_that_checks_it(self):
        # mobile-checks runs the mobile style check: a list main shrank can fail with this PR's code.
        for area, suite, other in (("mobile", "mobile", "backend"), ("desktop", "desktop", "mobile")):
            with self.subTest(area=area):
                pr_paths = {"mobile": ["mobile/lib/app.dart", "backend/src/app.ts"],
                            "desktop": ["desktop/lib/a.dart", "mobile/lib/app.dart"]}[area]
                _, main, head = self.scenario(pr_paths, [f"scripts/ui-style-allowlist/{area}.json"])
                plan = self.plan(head, main)
                self.assertEqual(list(plan["reused"]), [other])
                self.assertIn(f"scripts/ui-style-allowlist/{area}.json", plan["reuse"]["rerun"][suite])
                self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS[suite]))

    def test_a_style_allowlist_the_pr_changes_is_its_components_input_not_a_shared_one(self):
        # The mobile batch that waited behind a backend batch also shrank its style allowlist (#2154).
        _, main, head = self.scenario(["mobile/lib/app.dart", "scripts/ui-style-allowlist/mobile.json"],
                                      ["backend/src/app.ts", "scripts/ui-style-allowlist/desktop.json"])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["mobile"])
        self.assertEqual(list(plan["reused"]), ["mobile"])

    def test_an_unknown_style_allowlist_on_main_reruns_every_component(self):
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["scripts/ui-style-allowlist/website.json"])
        self.assertRerunsAll(self.plan(head, main), "scripts/ui-style-allowlist/website.json")

    def test_a_file_another_component_reads_reruns_the_reader(self):
        # mobile's measurement tests read the backend's product usage types.
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/types/productUsage.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("backend/src/types/productUsage.ts", plan["reuse"]["rerun"]["mobile"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS["mobile"]))

    def test_shared_inputs_on_main_rerun_every_component(self):
        passed = self.branch(self.base, ["mobile/lib/app.dart", "desktop/lib/a.dart"], "pr")
        self.evidence.add(self.root, passed, {"desktop", "mobile"}, run_id=11)
        for index, path in enumerate([".github/workflows/ci.yml", "scripts/ci-plan.py", "Makefile", ".gitmodules",
                                      "cli/package-lock.json", "mobile/pubspec.lock", "tui/rust-toolchain.toml",
                                      "store/catalog.json", "docs/images/poster.png", "unknown-top-level.txt"]):
            with self.subTest(path=path):
                main = self.branch(self.base, [path], f"main-{index}")
                plan = self.plan(self.update(passed, main), main)
                self.assertRerunsAll(plan, path)
                self.assertEqual(plan["suites"], ["desktop", "mobile"])

    def test_a_pr_that_edits_the_planner_or_workflows_never_reuses(self):
        main = self.branch(self.base, ["backend/src/app.ts"], "main")
        for index, path in enumerate(["scripts/ci-plan.py", ".github/workflows/ci.yml", "scripts/merge-validated-pr.py", "Makefile"]):
            with self.subTest(path=path):
                passed = self.branch(self.base, ["mobile/lib/app.dart", path], f"pr-{index}")
                self.evidence.add(self.root, passed, {"mobile"}, run_id=11 + index)
                self.assertRerunsAll(self.plan(self.update(passed, main), main), path)

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


class VerifyReuseTests(ReuseFixture):
    """The merge helper re-derives a receipt's reuse from Git and the exact runs it names."""

    def receipt(self, plan):
        return dict(source_sha=plan["head"], suites=plan["suites"], reused=plan["reused"], reuse=plan["reuse"],
                    event="pull_request")

    def reusing(self, pr_paths=("mobile/lib/app.dart",), main_paths=("backend/src/app.ts",)):
        passed, main, head = self.scenario(list(pr_paths), list(main_paths))
        plan = self.plan(head, main)
        self.assertTrue(plan["reused"])
        return passed, main, head, self.receipt(plan)

    def test_a_planned_reuse_verifies(self):
        _, main, head, receipt = self.reusing()
        self.assertEqual(planner.verify_reuse(self.root, receipt, main, self.evidence), {"mobile": receipt["reused"]["mobile"]})
        later = self.branch(main, ["docs/guide.md"], "main")
        self.git("checkout", "-q", "--detach", head)
        planner.verify_reuse(self.root, receipt, later, self.evidence)

    def test_a_claimed_reuse_main_invalidated_is_refused(self):
        passed, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/types/productUsage.ts"])
        tree = self.git("rev-parse", f"{passed}^{{tree}}")
        forged = dict(source_sha=head, suites=["mobile"], event="pull_request",
                      reuse=dict(passed_head=passed, main_parent=main),
                      reused={"mobile": dict(origin_sha=passed, origin_tree=tree, run_id=11, run_attempt=1,
                                             run_url="https://github.com/o/r/actions/runs/11", reason="trust me")})
        with self.assertRaisesRegex(ValueError, "productUsage"):
            planner.verify_reuse(self.root, forged, main, self.evidence)

    def test_a_claimed_reuse_past_a_shrunk_style_allowlist_is_refused(self):
        passed, main, head = self.scenario(["mobile/lib/app.dart"], ["scripts/ui-style-allowlist/mobile.json"])
        tree = self.git("rev-parse", f"{passed}^{{tree}}")
        forged = dict(source_sha=head, suites=["mobile"], event="pull_request",
                      reuse=dict(passed_head=passed, main_parent=main),
                      reused={"mobile": dict(origin_sha=passed, origin_tree=tree, run_id=11, run_attempt=1,
                                             run_url="https://github.com/o/r/actions/runs/11", reason="trust me")})
        with self.assertRaisesRegex(ValueError, "ui-style-allowlist/mobile.json"):
            planner.verify_reuse(self.root, forged, main, self.evidence)

    def test_a_pr_that_edits_the_planner_cannot_have_reuse_accepted(self):
        _, main, head, receipt = self.reusing()
        self.git("checkout", "-q", "--detach", head)
        self.write("scripts/ci-plan.py", "def plan_reuse(*a): return everything")
        edited = self.commit("PR edits the planner")
        later = self.branch(main, ["backend/src/other.ts"], "main")
        merged = self.update(edited, later)
        self.evidence.add(self.root, edited, {"mobile"}, run_id=21)
        forged = dict(receipt, source_sha=merged, reuse=dict(receipt["reuse"], passed_head=edited))
        with self.assertRaisesRegex(ValueError, "scripts/ci-plan.py"):
            planner.verify_reuse(self.root, dict(forged, reuse=dict(forged["reuse"], main_parent=later)), later, self.evidence)

    def test_an_undeclared_read_of_a_file_main_changed_is_refused(self):
        # CI's sparse planner cannot see the new read; the helper's full checkout can.
        _, main, head, receipt = self.reusing(pr_paths=("mobile/lib/app.dart", "mobile/test/new_test.dart"))
        self.git("checkout", "-q", "--detach", head)
        (self.root / "mobile/test/new_test.dart").write_text("File('../backend/src/app.ts').readAsStringSync();")
        self.git("commit", "-qam", "reads the backend")
        reader = self.git("rev-parse", "HEAD")
        self.evidence.add(self.root, reader, {"mobile"}, run_id=31)
        for name, main_paths, refused in [("main-a", ["backend/src/other.ts"], False), ("main-b", ["backend/src/app.ts"], True)]:
            with self.subTest(main=main_paths):
                later = self.branch(main, main_paths, name)
                head = self.update(reader, later)
                plan = self.plan(head, later)
                self.assertEqual(list(plan["reused"]), ["mobile"])
                if refused:
                    with self.assertRaisesRegex(ValueError, "mobile/test/new_test.dart reads backend/src/app.ts"):
                        planner.verify_reuse(self.root, self.receipt(plan), later, self.evidence)
                else:
                    planner.verify_reuse(self.root, self.receipt(plan), later, self.evidence)

    def test_mismatched_parents_run_tree_or_link_are_refused(self):
        passed, main, head, receipt = self.reusing()
        record = receipt["reused"]["mobile"]
        for patch, reason in [(dict(reuse=dict(receipt["reuse"], passed_head=main)), "parents"),
                              (dict(reuse=dict(receipt["reuse"], main_parent=passed)), "parents"),
                              (dict(reused={"mobile": dict(record, origin_tree="f" * 40)}), "tree"),
                              (dict(reused={"mobile": dict(record, run_url="https://github.com/o/other/actions/runs/11")}), "link"),
                              (dict(reused={"mobile": dict(record, run_id=12, run_url="https://github.com/o/r/actions/runs/12")}),
                               "did not run")]:
            with self.subTest(reason=reason, patch=list(patch)), self.assertRaisesRegex(ValueError, reason):
                planner.verify_reuse(self.root, dict(receipt, **patch), main, self.evidence)
        self.git("checkout", "-q", "--detach", head)
        self.write("docs/guide.md", "a plain commit after the update")
        plain = self.commit()
        with self.assertRaisesRegex(ValueError, "not a merge"):
            planner.verify_reuse(self.root, dict(receipt, source_sha=plain), main, self.evidence)


class MainPlannerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def commit_scripts(self, planner_source):
        scripts = Path(__file__).resolve().parents[1]
        (self.root / "scripts").mkdir(exist_ok=True)
        (self.root / "scripts/ci-plan.py").write_text(planner_source)
        (self.root / "scripts/record-ci-validation.py").write_text((scripts / "record-ci-validation.py").read_text())
        self.git("add", "-A")
        self.git("commit", "-qm", "main")
        return self.git("rev-parse", "HEAD")

    def test_main_planner_is_read_from_the_base_commit_not_the_checkout(self):
        real = (Path(__file__).resolve().parents[1] / "ci-plan.py").read_text()
        base = self.commit_scripts(real)
        (self.root / "scripts/ci-plan.py").write_text(real.replace("def verify_reuse(", "def verify_reuse_disabled("))
        module = planner.main_planner(self.root, base)
        self.assertTrue(callable(module.verify_reuse))
        self.assertIsNot(module, planner)

    def test_a_base_without_a_reuse_verifier_or_a_broken_planner_refuses(self):
        for source in ["def make_plan(): pass\n", "this is not python", ""]:
            with self.subTest(source=source[:12]):
                base = self.commit_scripts(source) if source else self.git("rev-parse", "HEAD")
                with self.assertRaisesRegex(ValueError, "main's planner cannot verify reused results"):
                    planner.main_planner(self.root, base)
        with self.assertRaisesRegex(ValueError, "main's planner cannot verify reused results"):
            planner.main_planner(self.root, "f" * 40)


class CrossReadTests(unittest.TestCase):
    """A suite's reads outside its own directory must be declared before its results may be reused."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q")
        for path in ["backend/src/types/productUsage.ts", "backend/src/app.ts", "cli/src/lib/a.ts", "desktop/lib/devices/x.dart",
                     "docs/contracts/store/v1.json", "docs/guide.md", "store/catalog.json"]:
            self.write(path, "data")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def write(self, path, value):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(value)
        self.git("add", path)

    def test_an_undeclared_read_of_another_component_is_found(self):
        self.write("mobile/test/a_test.dart", "File('../backend/src/app.ts'); File('../backend/src/types/productUsage.ts');")
        self.write("mobile/test/b_test.dart", "final f = File('../cli/src/$path'); // declared: cli/src/")
        self.write("mobile/test/c_test.dart", "File('../docs/contracts/store/v1.json'); File('../docs/guide.md');")
        self.assertEqual(planner.undeclared_reads(self.root, "mobile"), [
            ("mobile/test/a_test.dart", "backend/src/app.ts"),
            ("mobile/test/c_test.dart", "docs/contracts/store/v1.json"), ("mobile/test/c_test.dart", "docs/guide.md")])

    def test_internal_paths_urls_shared_inputs_and_missing_targets_are_not_reads(self):
        self.write("desktop/lib/screens/s.dart", "import '../devices/x.dart';")
        self.write("cli/src/u.ts", "const a = 'https://cdn.example/harness/desktop/../backend/x.zip'")
        self.write("cli/src/v.ts", "readFileSync(new URL('../../store/catalog.json', import.meta.url)); '../../nothing/here.ts'")
        self.write("cli/src/w.ts", "import '../../mobile/missing.dart'")
        self.assertEqual(planner.undeclared_reads(self.root, "desktop"), [])
        self.assertEqual(planner.undeclared_reads(self.root, "cli"), [])

    def test_a_read_into_a_folder_the_suite_skips_is_found(self):
        self.write("backend/integration/helpers.ts", "export const x = 1")
        self.write("backend/src/a.test.ts", "import { x } from '../integration/helpers'")
        self.write("backend/integration/b.test.ts", "import { y } from './helpers'; import '../src/a'")
        self.assertEqual(planner.undeclared_reads(self.root, "backend"), [("backend/src/a.test.ts", "backend/integration/")])

    def test_a_read_built_at_run_time_needs_its_whole_folder_declared(self):
        self.write("tui/src/a.rs", 'include_str!("../../backend/src/types/productUsage.ts"); let p = "../../backend/src/";')
        self.assertEqual(planner.undeclared_reads(self.root, "tui"), [
            ("tui/src/a.rs", "backend/src/"), ("tui/src/a.rs", "backend/src/types/productUsage.ts")])
        self.write("mobile/test/a_test.dart", "File('../backend/src/$name');")
        self.assertEqual(planner.undeclared_reads(self.root, "mobile"), [("mobile/test/a_test.dart", "backend/src/")])

    def test_every_cross_read_in_this_repository_is_declared(self):
        repository = Path(__file__).resolve().parents[2]
        if not all((repository / top).is_dir() for top in ["cli/src", "desktop/lib", "mobile/lib", "backend/src"]):
            self.skipTest("needs a full checkout; the merge helper runs this scan before accepting reuse")
        for suite in sorted(planner.SUITES):
            with self.subTest(suite=suite):
                self.assertEqual(planner.undeclared_reads(repository, suite), [])


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
               dict(run_attempt=0), dict(run_url="http://evil.example/runs/11"), dict(run_url=None), dict(origin_sha=self.head),
               dict(origin_sha=5), dict(origin_tree=["f" * 40]), dict(reason=None)]
        for patch in bad:
            with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, "malformed reused result: mobile"):
                planner.verify(dict(self.plan, reused={"mobile": dict(self.record, **patch)}), self.needs, self.head)
        for plan in [dict(self.plan, reused={"cli": self.record}), dict(self.plan, reused=[]),
                     dict(self.plan, event="merge_group"), dict(self.plan, event="workflow_dispatch")]:
            with self.subTest(plan=plan["event"]), self.assertRaisesRegex(ValueError, "reuse"):
                planner.verify(plan, self.needs, self.head)


class FakeGitHub:
    """GitHub's check-run, job, run and artifact reads for passed ci/required runs."""
    repository = "o/r"

    def __init__(self):
        self.runs, self.checks, self.receipts, self.reads = {}, {}, {}, []

    def add_run(self, run_id, head, tree, suites, attempt=1, reused=None, event="pull_request", conclusion="success"):
        required = sorted({"process-checks"} | set().union(*(planner.JOBS[s] for s in set(suites) - set(reused or {}))))
        self.runs[run_id] = dict(id=run_id, repository=dict(full_name=self.repository), path=".github/workflows/ci.yml",
                                 event=event, head_sha=head, run_attempt=attempt, status="completed",
                                 conclusion=conclusion, html_url=f"https://github.com/o/r/actions/runs/{run_id}",
                                 updated_at="2026-10-29T00:00:00Z")
        self.receipts[run_id] = dict(schema=1, kind="ci-required", status="passed", source_sha=head, source_tree=tree,
                                     event=event, suites=sorted(suites), required_jobs=required, reused=reused or {},
                                     results={job: "success" for job in required + ["plan"]},
                                     run_id=run_id, run_attempt=attempt)
        self.checks.setdefault(head, []).append(dict(id=run_id * 10, name="ci/required", head_sha=head, status="completed",
                                                     conclusion=conclusion, app=dict(slug="github-actions")))

    def archive(self, run_id):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as bundle:
            bundle.writestr(zipfile.ZipInfo("ci-required.json", (2026, 10, 29, 0, 0, 0)), json.dumps(self.receipts[run_id]))
        return buf.getvalue()

    def api(self, path):
        self.reads.append(path)
        if path.startswith("actions/jobs/"):
            job_id = int(path.split("/")[2])
            run = self.runs[job_id // 10]
            return dict(id=job_id, name="ci/required", run_id=run["id"], run_attempt=run["run_attempt"],
                        head_sha=run["head_sha"], status="completed", conclusion=run["conclusion"])
        if path.startswith("actions/runs/"):
            return copy.deepcopy(self.runs[int(path.split("/")[2])])
        if path.startswith("git/commits/"):
            head = path.split("/")[2]
            return dict(sha=head, tree=dict(sha=next(r["source_tree"] for r in self.receipts.values() if r["source_sha"] == head)))
        raise AssertionError(path)

    def pages(self, path, key):
        self.reads.append(path)
        if key == "check_runs":
            head = path.split("/")[1]
            return copy.deepcopy(self.checks.get(head, []))
        run_id = int(path.split("/")[2])
        run = self.runs[run_id]
        if key == "jobs":
            return [dict(name="ci/required", status="completed", conclusion=run["conclusion"], head_sha=run["head_sha"],
                         run_attempt=run["run_attempt"])]
        if key == "artifacts":
            archive = self.archive(run_id)
            return [dict(id=run_id, name="ci-required", expired=False, size_in_bytes=len(archive),
                         digest="sha256:" + hashlib.sha256(archive).hexdigest(),
                         workflow_run=dict(id=run_id, head_sha=run["head_sha"]))]
        raise AssertionError(path)

    def command(self, *args, binary=False):
        assert binary and args[1].endswith("/zip"), args
        return self.archive(int(args[1].split("/")[-2]))


class GitHubEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()
        self.head, self.tree = "a" * 40, "b" * 40
        self.github.add_run(11, self.head, self.tree, ["mobile"])
        self.evidence = planner.GitHubEvidence(self.github)

    def test_the_passed_gate_is_the_run_behind_the_latest_ci_required_check(self):
        self.github.add_run(12, self.head, self.tree, ["mobile", "backend"])
        gate = self.evidence.passed_gate(self.head)
        self.assertEqual((gate["run_id"], gate["run_attempt"]), (12, 1))
        self.assertEqual(gate["url"], "https://github.com/o/r/actions/runs/12")
        self.assertEqual(gate["receipt"]["suites"], ["backend", "mobile"])
        self.assertIn("actions/jobs/120", self.github.reads)

    def test_a_failed_latest_check_is_not_rescued_by_an_older_pass(self):
        self.github.add_run(12, self.head, self.tree, ["mobile"], conclusion="failure")
        with self.assertRaisesRegex(ValueError, "not a pass"):
            self.evidence.passed_gate(self.head)

    def test_no_check_a_rerun_attempt_another_event_workflow_or_repository_fails(self):
        with self.assertRaisesRegex(ValueError, "no ci/required"):
            self.evidence.passed_gate("c" * 40)
        for patch in [dict(run_attempt=2), dict(event="workflow_dispatch"), dict(path=".github/workflows/other.yml"),
                      dict(repository=dict(full_name="someone/else")), dict(head_sha="d" * 40), dict(status="in_progress")]:
            with self.subTest(patch=patch):
                github = FakeGitHub()
                github.add_run(11, self.head, self.tree, ["mobile"])
                original = github.api

                def api(path, original=original, patch=patch):
                    value = original(path)
                    return dict(value, **patch) if path == "actions/runs/11" else value
                github.api = api
                with self.assertRaises(ValueError):
                    planner.GitHubEvidence(github).passed_gate(self.head)

    def test_a_check_from_another_app_or_commit_is_ignored(self):
        self.github.checks[self.head] = [dict(c, app=dict(slug="someone-else")) for c in self.github.checks[self.head]]
        with self.assertRaisesRegex(ValueError, "no ci/required"):
            self.evidence.passed_gate(self.head)

    def test_a_tampered_receipt_archive_fails(self):
        self.github.archive = lambda run_id: b"not the archive GitHub hashed"
        with self.assertRaises((ValueError, zipfile.BadZipFile)):
            self.evidence.passed_gate(self.head)

    def test_ran_requires_that_exact_run_to_have_run_the_suite(self):
        self.assertEqual(self.evidence.ran(self.head, 11, 1, "mobile"),
                         dict(tree=self.tree, url="https://github.com/o/r/actions/runs/11"))
        for args, reason in [((self.head, 11, 2, "mobile"), "attempt"), (("c" * 40, 11, 1, "mobile"), "another source"),
                             ((self.head, 11, 1, "backend"), "did not run")]:
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, reason):
                self.evidence.ran(*args)
        record = dict(origin_sha="e" * 40, origin_tree="f" * 40, run_id=9, run_attempt=1,
                      run_url="https://github.com/o/r/actions/runs/9", reason="x")
        self.github.add_run(13, "c" * 40, self.tree, ["mobile"], reused={"mobile": record})
        with self.assertRaisesRegex(ValueError, "did not run"):
            self.evidence.ran("c" * 40, 13, 1, "mobile")


if __name__ == "__main__":
    unittest.main()
