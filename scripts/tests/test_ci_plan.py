import copy
import hashlib
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

spec = importlib.util.spec_from_file_location("ci_plan", Path(__file__).resolve().parents[1] / "ci-plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)

# Harness Device's four debug packages, in device-app-build's order.
FOUR_BUILDS = [{"bundle": "appimage", "arch": "x64"}, {"bundle": "appimage", "arch": "arm64"},
               {"bundle": "nsis", "arch": "x64"}, {"bundle": "nsis", "arch": "arm64"}]
# A plan whose linux-e2e does not run.
NO_LINUX_E2E = {"linux_files": [], "linux_shards": 0, "linux_full": False}
# The checkout the full-checkout tests read.
REPOSITORY = Path(__file__).resolve().parents[2]


def full_checkout(test, *paths):
    """Skip a test whose files are not in this checkout (process-checks' is sparse); in ci.yml's cross-read-scan job
    (CROSS_READ_SCAN_REQUIRED=1), which exists to run it on a full one, fail naming them: a skip there reads as a pass."""
    missing = [path for path in paths if not (REPOSITORY / path).exists()]
    if not missing:
        return
    message = f"needs a full checkout: {', '.join(missing)} not in {REPOSITORY}"
    if os.environ.get("CROSS_READ_SCAN_REQUIRED") == "1":
        test.fail(message)
    test.skipTest(message)


# A TypeScript import by a relative path: `from './x.js'`, `import './x.js'`, `import('./x.js')`.
RELATIVE_IMPORT = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}/[^'"]+)['"]""")


def imports_from(root, sources, within):
    """The sources and every file under the `within` folders they import, through files under those folders alone."""
    seen, todo = set(), list(sources)
    while todo:
        source = todo.pop()
        if source in seen:
            continue
        seen.add(source)
        for spec in RELATIVE_IMPORT.findall((root / source).read_text()):
            path = posixpath.normpath(posixpath.join(posixpath.dirname(source), spec))
            stem = re.sub(r"\.[mc]?js$", "", path)
            found = next((name for name in (stem + ".ts", stem + ".tsx", stem + ".mts", path, stem + "/index.ts")
                          if (root / name).is_file()), None)
            if found and found.startswith(within):
                todo.append(found)
    return seen


class SelectionTests(unittest.TestCase):
    def test_backend_changes_run_the_integration_shards_and_nothing_else_does(self):
        # Task #2459: the Super Tab integration suite runs in PR CI for backend changes only.
        self.assertEqual(planner.JOBS["backend"], {"backend-desk", "backend-integration"})
        self.assertEqual(planner.select(["backend/integration/superTabs.test.ts"])[0], {"backend"})
        others = set().union(*(jobs for suite, jobs in planner.JOBS.items() if suite != "backend"))
        self.assertNotIn("backend-integration", others)
        self.assertNotIn("backend", planner.NOT_READ)

    def test_a_desktop_file_the_phone_tests_read_runs_mobile_checks(self):
        # The phone's tests compare these; a desktop-only PR that changed one such file passed its own CI and failed two
        # batches later (River, 2026-11-03).
        for path in ["desktop/lib/widgets/engine_identity.dart", "desktop/test/support/real_fonts.dart"]:
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"desktop", "mobile"})
        self.assertEqual(planner.select(["desktop/lib/main.dart"])[0], {"desktop"})

    def test_a_desktop_change_on_main_keeps_backends_result_only_when_backend_reads_none_of_it(self):
        # Task #4511: a backend test reads only the desktop files it declares; declaring more reran backend after every
        # Update branch that brought a desktop change.
        for path in ["desktop/lib/widgets/pane_grid.dart", "desktop/lib/screens/swarm_screen.dart"]:
            with self.subTest(path=path):
                self.assertFalse(planner.reads("backend", path))
        for path in ["desktop/lib/measurement/setup_transport.dart"]:
            with self.subTest(path=path):
                self.assertTrue(planner.reads("backend", path))
        for path in ["backend/src/lib/deviceAckCore.ts"]:
            with self.subTest(path=path):
                self.assertTrue(planner.reads("cli", path))

    def test_every_desktop_file_the_phone_tests_read_selects_mobile(self):
        # The phone's tests name what they read as '../desktop/<path>', or an import of '../../desktop/<path>'.
        root = REPOSITORY
        full_checkout(self, "mobile/test")
        tests = sorted((root / "mobile/test").rglob("*.dart"))
        named = set()
        for test in tests:
            text = test.read_text()
            named |= {"desktop/" + m for m in re.findall(r"'(?:\.\./)+desktop/([\w/.-]+\.dart)'", text)}
        self.assertIn("desktop/lib/widgets/engine_identity.dart", named)
        for path in sorted(named):
            with self.subTest(path=path):
                self.assertTrue((root / path).exists(), path)
                self.assertIn("mobile", planner.select([path])[0])

    def test_pr_integration_shards_restore_a_mongod_cache_that_main_saves(self):
        # A cache a PR saves is visible to that PR only; one saved on main is visible to every PR (review of #2804).
        workflows = Path(__file__).resolve().parents[2] / ".github/workflows"
        ci = (workflows / "ci.yml").read_text()
        job = re.search(r"(?m)^  backend-integration:\n((?:(?:    .*)?\n)+)", ci).group(1)
        self.assertIn("actions/cache/restore@", job)
        self.assertNotRegex(job, r"actions/cache(/save)?@")
        key = re.search(r"(?m)^\s+key: (super-tab-mongod-.+)$", job).group(1)
        saver = (workflows / "backend-cache.yml").read_text()
        self.assertRegex(saver, r"(?ms)^on:.*^  push:\n    branches: \[main\]")
        self.assertIn("actions/cache/save@", saver)
        # A manual run from another branch would save a cache only that branch reads (review of #2822).
        self.assertRegex(saver, r"(?m)^  mongod:\n    if: github\.ref == 'refs/heads/main'$")
        self.assertIn(f"key: {key}", saver)
        self.assertIn("path: /tmp/harness-super-tab-mongodb-binaries", job)
        self.assertIn("path: /tmp/harness-super-tab-mongodb-binaries", saver)

    def test_docs_workflows_scripts_and_unknown_paths_need_only_process_checks(self):
        for path in ["docs/guide.md", "README.md", "scripts/local-checks.py", ".github/workflows/ci.yml", "Makefile",
                     "surprise.py"]:
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], set())

    def test_each_component_owns_only_its_own_suite(self):
        # What else a path selects is what other suites declare reading (DEPENDS), tested below.
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
            "device-app/src-tauri/src/lib.rs": {"device-app"}, "device-app/ui/src/main.ts": {"device-app"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.owners(path), expected)

    def test_the_device_app_runs_its_own_suite_and_its_end_to_end_suites(self):
        for path, expected in {
            "device-app/src-tauri/src/keepalive.rs": {"device-app", "device-app-e2e"},
            "device-app/src-tauri/Cargo.lock": {"device-app", "device-app-e2e", "device-app-update"},
            "device-app/ui/package-lock.json": {"device-app", "device-app-e2e"},
            "device-app/AGENTS.md": {"device-app"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)
        self.assertEqual(planner.JOBS["device-app"], {"device-app-checks"})
        self.assertEqual(planner.MANUAL["device-app"], {"device-app"})
        # The app on Linux and on Windows; one job for each other Device suite.
        self.assertEqual(planner.JOBS["device-app-e2e"], {"device-app-linux", "device-app-windows"})
        for suite in ("device-app-update", "device-app-desktop", "device-app-install"):
            with self.subTest(suite=suite):
                self.assertEqual(planner.JOBS[suite], {suite})
        self.assertEqual(planner.JOBS["windows-e2e"], {"windows-e2e"})

    def test_each_device_app_job_runs_on_its_own_paths(self):
        app = {"device-app", "device-app-e2e"}
        cases = {"device-app/src-tauri/src/keepalive.rs": app, "device-app/scripts/e2e/macos.sh": app}
        # The updater, the pair of builds, each driver's update path, how a release builds, and the app's dependencies.
        for path in ("src-tauri/src/update.rs", "scripts/e2e/update-pair.sh", "scripts/e2e/linux.sh",
                     "scripts/e2e/windows.ps1", "scripts/release-build.sh", "scripts/release-check.sh",
                     "scripts/release-setup.sh", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
            cases["device-app/" + path] = app | {"device-app-update"}
        for name in ("tauri.conf.json", "tauri.linux.conf.json", "tauri.windows.conf.json"):
            cases["device-app/src-tauri/" + name] = app | {"device-app-update", "device-app-desktop", "device-app-install"}
        for name in ("install.rs", "instance.rs"):
            cases["device-app/src-tauri/src/" + name] = app | {"device-app-desktop"}
        cases["device-app/src-tauri/src/packaging.rs"] = app | {"device-app-desktop", "device-app-install"}
        for path in ("src-tauri/src/appimage_env.rs", "scripts/e2e/linux-install.sh", "scripts/e2e/https-fake-cdn.py"):
            cases["device-app/" + path] = app | {"device-app-install"}
        for path in ("desktop/lib/devices/device_app_installer.dart",
                     "desktop/integration_test/device_app_install_windows_linux_native_test.dart"):
            cases[path] = {"desktop", "device-app-desktop"}
        cases["website/scripts/device-install.sh"] = {"website", "device-app-install"}
        # The docs and the release scripts' Python tests run no Device job: device-app-checks runs those tests.
        for path in ("device-app/AGENTS.md", "device-app/RELEASE.md", "device-app/scripts/test_release_build.py"):
            cases[path] = {"device-app"}
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], expected)

    def test_a_change_to_the_device_jobs_setup_action_runs_the_suites_that_use_it(self):
        # As dial-hosts selects on its own setup action: a Device suite uses it through its own jobs, or through the
        # device-app-build packages its jobs install.
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
        jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", workflow))
        def users(action):
            uses = {name for name, job in jobs.items() if f"uses: ./.github/actions/{action}\n" in job}
            suites = {suite for suite, names in planner.JOBS.items() if names & uses}
            return suites | (set(planner.DEVICE_APP_BUILDS) if "device-app-build" in uses else set())

        self.assertEqual(users("device-app-setup"), {"device-app-e2e", "device-app-update", "device-app-desktop",
                                                     "device-app-install"})
        self.assertEqual(planner.select([".github/actions/device-app-setup/action.yml"])[0], users("device-app-setup"))
        # Every end-to-end suite runs on a change to an action its jobs use (desktop-tests' Flutter action is shared).
        actions = sorted(set(re.findall(r"uses: \./\.github/actions/([\w-]+)\n", workflow)))
        self.assertLessEqual({"desktop-flutter", "desktop-flutter-arm64", "cli-e2e-setup"}, set(actions))
        for action in actions:
            with self.subTest(action=action):
                self.assertLessEqual(users(action) & planner.E2E,
                                     planner.select([f".github/actions/{action}/action.yml"])[0])

    def test_builds_follow_only_the_suites_that_run(self):
        # Review Focus 4: a reused Device suite must not make device-app-build build its packages.
        for running, builds in (({"device-app-install"}, [{"bundle": "appimage", "arch": "x64"}]),
                                ({"device-app-e2e"}, FOUR_BUILDS), ({"device-app-desktop"}, FOUR_BUILDS),
                                ({"device-app-install", "device-app-desktop"}, FOUR_BUILDS),
                                ({"device-app-update"}, []), ({"windows-e2e", "cli"}, []), (set(), [])):
            with self.subTest(running=sorted(running)):
                self.assertEqual(planner.e2e_plan([], running)["device_app_builds"], builds)

    def test_the_plan_job_outputs_carry_what_the_jobs_read(self):
        running = {"windows-e2e", "device-app-install"}
        record = dict(schema=1, kind="ci-plan", draft=False, suites=["cli", "device-app-install", "windows-e2e"],
                      reused={"cli": {}}, e2e=planner.e2e_plan(["cli/src/devices/listenerPipe.ts"], running))
        values = planner.outputs(record)
        self.assertEqual(set(values), {"plan", "ready", "windows-e2e-arm64", "device-app-builds", "linux-e2e-files",
                                       "linux-e2e-shards", "linux-e2e-full"} | planner.SUITES)
        self.assertEqual(json.loads(values["plan"]), record)
        self.assertEqual(values["ready"], "true")
        self.assertEqual((values["windows-e2e"], values["windows-e2e-arm64"]), ("true", "false"))
        self.assertEqual(values["device-app-builds"], '[{"bundle":"appimage","arch":"x64"}]')
        self.assertEqual((values["device-app-install"], values["device-app-e2e"]), ("true", "false"))
        # linux-e2e does not run: no file and no row.
        self.assertEqual((values["linux-e2e"], values["linux-e2e-files"], values["linux-e2e-shards"],
                          values["linux-e2e-full"]), ("false", "", "[]", "false"))
        # A reused suite's jobs skip.
        self.assertEqual(values["cli"], "false")
        self.assertEqual(planner.outputs(dict(record, draft=True))["ready"], "false")
        # The files reach the jobs as one line, the rows as a JSON list.
        linux = dict(record, suites=["linux-e2e"], reused={},
                     e2e=dict(record["e2e"], linux_files=["e2e/a.e2e.ts", "e2e/sub/b.e2e.ts"], linux_shards=2))
        values = planner.outputs(linux)
        self.assertEqual((values["linux-e2e"], values["linux-e2e-files"], values["linux-e2e-shards"],
                          values["linux-e2e-full"]), ("true", "e2e/a.e2e.ts e2e/sub/b.e2e.ts", "[1,2]", "false"))

    def test_a_windows_only_file_runs_windows_end_to_end_on_both_architectures(self):
        # Decision 5: arm64 tests something x64 does not only for code that runs on Windows alone. The vendored terminal
        # is built into the host as term/ is.
        for path in ("pty/src/stream.rs", "term/src/capture.rs", "serial/src/main.rs",
                     "tui/vendor/alacritty_terminal/src/term/mod.rs", "tui/vendor/vte/src/lib.rs",
                     "cli/scripts/install.ps1", "cli/src/lib/ptyHostBackend.ts", "cli/src/lib/ptyHost/stream.ts",
                     "cli/src/engines/kit/windowsHooks.ts", "cli/e2e/dialWindows.e2e.ts", "cli/e2e/harness/windowsDaemon.ts",
                     "cli/vitest.e2e.windows.config.ts", "cli/scripts/windows-ci/check-install.ps1",
                     "cli/scripts/windows-ci/opencode.mjs", "cli/scripts/windows-install-manifest.mjs",
                     ".github/workflows/windows.yml"):
            with self.subTest(path=path):
                self.assertIn("windows-e2e", planner.select([path])[0])
                self.assertTrue(planner.windows_only(path))
                self.assertTrue(planner.e2e_plan([path], {"windows-e2e"})["windows_arm64"])

    def test_windows_in_a_name_outside_the_cli_runs_no_arm64(self):
        # Answer 2: the names of files under cli/ only; a folder's name (cli/src/lib/windows/) is not the file's.
        for path in ("desktop/windows/runner/main.cpp", "device-app/src-tauri/src/front_windows.rs",
                     ".github/workflows/windows-desktop.yml", "cli/src/lib/windows/program.ts"):
            with self.subTest(path=path):
                self.assertFalse(planner.windows_only(path))
                self.assertFalse(planner.e2e_plan([path], {"windows-e2e"})["windows_arm64"])

    def test_what_windows_yml_never_runs_selects_no_windows_end_to_end(self):
        # It builds no installer (windows-desktop.yml tests that), and runs none of the CLI's release scripts or Desktop's
        # pipe test server, whatever their names say.
        for path in ("installer/src/model.rs", "installer/Cargo.lock", "cli/scripts/publish-node-runtime-windows.sh",
                     "cli/scripts/windows-pipe-test-server.ts"):
            with self.subTest(path=path):
                self.assertFalse(planner.windows_only(path))
                self.assertNotIn("windows-e2e", planner.select([path])[0])

    def test_docs_and_images_run_no_windows_end_to_end(self):
        # Nothing windows.yml builds or runs reads them, but the notices the TUI compiles in (tui/src/main.rs).
        for path in ("tui/README.md", "tui/docs/panes.png", "tui/docs/tmux-improved.md", "tui/vendor/README.md",
                     "plugins/harness-device/README.md", "plugins/harness-device-vscode/README.md", "pty/README.md",
                     "cli/src/devices/notes.md", "tui/docs/shot.jpg"):
            with self.subTest(path=path):
                self.assertFalse(planner.windows_only(path))
                self.assertNotIn("windows-e2e", planner.select([path])[0])
        self.assertIn("windows-e2e", planner.select(["tui/THIRD_PARTY_NOTICES.md"])[0])

    def test_the_widened_paths_run_windows_end_to_end_on_x64_alone(self):
        # Decision 4: cross-platform code with win32 branches that broke only on Windows (#4513), the TUI windows.yml
        # tests, its specs' modules and the flasher it runs.
        for path in ("cli/src/devices/listenerPipe.ts", "cli/src/cable/hosts/kitty.ts", "cli/src/lib/windows/program.ts",
                     "cli/hook/notify.mjs", "plugins/harness-device/hooks/hooks.json", "plugins/harness-device-orca/src/dial.ts",
                     "plugins/harness-device-vscode/src/loop.ts", "cli/src/lib/secureState.spec.ts",
                     "cli/src/lib/secureState.ts", "cli/src/lib/uninstall/steps.ts", "cli/src/lib/tied.ts",
                     "website/src/app/flash-circle.ps1/flash-circle.ps1", "tui/src/main.rs", "tui/Cargo.toml"):
            with self.subTest(path=path):
                self.assertIn("windows-e2e", planner.select([path])[0])
                self.assertFalse(planner.windows_only(path))
                self.assertFalse(planner.e2e_plan([path], {"windows-e2e"})["windows_arm64"])

    def test_a_cross_platform_file_outside_the_lists_runs_no_end_to_end_suite(self):
        # The spec's negative: a typical CLI change pays for none of them.
        for path in ("cli/src/lib/tmuxBackend.ts", "cli/src/core/agents.ts", "cli/src/lib/engineLaunch.ts",
                     "desktop/windows/runner/main.cpp"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0] & planner.E2E, set())

    def test_the_windows_spec_list_is_windows_ymls(self):
        # windows.yml names its specs cli/-relative, a folder without its trailing slash.
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/windows.yml").read_text()
        lists = re.findall(r"(?m)^ +\$paths = @\((.+)\)$", workflow)
        self.assertEqual(len(lists), 2)
        named = set()
        for entry in (entry for listed in lists for entry in re.findall(r"'([^']+)'", listed)):
            path = posixpath.normpath(posixpath.join("cli", entry))
            named.add(path if path.endswith(".ts") else path + "/")
        self.assertIn("plugins/harness-device-vscode/src/", named)
        self.assertEqual(set(planner.WINDOWS_SPECS), named)

    def test_every_spec_windows_yml_runs_selects_windows_end_to_end(self):
        # Vitest takes each name as a filter (filterFiles): a case-insensitive substring of a test file's path from cli/,
        # so 'src/lib/windows' also ran src/lib/windowSurfaces.spec.ts, which windows-e2e does not run on. A folder ends
        # in '/', and a change to any file a filter takes runs windows-e2e.
        workflow = (REPOSITORY / ".github/workflows/windows.yml").read_text()
        filters = [entry for listed in re.findall(r"(?m)^ +\$paths = @\((.+)\)$", workflow)
                   for entry in re.findall(r"'([^']+)'", listed)]
        tracked = subprocess.check_output(["git", "ls-files", "-z", "--", "cli", "plugins"], cwd=REPOSITORY, text=True)
        tests = [path for path in tracked.split("\0") if re.search(r"\.(spec|test)\.tsx?$", path)]
        for entry in filters:
            with self.subTest(entry=entry):
                taken = [path for path in tests if entry.lower() in posixpath.relpath(path, "cli").lower()]
                self.assertTrue(taken)
                self.assertEqual([path for path in taken if not planner.windows_e2e(path)], [])
                if not entry.endswith(".ts"):
                    self.assertTrue(entry.endswith("/"), entry)

    def test_dial_host_files_and_adapters_run_the_dial_hosts_job_not_linux_e2e(self):
        # They need the hosts installed: the CI config leaves them out, and dial-hosts runs them all.
        for path in ("cli/e2e/dialHostKitty.e2e.ts", "cli/e2e/deviceHerdr.e2e.ts"):
            with self.subTest(path=path):
                self.assertFalse(planner.linux_e2e_file(path))
                self.assertIn("dial-hosts", planner.select([path])[0])
                self.assertNotIn("linux-e2e", planner.select([path])[0])
        # Their adapters run there alone; the harness, the configs and the setup action also run linux-e2e's canary.
        for entry in planner.DIAL_HOST_PATHS:
            path = entry + "x" if entry.endswith("/") else entry
            with self.subTest(path=path):
                self.assertIn("dial-hosts", planner.select([path])[0])
                self.assertEqual("linux-e2e" in planner.select([path])[0], planner.linux_e2e_canary_path(path))
        # A name that only starts like one, or one in a folder below, is not a dial host's: Vitest's glob stays in e2e/.
        for path in ("cli/e2e/deviceHerdrApp.e2e.ts", "cli/e2e/sub/dialHostKitty.e2e.ts"):
            with self.subTest(path=path):
                self.assertTrue(planner.linux_e2e_file(path))
                self.assertEqual(planner.select([path])[0] & {"dial-hosts", "linux-e2e"}, {"linux-e2e"})

    def test_the_code_the_dial_hosts_files_run_runs_them(self):
        # The daemon runs every host adapter from its bundle, beside what they import (observed.ts finds the hosts), and
        # the files drive them through the stand-in dial and desk. test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out
        # walks the imports on a full checkout.
        for path in ("cli/src/cable/hosts/observed.ts", "cli/src/cable/hosts/adapter.ts", "cli/src/cable/hosts/scannedApp.ts",
                     "cli/src/cable/hosts/outer.ts", "cli/src/cable/hosts/tmux.ts", "cli/src/cable/hosts/unixSocket.ts",
                     "cli/src/cable/hosts/socketAttempts.ts", "cli/src/cable/hosts/hostDetect.ts",
                     "cli/src/cable/hosts/frontApp.ts", "cli/e2e/harness/desk.ts", "cli/e2e/harness/fakeDial.ts"):
            with self.subTest(path=path):
                self.assertIn("dial-hosts", planner.select([path])[0])

    def test_some_files_never_run_on_linux(self):
        # windows-e2e runs the dial on Windows, diskfull is macOS only, and the agent browser's Podman file runs by hand.
        for path in ("cli/e2e/dialWindows.e2e.ts", "cli/e2e/diskfull.e2e.ts", "cli/e2e/agentBrowserPodman.e2e.ts"):
            with self.subTest(path=path):
                self.assertIn(path, planner.LINUX_E2E_NEVER)
                self.assertFalse(planner.linux_e2e_file(path))
                self.assertNotIn("linux-e2e", planner.select([path])[0])
        # Every other e2e file does, the dial's Windows tools too (they run on every platform); nothing else is one.
        for path in ("cli/e2e/startup.e2e.ts", "cli/e2e/dialWindowsTools.e2e.ts", "cli/e2e/sub/a.e2e.ts"):
            with self.subTest(path=path):
                self.assertTrue(planner.linux_e2e_file(path))
                self.assertIn("linux-e2e", planner.select([path])[0])
        for path in ("cli/e2e/harness/daemon.ts", "cli/src/lib/a.spec.ts", "cli/vitest.e2e.ci.config.ts", "tests/a.e2e.ts"):
            with self.subTest(path=path):
                self.assertFalse(planner.linux_e2e_file(path))
        for path in ("cli/src/lib/a.spec.ts", "tests/a.e2e.ts"):
            with self.subTest(path=path):
                self.assertNotIn("linux-e2e", planner.select([path])[0])

    def test_what_every_e2e_file_runs_on_runs_linux_e2e(self):
        # Answer P6: the setup action and its real backend, the harness, Vitest's e2e configs and the timing hints run no
        # e2e file of their own; linux-e2e runs its canary for them.
        for path in (".github/actions/cli-e2e-setup/action.yml", "cli/e2e/harness/daemon.ts", "cli/e2e/harness/realBackend.ts",
                     "cli/vitest.e2e.config.ts", "cli/vitest.e2e.ci.config.ts", "cli/ci-e2e-durations.json",
                     planner.LINUX_E2E_CANARY):
            with self.subTest(path=path):
                self.assertTrue(planner.linux_e2e_canary_path(path))
                self.assertIn("linux-e2e", planner.select([path])[0])
        # A real-backend file, which the setup action's backend step serves, and one linux-e2e runs.
        self.assertTrue(planner.linux_e2e_file(planner.LINUX_E2E_CANARY))
        for path in ("cli/vitest.config.ts", "cli/e2e/sharedTabs.e2e.ts", "cli/src/lib/a.ts", "cli/package.json"):
            with self.subTest(path=path):
                self.assertFalse(planner.linux_e2e_canary_path(path))

    def test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out(self):
        root = REPOSITORY
        source = root / "cli/e2e/harness/dialHosts.ts"
        full_checkout(self, "cli/e2e/harness/dialHosts.ts")
        listed = re.search(r"export const DIAL_HOST_FILES = \[([^\]]*)\]", source.read_text()).group(1)
        self.assertEqual(set(planner.DIAL_HOST_FILES), {"cli/" + name for name in re.findall(r"'([^']+)'", listed)})
        for entry in planner.DIAL_HOST_PATHS:
            with self.subTest(entry=entry):
                self.assertTrue((root / entry).is_dir() if entry.endswith("/") else (root / entry).is_file())
        # The code they run: what the files and the adapters (which the daemon runs from its bundle, so no import shows
        # them) import from the cable and the harness. A change to any of it runs dial-hosts, or, for the harness every
        # e2e file starts its daemons with, linux-e2e's canary, which imports it.
        files = sorted(str(path.relative_to(root)) for entry in planner.DIAL_HOST_FILES for path in root.glob(entry))
        adapters = sorted(str(path.relative_to(root)) for path in (root / "cli/src/cable/hosts").glob("*.ts")
                          if planner.dial_hosts_path(str(path.relative_to(root))) and ".spec." not in path.name)
        self.assertTrue(files and adapters)
        within = ("cli/e2e/harness/", "cli/src/cable/")
        canary = imports_from(root, [planner.LINUX_E2E_CANARY], within)
        run = imports_from(root, files + adapters, within) - set(files)
        self.assertEqual(sorted(path for path in run if not planner.dial_hosts_path(path) and path not in canary), [])

    def test_the_planner_and_the_tables_it_scans_with_alone_run_the_cross_read_scan(self):
        # process-checks' checkout is sparse, where the repository-wide scan skips: two undeclared reads slipped in so.
        for path in ("scripts/ci-plan.py", "scripts/tests/test_ci_plan.py", "scripts/record-ci-validation.py"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"cross-read-scan"})
        for path in ("scripts/local-checks.py", "scripts/tests/test_pr_e2e_jobs.py", ".github/workflows/ci.yml",
                     "cli/src/lib/relayFrames.ts", "desktop/lib/devices/x.dart"):
            with self.subTest(path=path):
                self.assertNotIn("cross-read-scan", planner.select([path])[0])
        self.assertEqual(planner.JOBS["cross-read-scan"], {"cross-read-scan"})
        self.assertEqual(planner.MANUAL["cross-read-scan"], {"cross-read-scan"})

    def test_the_cross_read_scan_reads_every_file_it_scans(self):
        # Its result depends on every component's files, so any of them changed on main reruns it.
        for path in ("cli/src/a.ts", "tests/a.ts", "desktop/lib/a.dart", "devices/harness-pro/a.c", "term/src/a.rs",
                     "plugins/harness-device-vscode/src/a.ts", "device-app/src-tauri/src/a.rs", "docs/guide.md"):
            with self.subTest(path=path):
                self.assertTrue(planner.reads("cross-read-scan", path))

    def test_either_release_workflow_runs_the_device_app_suite(self):
        # Its test_release_workflow.py reads both through a path built from parts, which the scan cannot see: a change
        # to either alone, Desktop's runners or signing inputs too, must run it.
        for path in (".github/workflows/release-device.yml", ".github/workflows/release-desktop.yml"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"device-app"})
                self.assertTrue(planner.reads("device-app", path))

    def test_the_workflow_carries_every_suite(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_text()
        options = re.search(r"(?m)^        options: \[(.+)\]$", workflow).group(1).split(", ")
        self.assertEqual(set(options), set(planner.MANUAL))
        self.assertLessEqual({"linux-e2e", "dial-hosts"}, set(options))
        # A dispatch of linux-e2e names its files; they reach the planner through env alone, never a run block.
        self.assertIn("      e2e_files:\n"
                      "        description: 'With scope linux-e2e: the cli/e2e files to run, separated by spaces'\n"
                      "        type: string\n"
                      "        default: ''\n",
                      re.search(r"(?ms)^  workflow_dispatch:\n(.*?)^  workflow_call:", workflow).group(1))
        select = re.search(r"(?ms)^      - id: select\n(.*?)(?=^      - )", workflow).group(1)
        self.assertIn("          CI_E2E_FILES: ${{ inputs.e2e_files }}\n", select)
        self.assertIn('--e2e-files="$CI_E2E_FILES"', select)
        self.assertEqual(workflow.count("inputs.e2e_files"), 1)
        jobs = dict(re.findall(r"(?m)^  ([\w-]+):\n((?:(?:    .*)?\n)+)", workflow))
        needs = set(re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[((?:.|\n)+?)\]", jobs["required"]).group(1)))
        for suite in sorted(planner.SUITES):
            with self.subTest(suite=suite):
                self.assertIn(f"      {suite}: ${{{{ steps.select.outputs.{suite} }}}}", jobs["plan"])
                for job in planner.JOBS[suite]:
                    self.assertIn(f"needs.plan.outputs.{suite} == 'true'", jobs[job])
                    self.assertIn(job, needs)
        # What the end-to-end jobs read besides their flags (windows-e2e-arm64, device-app-builds, linux-e2e's files,
        # rows and mode) reaches them too.
        record = dict(draft=False, suites=[], reused={}, e2e=planner.e2e_plan([], set()))
        for output in planner.outputs(record):
            with self.subTest(output=output):
                self.assertIn(f"      {output}: ${{{{ steps.select.outputs.{output} }}}}\n", jobs["plan"])
        job = jobs["device-app-checks"]
        for text in ("libwebkit2gtk-4.1-dev", "libayatana-appindicator3-dev", "librsvg2-dev",
                     "working-directory: device-app/ui", "npx vitest run", "npm run build",
                     "cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml",
                     "xvfb", "openbox", "xdotool", "xterm", "--ignored x11_live", "x11_live ... ok",
                     # A Windows leg runs the lib's rules; the Linux steps stay on the Linux leg.
                     "windows-latest", "cargo test --locked --lib --manifest-path device-app/src-tauri/Cargo.toml",
                     "strategy.job-index", "runner.os == 'Linux'"):
            self.assertIn(text, job)
        self.assertLess(job.index("npm run build"), job.index("cargo test"))  # the binary embeds ui/dist
        # The live X11 step reuses the unit tests' build.
        self.assertLess(job.index("cargo test --locked --manifest-path device-app/src-tauri/Cargo.toml"),
                        job.index("X11 front source, live"))
        self.assertNotIn("macos", job)
        # Every step but the checkout names its leg: a Linux step that lost its condition would run, and fail, on
        # Windows.
        steps = re.split(r"(?m)^      - ", job.split("\n    steps:\n", 1)[1])[1:]
        legs = [re.search(r"(?m)^(?:        )?if: runner\.os == '(\w+)'$", step) for step in steps]
        for step, leg in zip(steps, legs):
            with self.subTest(step=step.splitlines()[0]):
                if "actions/checkout@" in step:
                    self.assertIsNone(leg)
                else:
                    self.assertIsNotNone(leg)

        def leg_of(text):
            [leg] = [leg.group(1) for step, leg in zip(steps, legs) if leg and text in step]
            return leg

        for text, expected in (("-s device-app/scripts", "Linux"), ("libwebkit2gtk-4.1-dev", "Linux"),
                               ("actions/setup-node@", "Linux"), ("npx vitest run", "Linux"),
                               ("shared-key: device-app-pr\n", "Linux"),
                               ("run: cargo test --locked --manifest-path", "Linux"), ("--ignored x11_live", "Linux"),
                               ("shared-key: device-app-pr-windows", "Windows"),
                               ("run: cargo test --locked --lib --manifest-path", "Windows")):
            with self.subTest(text=text):
                self.assertEqual(leg_of(text), expected)

    def test_the_planner_reads_every_job_of_ci_yml(self):
        # An edit to a job runs its suite only while the planner finds the job's block in the real file.
        jobs = planner.ci_jobs((REPOSITORY / ".github/workflows/ci.yml").read_text())
        self.assertLessEqual(set().union(*planner.JOBS.values()) | {"plan", "process-checks", "device-app-build", "required"},
                             set(jobs))
        self.assertIn("    uses: ./.github/workflows/windows.yml\n", jobs["windows-e2e"])

    def test_the_cli_ptyhost_backend_and_the_vendored_terminal_also_belong_to_the_pty_suite(self):
        for path, expected in {
            "cli/src/lib/ptyHost/stream.ts": {"cli", "pty"}, "cli/src/lib/ptyHostBackend.ts": {"cli", "pty"},
            "cli/src/lib/ptyHostBackend.contract.spec.ts": {"cli", "pty"},
            "cli/src/lib/terminalBackend.contract.ts": {"cli", "pty"},
            "tui/vendor/alacritty_terminal/src/term/mod.rs": {"tui", "pty"},
            "cli/src/lib/ptyHostile.ts": {"cli"}, "cli/src/lib/tmuxBackend.ts": {"cli"},
        }.items():
            with self.subTest(path=path):
                self.assertEqual(planner.owners(path), expected)
                self.assertLessEqual(expected, planner.select([path])[0])

    def test_the_vscode_extension_belongs_to_the_cli_suite(self):
        # cli/build.mjs inlines it and cli/vitest.config.ts runs its tests; windows-e2e runs the dial plugins on Windows.
        for path in ("plugins/harness-device-vscode/src/loop.ts", "plugins/harness-device-vscode/package.json",
                     "plugins/harness-device-vscode/gate/realVscode.gate.ts"):
            with self.subTest(path=path):
                self.assertEqual(planner.owners(path), {"cli"})
                self.assertEqual(planner.select([path])[0], {"cli", "windows-e2e"})
                self.assertTrue(planner.reads("cli", path))
                self.assertIsNone(planner.shared_input(path))
        # A folder whose name only starts the same is not the extension's: it stays outside every component's suite.
        look_alike = "plugins/harness-device-vscode-x/a.ts"
        self.assertEqual(planner.owners(look_alike), set())
        self.assertEqual(planner.select([look_alike])[0], {"windows-e2e"})
        self.assertIsNotNone(planner.shared_input(look_alike))

    def test_the_orca_plugin_belongs_to_the_cli_suite(self):
        # cli/build.mjs inlines it: a change to it changes cli.js.
        for path in ("plugins/harness-device-orca/src/dial.ts", "plugins/harness-device-orca/orca-plugin.json"):
            with self.subTest(path=path):
                self.assertEqual(planner.owners(path), {"cli"})
                self.assertEqual(planner.select([path])[0], {"cli", "windows-e2e"})
                self.assertTrue(planner.reads("cli", path))
                self.assertIsNone(planner.shared_input(path))
        # A folder whose name only starts the same is not the plugin's.
        self.assertEqual(planner.select(["plugins/harness-device-orca-x/a.ts"])[0], {"windows-e2e"})

    def test_the_windows_installer_selects_the_pty_suite(self):
        # installer/'s model and steps are plain Rust that tests on Linux; pty-checks runs them (installer spec §4.1).
        for path in ("installer/src/model.rs", "installer/tests/entry-vectors.json", "installer/Cargo.lock"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"pty"})

    def test_the_pipe_auth_vectors_also_select_the_desktop_suite(self):
        # desktop/test/windows_pipe_auth_test.dart reads them from cli/: a new vector runs both halves.
        self.assertIn("desktop", planner.select(["cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json"])[0])
        self.assertNotIn("desktop", planner.select(["cli/src/lib/windows/pipeAuth.ts"])[0])

    def test_the_desktop_runner_and_its_durations_select_the_desktop_suite(self):
        # Task #3458: the runner splits the Desktop shards by the durations file; a change to either runs those shards,
        # so a bad split cannot merge on process checks alone.
        for path in ("scripts/test-desktop.py", "scripts/desktop-test-durations.json"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"desktop"})
        self.assertEqual(planner.select(["scripts/desktop-test-durations.py"])[0], set())

    def test_the_shared_terminal_crate_selects_both_the_pty_host_and_the_tui(self):
        # term/ is a dependency of the PTY host and of the shipped TUI (`hn`): both suites run (and os-checks, which packages
        # the TUI).
        for path in ("term/src/capture.rs", "term/Cargo.toml"):
            with self.subTest(path=path):
                self.assertEqual(planner.owners(path), {"pty", "tui"})
                self.assertEqual(planner.select([path])[0], {"os", "pty", "tui", "windows-e2e"})

    def test_a_file_another_suite_reads_selects_that_suite(self):
        # #4033 changed the CLI's engineLaunch.ts, which Desktop's and the phone's first-task tests read; its CI ran the
        # CLI's suite only, and main's Desktop CI went red until #4035. companions and pty import the CLI's code.
        self.assertEqual(planner.select(["cli/src/lib/engineLaunch.ts"])[0], {"cli", "companions", "desktop", "mobile", "pty"})
        self.assertEqual(planner.select(["cli/src/lib/tmuxBackend.ts"])[0], {"cli", "companions", "pty"})
        # A desktop file only the desktop reads runs the desktop alone; one the phone's tests read runs both.
        self.assertEqual(planner.select(["desktop/lib/widgets/pane_grid.dart"])[0], {"desktop"})
        self.assertEqual(planner.select(["desktop/lib/widgets/engine_identity.dart"])[0], {"desktop", "mobile"})
        # Desktop's and the CLI's tests read the Store's agents and branding, which no component owns.
        self.assertEqual(planner.select(["store/agents/blender/store.json"])[0], {"cli", "desktop"})

    def test_the_app_list_vectors_select_desktop_device_app_and_website(self):
        # Every writer of Harness Device's Linux app-list entry holds its bytes and rule to one shared file: the app,
        # Desktop and the website's one-line installer. The CLI owns tests/ and the backend reads tests/fixtures/.
        path = "tests/fixtures/app-list-entry-vectors.json"
        self.assertEqual(planner.select([path])[0], {"backend", "cli", "desktop", "device-app", "website"})
        for suite in ("desktop", "device-app", "website"):
            with self.subTest(suite=suite):
                self.assertTrue(planner.reads(suite, path))

    def test_every_declared_input_selects_the_suite_that_reads_it(self):
        # A PR that changes a file a suite reads runs that suite; reuse after Update branch counts it as an input too.
        for suite, entries in planner.PR_READS.items():
            for entry in entries:
                path = entry + "x" if entry.endswith("/") else entry
                with self.subTest(suite=suite, path=path):
                    self.assertIn(suite, planner.select([path])[0])
                    self.assertTrue(planner.reads(suite, path) or planner.shared_input(path))

    def test_the_cli_spec_reruns_on_either_device_history_copy(self):
        # deviceHistory.spec.ts compares the desktop's and the phone's copies with its own (SEC-1 on #4087): the path was
        # built from a name, the scan did not see it, and a narrowed list let a changed copy reuse the CLI's result.
        for app in ("desktop", "mobile"):
            path = f"{app}/test/viewer/deviceHistory.vectors.json"
            with self.subTest(path=path):
                self.assertIn("cli", planner.select([path])[0])
                self.assertTrue(planner.reads("cli", path))

    def test_the_pro_app_icon_art_selects_the_firmware_suite(self):
        # The Pro's run.sh fails when main/pod/app_icons.c no longer matches .github/assets/apps (gen_app_icons.py
        # --check, and test_app_icons.py reads the README): a PR that changes only the art must run it, or a stale bake
        # reaches main and fails the next firmware PR.
        for path in (".github/assets/apps/vscode.png", ".github/assets/apps/README.md"):
            with self.subTest(path=path):
                self.assertEqual(planner.select([path])[0], {"firmware"})
        self.assertEqual(planner.select([".github/assets/engines/claude.png"])[0], set())

    def test_the_store_example_images_select_the_desktop_suite(self):
        # store_discover_test.dart opens each Store example image from the repository; seven are in docs/images/ (SEC-1).
        self.assertEqual(planner.select(["docs/images/poster.png"])[0], {"desktop"})

    def test_reuse_keeps_the_broad_inputs_selection_narrows(self):
        # The scan misses a path joined from parts (SEC-2 on #4087), so reuse counts everything a suite may read: Desktop
        # every input of its sparse checkout. Only selection uses the narrow lists, where a miss runs one suite too few.
        for entry in planner.ci.SOURCE_INPUTS["desktop"]:
            path = entry + "x" if entry.endswith("/") else entry
            with self.subTest(path=path):
                self.assertTrue(planner.reads("desktop", path) or planner.shared_input(path))
        self.assertTrue(planner.reads("desktop", "cli/src/lib/tmuxBackend.ts"))
        self.assertNotIn("desktop", planner.select(["cli/src/lib/tmuxBackend.ts"])[0])
        # The folders the other suites narrowed for selection stay whole for reuse.
        for suite, path in (("cli", "desktop/test/a.json"), ("daemons", "companions/src/companion/a.ts"), ("firmware", "cli/src/a.ts"),
                            ("mobile", "desktop/lib/a.dart"), ("os", "cli/src/a.ts"), ("website", "backend/src/a.ts")):
            with self.subTest(suite=suite, path=path):
                self.assertTrue(planner.reads(suite, path))
                self.assertNotIn(suite, planner.select([path])[0])

    def test_every_declared_input_exists(self):
        # A declaration of a removed file selects a suite for a look-alike someone adds later, and hides nothing it reads.
        root = REPOSITORY
        full_checkout(self, "cli/src")
        for suite, entries in [*planner.DEPENDS.items(), *planner.PR_READS.items()]:
            # A shared input (the sparse checkout's optional .gitmodules) reruns everything whether it exists or not.
            for entry in (entry for entry in entries if not planner.shared_input(entry)):
                with self.subTest(suite=suite, entry=entry):
                    self.assertTrue((root / entry).is_dir() if entry.endswith("/") else (root / entry).is_file())

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
        self.assertEqual(plan["suites"], ["cli", "companions", "desktop", "pty"])

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
        # all: every component's suite; each end-to-end suite runs by its own scope.
        self.assertEqual(set(planner.make_plan(self.root, "workflow_dispatch", {}, "all")["suites"]),
                         planner.SUITES - planner.E2E)
        with self.assertRaises(ValueError):
            planner.make_plan(self.root, "workflow_dispatch", {}, "typo")

    def test_a_manual_end_to_end_run_takes_arm64_and_the_builds_its_suite_needs(self):
        # A run by hand names no changed path: windows-e2e then runs both architectures.
        windows = planner.make_plan(self.root, "workflow_dispatch", {}, "windows-e2e")
        self.assertEqual((windows["suites"], windows["required_jobs"]), (["windows-e2e"], ["process-checks", "windows-e2e"]))
        self.assertEqual(windows["e2e"], {"windows_arm64": True, "device_app_builds": [], **NO_LINUX_E2E})
        desktop = planner.make_plan(self.root, "workflow_dispatch", {}, "device-app-desktop")
        self.assertEqual(desktop["e2e"], {"windows_arm64": False, "device_app_builds": FOUR_BUILDS, **NO_LINUX_E2E})
        self.assertEqual(planner.make_plan(self.root, "workflow_dispatch", {}, "all")["e2e"],
                         {"windows_arm64": False, "device_app_builds": [], **NO_LINUX_E2E})

    def hints(self, durations):
        """cli/ci-e2e-durations.json: per-file hints, keyed cli/-relative, and the 60-second default."""
        self.write("cli/ci-e2e-durations.json", json.dumps({"schema": 1, "defaultDurationMs": 60_000, "durationMs": durations}))

    def test_the_prs_added_and_modified_e2e_files_run_on_linux(self):
        self.write("cli/e2e/b.e2e.ts")
        self.write("cli/e2e/c.e2e.ts")
        self.hints({"e2e/a.e2e.ts": 30_000})
        self.base = self.commit()
        self.write("cli/e2e/a.e2e.ts")
        self.write("cli/e2e/b.e2e.ts", "changed")
        (self.root / "cli/e2e/c.e2e.ts").unlink()
        self.commit()
        plan = self.plan()
        self.assertIn("linux-e2e", plan["suites"])
        self.assertEqual(plan["e2e"]["linux_files"], ["e2e/a.e2e.ts", "e2e/b.e2e.ts"])
        self.assertEqual((plan["e2e"]["linux_shards"], plan["e2e"]["linux_full"]), (1, False))
        self.assertNotIn("linux-e2e", plan["reasons"]["cli/e2e/c.e2e.ts"])
        self.assertLessEqual({"linux-e2e", "linux-e2e-summary"}, set(plan["required_jobs"]))

    def test_a_change_to_what_every_e2e_file_runs_on_runs_the_canary(self):
        canary = planner.LINUX_E2E_CANARY.removeprefix("cli/")
        self.write(planner.LINUX_E2E_CANARY)
        self.write("cli/e2e/harness/old.ts")
        self.hints({})
        self.base = self.commit()
        self.write("cli/e2e/harness/daemon.ts")
        (self.root / "cli/e2e/harness/old.ts").unlink()  # a deletion counts too: the harness changed
        self.commit()
        plan = self.plan()
        self.assertIn("linux-e2e", plan["reasons"]["cli/e2e/harness/old.ts"])
        self.assertEqual((plan["e2e"]["linux_files"], plan["e2e"]["linux_shards"]), ([canary], 1))
        # Beside the PR's own e2e files.
        self.write("cli/e2e/a.e2e.ts")
        self.commit()
        self.assertEqual(self.plan()["e2e"]["linux_files"], ["e2e/a.e2e.ts", canary])
        # A head without the canary fails the plan, naming it: a PR that deletes it runs it, so it fails there.
        (self.root / planner.LINUX_E2E_CANARY).unlink()
        self.commit()
        with self.assertRaisesRegex(ValueError, re.escape(planner.LINUX_E2E_CANARY)):
            self.plan()

    def test_a_change_to_a_jobs_definition_in_ci_yml_runs_its_suite(self):
        # Answer P5: a job's block is part of what its suite tests. device-app-build serves the Device suites that
        # install its packages; the plan, process and gate jobs run no suite.
        def workflow(edited=(), added=()):
            jobs = ["plan", "process-checks", "cli-tests", "linux-e2e", "dial-hosts", "device-app-build",
                    "device-app-update", "required", *added]
            blocks = "".join(f"  # {job} comes next\n  {job}:\n    runs-on: ubuntu-24.04\n"
                             f"    steps:\n      - run: echo {'edited' if job in edited else 'base'}\n\n" for job in jobs)
            return f"name: CI\non:\n  pull_request:\n    types: [opened]\njobs:\n{blocks}"

        self.write(".github/workflows/ci.yml", workflow())
        self.write(planner.LINUX_E2E_CANARY)
        self.hints({})
        self.base = self.commit()
        for edited, added, suites in (
                (("linux-e2e", "device-app-build"), (), {"linux-e2e", "device-app-e2e", "device-app-desktop",
                                                          "device-app-install"}),
                (("cli-tests",), (), {"cli"}), ((), ("cross-read-scan",), {"cross-read-scan"}),
                (("plan", "process-checks", "required"), (), set())):
            with self.subTest(edited=edited, added=added):
                self.git("checkout", "-q", "--detach", self.base)
                self.write(".github/workflows/ci.yml", workflow(edited, added))
                self.commit()
                plan = self.plan()
                self.assertEqual(set(plan["suites"]), suites)
                self.assertEqual(plan["reasons"][".github/workflows/ci.yml"], sorted(suites))
                # linux-e2e has no file of its own then: it runs the canary.
                self.assertEqual(plan["e2e"]["linux_files"],
                                 [planner.LINUX_E2E_CANARY.removeprefix("cli/")] if "linux-e2e" in suites else [])
        # A comment between jobs is in no job's block.
        self.git("checkout", "-q", "--detach", self.base)
        self.write(".github/workflows/ci.yml", workflow().replace("# dial-hosts comes next", "# the dial's hosts"))
        self.commit()
        self.assertEqual(self.plan()["suites"], [])

    def test_a_pr_that_only_deletes_an_e2e_file_runs_no_linux_e2e(self):
        self.write("cli/e2e/c.e2e.ts")
        self.base = self.commit()
        (self.root / "cli/e2e/c.e2e.ts").unlink()
        self.commit()
        plan = self.plan()  # No hints file in the tree: none is read.
        self.assertEqual(plan["paths"], ["cli/e2e/c.e2e.ts"])
        self.assertNotIn("linux-e2e", plan["suites"])
        self.assertEqual({key: plan["e2e"][key] for key in NO_LINUX_E2E}, NO_LINUX_E2E)

    def test_files_spread_over_runners_by_their_hints(self):
        # Answer 6: one runner per 10 hinted minutes, at most one per file and 4 in all.
        self.hints({f"e2e/long{index}.e2e.ts": 600_000 for index in range(30)})
        head = self.commit()
        long = [f"cli/e2e/long{index}.e2e.ts" for index in range(30)]
        short = [f"cli/e2e/short{index}.e2e.ts" for index in range(12)]  # at the default
        for paths, shards in ((long[:3], 3), (short, 2), (long, 4)):
            with self.subTest(files=len(paths), shards=shards):
                plan = planner.e2e_plan(paths, {"linux-e2e"}, self.root, head)
                self.assertEqual(plan["linux_shards"], shards)
                self.assertEqual(plan["linux_files"], sorted(path.removeprefix("cli/") for path in paths))
                self.assertFalse(plan["linux_full"])
        # A tree without the hints fails the plan, naming the file.
        with self.assertRaisesRegex(ValueError, "cli/ci-e2e-durations.json"):
            planner.e2e_plan(long[:3], {"linux-e2e"}, self.root, self.base)

    def test_more_than_40_files_run_the_full_suite_on_the_nightlys_shards(self):
        # Answer 6: a big refactor stays mergeable. The base has no hints file: the full run reads none.
        files = [f"cli/e2e/f{index:02}.e2e.ts" for index in range(41)]
        full = planner.e2e_plan(files, {"linux-e2e"}, self.root, self.base)
        self.assertEqual((full["linux_full"], full["linux_files"], full["linux_shards"]), (True, [], 8))
        values = planner.outputs(dict(draft=False, suites=["linux-e2e"], reused={}, e2e=full))
        self.assertEqual((values["linux-e2e-full"], values["linux-e2e-files"], values["linux-e2e-shards"]),
                         ("true", "", "[1,2,3,4,5,6,7,8]"))
        self.hints({})
        head = self.commit()
        listed = planner.e2e_plan(files[:40], {"linux-e2e"}, self.root, head)
        self.assertFalse(listed["linux_full"])
        self.assertEqual(listed["linux_files"], [path.removeprefix("cli/") for path in files[:40]])
        self.assertLessEqual(listed["linux_shards"], 4)
        # The full mode passes no name on, yet every name is still checked.
        with self.assertRaisesRegex(ValueError, re.escape("cli/e2e/a b.e2e.ts")):
            planner.e2e_plan(files + ["cli/e2e/a b.e2e.ts"], {"linux-e2e"}, self.root, head)

    def test_an_e2e_file_name_outside_the_safe_set_fails_the_plan(self):
        # Review Focus 1: the list reaches the jobs' shells through env; the plan passes on plain names alone.
        for path in ("cli/e2e/a b.e2e.ts", "cli/e2e/$(x).e2e.ts", "cli/e2e/a;b.e2e.ts", "cli/e2e/'a.e2e.ts"):
            with self.subTest(path=path):
                self.git("checkout", "-q", "--detach", self.base)
                self.write(path)
                self.commit()
                with self.assertRaisesRegex(ValueError, re.escape(path)):
                    self.plan()

    def test_a_dispatch_runs_the_e2e_files_it_names(self):
        self.write("cli/e2e/a.e2e.ts")
        self.write("cli/e2e/diskfull.e2e.ts")
        self.write("cli/e2e/dir.e2e.ts/b.e2e.ts")
        self.hints({})
        self.commit()

        def dispatch(scope, files):
            return planner.make_plan(self.root, "workflow_dispatch", {}, scope, e2e_files=files)

        plan = dispatch("linux-e2e", "cli/e2e/a.e2e.ts")
        self.assertEqual((plan["suites"], plan["required_jobs"]), (["linux-e2e"], ["linux-e2e", "linux-e2e-summary",
                                                                                   "process-checks"]))
        self.assertEqual((plan["e2e"]["linux_files"], plan["e2e"]["linux_shards"]), (["e2e/a.e2e.ts"], 1))
        # linux-e2e by hand needs its files, and no other scope takes any.
        for scope, files in (("linux-e2e", ""), ("linux-e2e", "  "), ("cli", "cli/e2e/a.e2e.ts"),
                             ("all", "cli/e2e/a.e2e.ts")):
            with self.subTest(scope=scope, files=files), self.assertRaises(ValueError):
                dispatch(scope, files)
        # A file the tree does not hold (a folder is not one), or one that never runs on Linux, fails by name.
        for path in ("cli/e2e/missing.e2e.ts", "cli/e2e/dir.e2e.ts", "cli/e2e/diskfull.e2e.ts"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, re.escape(path)):
                dispatch("linux-e2e", f"cli/e2e/a.e2e.ts {path}")

    def test_ci_required_takes_the_same_linux_e2e_jobs_in_both_modes(self):
        # One job shape (the plan's Decisions): the gate holds both modes to the same two jobs.
        paths = [f"cli/e2e/f{index:02}.e2e.ts" for index in range(41)]
        for path in paths:
            self.write(path)
        self.hints({})
        self.commit()
        for files, full in ((paths[0], False), (" ".join(paths), True)):
            with self.subTest(full=full):
                plan = planner.make_plan(self.root, "workflow_dispatch", {}, "linux-e2e", e2e_files=files)
                self.assertEqual(plan["e2e"]["linux_full"], full)
                self.assertEqual(plan["required_jobs"], ["linux-e2e", "linux-e2e-summary", "process-checks"])
                needs = {job: {"result": "success"} for job in plan["required_jobs"] + ["plan"]}
                self.assertEqual(planner.verify(plan, needs, plan["head"])["status"], "passed")
                with self.assertRaisesRegex(ValueError, "linux-e2e-summary"):
                    planner.verify(plan, dict(needs, **{"linux-e2e-summary": {"result": "skipped"}}), plan["head"])


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

    def plan(self, head, base, evidence=True, draft=False, body=None):
        self.git("checkout", "-q", "--detach", head)
        payload = {"pull_request": {"head": {"sha": head}, "base": {"sha": base}, "draft": draft,
                                    **({"body": body} if body is not None else {})}}
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
        # cli-tests and cli-typecheck cover cli/src only; cli/e2e runs in its own workflow.
        _, main, head = self.scenario(["backend/src/app.ts", "cli/src/a.ts"], ["cli/e2e/run.e2e.ts"])
        plan = self.plan(head, main)
        self.assertEqual(list(plan["reused"]), ["backend", "cli"])

    def test_a_main_integration_test_change_reruns_the_backend_suite(self):
        # backend-integration runs backend/integration (task #2459), so main's change there was never tested with this PR.
        _, main, head = self.scenario(["backend/src/app.ts"], ["backend/integration/teams.test.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("backend/integration/teams.test.ts", plan["reuse"]["rerun"]["backend"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks", "backend-desk", "backend-integration"}))

    def test_the_os_suite_reruns_when_main_changes_the_dial_ids_it_checks(self):
        # os/tests/test_lock_and_screenshot.py reads cli/src/cable/serial.ts from the repository root.
        _, main, head = self.scenario(["os/root/usr/lib/udev/rules.d/70-harness-device.rules"], ["cli/src/cable/serial.ts"])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["os"])
        self.assertEqual(plan["reused"], {})
        self.assertIn("cli/src/cable/serial.ts", plan["reuse"]["rerun"]["os"])
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS["os"]))

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
        # Parents reversed (main first, the passed head merged in) is a batch of one (BatchReuseTests).

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

    def test_an_end_to_end_suite_reruns_when_main_changes_what_it_reads(self):
        passed = self.branch(self.base, ["cli/src/devices/x.ts"], "pr")
        self.evidence.add(self.root, passed, planner.select(["cli/src/devices/x.ts"])[0], run_id=11)
        for index, (path, reused) in enumerate((("cli/src/a.ts", False), ("docs/guide.md", True))):
            with self.subTest(main=path):
                main = self.branch(self.base, [path], f"main-{index}")
                plan = self.plan(self.update(passed, main), main)
                self.assertIn("windows-e2e", plan["suites"])
                self.assertEqual("windows-e2e" in plan["reused"], reused)
                self.assertEqual("windows-e2e" in plan["required_jobs"], not reused)

    def test_linux_e2e_reruns_when_main_changes_the_cli_its_files_run(self):
        self.write("cli/ci-e2e-durations.json", json.dumps({"schema": 1, "defaultDurationMs": 60_000, "durationMs": {}}))
        self.base = self.commit()
        passed = self.branch(self.base, ["cli/e2e/a.e2e.ts"], "pr")
        self.evidence.add(self.root, passed, planner.select(["cli/e2e/a.e2e.ts"])[0], run_id=11)
        for index, (path, reused) in enumerate((("cli/src/a.ts", False), ("docs/guide.md", True))):
            with self.subTest(main=path):
                main = self.branch(self.base, [path], f"main-{index}")
                plan = self.plan(self.update(passed, main), main)
                self.assertIn("linux-e2e", plan["suites"])
                self.assertEqual("linux-e2e" in plan["reused"], reused)
                self.assertEqual("linux-e2e-summary" in plan["required_jobs"], not reused)
                self.assertEqual(plan["e2e"]["linux_files"], [] if reused else ["e2e/a.e2e.ts"])

    def test_a_reused_device_app_suite_skips_while_another_rebuilds(self):
        # Review Focus 4: main changed only Desktop's half, so only the Desktop install runs again; it still needs all
        # four packages, and the reused suites' jobs (device-app-linux among them) must skip.
        _, main, head = self.scenario(["device-app/src-tauri/tauri.conf.json"], ["desktop/lib/devices/x.dart"])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["device-app", "device-app-desktop", "device-app-e2e", "device-app-install",
                                          "device-app-update"])
        self.assertEqual(sorted(plan["reused"]), ["device-app", "device-app-e2e", "device-app-install", "device-app-update"])
        self.assertEqual(plan["e2e"]["device_app_builds"], FOUR_BUILDS)
        self.assertEqual(plan["required_jobs"], ["device-app-desktop", "process-checks"])

    def test_draft_and_merge_group_plans_never_reuse(self):
        _, main, head = self.scenario(["mobile/lib/app.dart"], ["backend/src/app.ts"])
        self.assertEqual(self.plan(head, main, draft=True)["reused"], {})
        self.assertEqual(self.evidence.lookups, [])
        payload = {"action": "checks_requested", "merge_group": {"head_sha": head, "base_sha": main}}
        self.assertEqual(planner.make_plan(self.root, "merge_group", payload, source=head, evidence=self.evidence)["reused"], {})
        self.assertEqual(self.evidence.lookups, [])


class BatchReuseTests(ReuseFixture):
    """A batch PR (a branch from main with each member PR merged in) reuses a member's passed result for a component
    when nothing that component reads changed between that member's tested commit and the batch head (task #2720)."""

    def batch(self, main, members):
        """The PM's batch branch: main, then each member's tested head merged in, first parent the batch."""
        self.git("checkout", "-q", "--detach", main)
        for member in members:
            self.git("merge", "-q", "--no-ff", "--no-edit", member)
        return self.git("rev-parse", "HEAD")

    def member(self, name, paths, run_id, start=None):
        head = self.branch(start or self.base, paths, name)
        self.evidence.add(self.root, head, planner.select(paths)[0], run_id=run_id)
        return head

    def test_a_batch_with_one_phone_pr_reuses_mobile_checks(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        api = self.member("api", ["backend/src/app.ts"], 22)
        main = self.branch(self.base, ["docs/guide.md"], "main")
        head = self.batch(main, [phone, api])
        plan = self.plan(head, main)
        self.assertEqual(plan["suites"], ["backend", "mobile"])
        self.assertEqual(plan["required_jobs"], ["process-checks"])
        self.assertEqual((plan["reused"]["mobile"]["origin_sha"], plan["reused"]["mobile"]["run_id"]), (phone, 21))
        self.assertEqual((plan["reused"]["backend"]["origin_sha"], plan["reused"]["backend"]["run_id"]), (api, 22))
        self.assertEqual(plan["reused"]["mobile"]["origin_tree"], self.git("rev-parse", f"{phone}^{{tree}}"))
        self.assertIn("backend/src/app.ts", plan["reused"]["mobile"]["reason"])
        self.assertEqual(plan["reuse"]["status"], "applied")
        self.assertEqual((plan["reuse"]["kind"], plan["reuse"]["members"]), ("batch", [phone, api]))

    def test_two_phone_prs_in_one_batch_run_mobile_checks(self):
        first = self.member("phone-1", ["mobile/lib/app.dart"], 21)
        second = self.member("phone-2", ["mobile/lib/other.dart"], 22)
        api = self.member("api", ["backend/src/app.ts"], 23)
        head = self.batch(self.base, [first, second, api])
        plan = self.plan(head, self.base)
        self.assertNotIn("mobile", plan["reused"])
        self.assertIn("mobile-checks", plan["required_jobs"])
        self.assertRegex(plan["reuse"]["rerun"]["mobile"], "mobile/lib/(app|other).dart")
        self.assertEqual(list(plan["reused"]), ["backend"])

    def test_a_main_change_to_a_mobile_input_after_the_member_ran_runs_it(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        main = self.branch(self.base, ["mobile/lib/shared.dart"], "main")
        plan = self.plan(self.batch(main, [phone]), main)
        self.assertEqual(plan["reused"], {})
        self.assertIn("mobile/lib/shared.dart", plan["reuse"]["rerun"]["mobile"])

    def test_a_shared_input_runs_everything(self):
        # Changed by a member: the batch's own change, which its own CI run reads.
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        locked = self.member("locked", ["cli/package-lock.json"], 22)
        self.assertRerunsAll(self.plan(self.batch(self.base, [phone, locked]), self.base), "cli/package-lock.json")
        # Changed on main after a member's run.
        main = self.branch(self.base, [".github/workflows/ci.yml"], "main")
        self.assertRerunsAll(self.plan(self.batch(main, [phone]), main), ".github/workflows/ci.yml")

    def test_an_unreadable_receipt_runs_its_component(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        api = self.member("api", ["backend/src/app.ts"], 22)
        del self.evidence.gates[phone]
        head = self.batch(self.base, [phone, api])
        plan = self.plan(head, self.base)
        self.assertEqual(list(plan["reused"]), ["backend"])
        self.assertIn("mobile-checks", plan["required_jobs"])
        self.assertIn("not a pass", plan["reuse"]["rerun"]["mobile"])
        # Nothing readable at all: every component runs.
        self.evidence.failure = RuntimeError("GitHub lookup failed (1): api")
        plan = self.plan(head, self.base)
        self.assertEqual(plan["reused"], {})
        self.assertEqual(plan["required_jobs"], sorted({"process-checks"} | planner.JOBS["backend"] | planner.JOBS["mobile"]))

    def test_the_pr_body_is_never_read(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        # The same change landed as one plain commit on main: no merge names a member, whatever the body says.
        self.git("checkout", "-q", "--detach", self.base)
        self.write("mobile/lib/app.dart", "phone mobile/lib/app.dart")
        squashed = self.commit("batch")
        body = f"Batch: #101 at {phone} passed in run 21 (https://github.com/o/r/actions/runs/21)."
        plan = self.plan(squashed, self.base, body=body)
        self.assertEqual(plan["reused"], {})
        self.assertNotIn(phone, [lookup[1] for lookup in self.evidence.lookups])
        # A real batch is read from its merges alone: a body naming another commit changes nothing.
        stranger = self.member("stranger", ["mobile/lib/app.dart"], 99)
        head = self.batch(self.base, [phone])
        self.assertEqual(self.plan(head, self.base, body=f"#7 at {stranger}")["reused"]["mobile"]["origin_sha"], phone)
        self.assertNotIn(stranger, [lookup[1] for lookup in self.evidence.lookups])

    def test_a_batch_that_merged_main_again_still_reads_its_members(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        head = self.batch(self.base, [phone])
        later = self.branch(self.base, ["backend/src/app.ts"], "main")
        self.git("checkout", "-q", "--detach", head)
        self.git("merge", "-q", "--no-ff", "--no-edit", later)
        plan = self.plan(self.git("rev-parse", "HEAD"), later)
        self.assertEqual(plan["reused"]["mobile"]["origin_sha"], phone)
        self.assertEqual(plan["reuse"]["members"], [phone])

    def test_a_hand_commit_on_the_batch_line_runs_everything(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        self.batch(self.base, [phone])
        self.write("backend/src/app.ts", "fixed by hand")
        self.assertRerunsAll(self.plan(self.commit("fix"), self.base), "not a merge")

    def test_a_member_whose_run_reused_points_at_the_original_run(self):
        passed = self.member("phone", ["mobile/lib/app.dart"], 21)
        main = self.branch(self.base, ["backend/src/app.ts"], "main")
        updated = self.update(passed, main)
        reused = self.plan(updated, main)["reused"]
        self.evidence.add(self.root, updated, {"mobile"}, run_id=31, reused=reused)
        plan = self.plan(self.batch(main, [updated]), main)
        self.assertEqual((plan["reused"]["mobile"]["origin_sha"], plan["reused"]["mobile"]["run_id"]), (passed, 21))
        self.assertIn(("ran", passed, 21, "mobile"), self.evidence.lookups)

    def test_the_helper_verifies_a_batch_reuse_and_refuses_other_members(self):
        phone = self.member("phone", ["mobile/lib/app.dart"], 21)
        api = self.member("api", ["backend/src/app.ts"], 22)
        head = self.batch(self.base, [phone, api])
        plan = self.plan(head, self.base)
        receipt = dict(source_sha=head, suites=plan["suites"], reused=plan["reused"], reuse=plan["reuse"], event="pull_request")
        self.assertEqual(planner.verify_reuse(self.root, receipt, self.base, self.evidence), plan["reused"])
        forged = dict(receipt, reuse=dict(plan["reuse"], members=[api]))
        with self.assertRaisesRegex(ValueError, "members"):
            planner.verify_reuse(self.root, forged, self.base, self.evidence)


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

    def test_ci_required_holds_each_end_to_end_suite_to_its_jobs(self):
        # device-app-build is in no suite's JOBS, but ci/required needs it: a failed build fails the gate.
        plan = dict(self.plan, suites=["device-app-install", "windows-e2e"],
                    required_jobs=["device-app-install", "process-checks", "windows-e2e"])
        needs = {name: {"result": "success"} for name in plan["required_jobs"] + ["plan", "device-app-build"]}
        self.assertEqual(planner.verify(plan, needs, self.head)["required_jobs"], plan["required_jobs"])
        for job, result in (("device-app-install", "skipped"), ("windows-e2e", "skipped"), ("device-app-build", "failure")):
            with self.subTest(job=job, result=result), self.assertRaisesRegex(ValueError, job):
                planner.verify(plan, dict(needs, **{job: {"result": result}}), self.head)

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

    def test_an_undeclared_read_from_the_repository_root_is_refused(self):
        _, main, head, receipt = self.reusing(pr_paths=("mobile/lib/app.dart", "mobile/test/root_test.dart"))
        self.git("checkout", "-q", "--detach", head)
        (self.root / "mobile/test/root_test.dart").write_text("File(p.join(repo, 'backend/src/app.ts')).readAsStringSync();")
        self.git("commit", "-qam", "reads the backend from the root")
        reader = self.git("rev-parse", "HEAD")
        self.evidence.add(self.root, reader, {"mobile"}, run_id=41)
        later = self.branch(main, ["backend/src/app.ts"], "main-root")
        head = self.update(reader, later)
        plan = self.plan(head, later)
        self.assertEqual(list(plan["reused"]), ["mobile"])
        with self.assertRaisesRegex(ValueError, "mobile/test/root_test.dart reads backend/src/app.ts"):
            planner.verify_reuse(self.root, self.receipt(plan), later, self.evidence)

    def test_a_look_alike_inside_the_component_cannot_hide_a_root_read_from_the_helper(self):
        for (name, line), deleted in itertools.product(
                (("root", "File(p.join(repo, 'backend/src/app.ts')).readAsStringSync();"),
                 ("relative", "File('../backend/src/app.ts').readAsStringSync();")), (False, True)):
            with self.subTest(form=name, main_deletes_it=deleted):
                _, main, head, receipt = self.reusing(pr_paths=("mobile/lib/app.dart", "mobile/test/root_test.dart"))
                self.git("checkout", "-q", "--detach", head)
                (self.root / "mobile/test/root_test.dart").write_text(line)
                self.write("mobile/backend/src/app.ts", "an unused look-alike")
                reader = self.commit(f"reads the backend past a look-alike ({name})")
                self.evidence.add(self.root, reader, {"mobile"}, run_id=51)
                if deleted:  # The real read now fails; the look-alike must not make it look internal.
                    self.git("checkout", "-q", "-B", f"main-delete-{name}", main)
                    self.git("rm", "-q", "backend/src/app.ts")
                    later = self.commit("main deletes the file")
                else:
                    later = self.branch(main, ["backend/src/app.ts"], f"main-look-alike-{name}")
                merged = self.update(reader, later)
                plan = self.plan(merged, later)
                self.assertEqual(list(plan["reused"]), ["mobile"])
                with self.assertRaisesRegex(ValueError, "mobile/test/root_test.dart reads backend/src/app.ts"):
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
        (self.root / "scripts/local-checks.py").write_text((scripts / "local-checks.py").read_text())
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
        self.write("cli/src/engines/codex/contract.ts", "data")
        self.write("mobile/test/b_test.dart", "final f = File('../cli/src/engines/$id/contract.ts'); // declared: cli/src/engines/")
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
        self.write("cli/e2e/helpers.ts", "export const x = 1")
        self.write("cli/src/a.spec.ts", "import { x } from '../e2e/helpers'")
        self.write("cli/e2e/b.e2e.ts", "import { y } from './helpers'; import '../src/a'")
        self.assertEqual(planner.undeclared_reads(self.root, "cli"), [("cli/src/a.spec.ts", "cli/e2e/")])

    def test_a_read_built_at_run_time_needs_its_whole_folder_declared(self):
        self.write("tui/src/a.rs", 'include_str!("../../backend/src/types/productUsage.ts"); let p = "../../backend/src/";')
        self.assertEqual(planner.undeclared_reads(self.root, "tui"), [
            ("tui/src/a.rs", "backend/src/"), ("tui/src/a.rs", "backend/src/types/productUsage.ts")])
        self.write("mobile/test/a_test.dart", "File('../backend/src/$name');")
        self.assertEqual(planner.undeclared_reads(self.root, "mobile"), [("mobile/test/a_test.dart", "backend/src/")])

    def test_a_path_named_from_the_repository_root_is_a_read(self):
        # As os/tests/test_lock_and_screenshot.py reads the dial ids: (ROOT.parents[1] / 'cli/src/cable/serial.ts').read_text()
        self.write("website/src/dial.ts", "DIAL_VENDOR_ID = 0x303a")
        self.write("os/tests/session_vm.py", "pass")
        self.write("tests/fixture.ts", "data")  # a top-level tests/ too: the internal path must not resolve there
        self.write("os/tests/test_a.py", "\n".join([
            "serial = (ROOT.parents[1] / 'website/src/dial.ts').read_text()",
            'usage = Path(REPO, "backend/src/types/productUsage.ts")',
            "# a comment naming 'backend/src/app.ts' is not a read",
            "vm = (OS / 'tests/session_vm.py').read_text()  # os/tests/session_vm.py: inside its own directory",
            "url = 'https://example.test/backend/src/app.ts'",
            "missing = ROOT / 'backend/src/nothing.ts'",
            "from './backend/src/app.ts' import x  # relative imports are the other scan's",
        ]))
        self.assertEqual(planner.undeclared_reads(self.root, "os"), [
            ("os/tests/test_a.py", "backend/src/"), ("os/tests/test_a.py", "backend/src/types/productUsage.ts"),
            ("os/tests/test_a.py", "website/src/dial.ts")])

    def test_a_look_alike_inside_the_component_does_not_hide_a_real_read(self):
        # A PR could add an unused mobile/backend/src/app.ts so that a read of backend/src/app.ts looks internal.
        self.write("mobile/backend/src/app.ts", "unused")
        self.write("mobile/test/root_test.dart", "File(p.join(repo, 'backend/src/app.ts'));")
        self.write("mobile/test/relative_test.dart", "File('../backend/src/app.ts');")
        self.write("mobile/lib/only_inside.dart", "File(p.join(here, 'backend/src/inner.ts'));")
        self.write("mobile/backend/src/inner.ts", "an internal file with no root twin")
        self.write("mobile/lib/notes.dart", "/// `../backend/src/app.ts` named in a doc comment is not a read")
        self.assertEqual(planner.undeclared_reads(self.root, "mobile"), [
            ("mobile/test/relative_test.dart", "backend/src/app.ts"), ("mobile/test/root_test.dart", "backend/src/app.ts")])

    def test_a_read_of_a_path_main_deleted_counts_when_the_helper_names_it(self):
        self.write("mobile/backend/gone/app.ts", "an unused look-alike")
        self.write("mobile/test/root_test.dart", "File(p.join(repo, 'backend/gone/app.ts'));")
        self.write("mobile/test/relative_test.dart", "File('../backend/gone/app.ts');")
        self.assertEqual(planner.undeclared_reads(self.root, "mobile"), [])
        self.assertEqual(planner.undeclared_reads(self.root, "mobile", ["backend/gone/app.ts"]), [
            ("mobile/test/relative_test.dart", "backend/gone/app.ts"), ("mobile/test/root_test.dart", "backend/gone/app.ts")])

    def test_a_checkout_without_a_scanned_file_refuses_rather_than_finding_nothing(self):
        # CI's process-checks checkout is sparse: its files are listed but absent, and the scan found no read there.
        self.write("mobile/test/a_test.dart", "File('../backend/src/app.ts');")
        self.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture")
        self.git("sparse-checkout", "set", "--no-cone", "/backend/", "/cli/")
        with self.assertRaisesRegex(ValueError, "mobile/test/a_test.dart"):
            planner.undeclared_reads(self.root, "mobile")

    def test_an_end_to_end_suites_own_files_are_scanned(self):
        # windows-e2e runs cli/src/devices/ as its own: what those files read is its input after Update branch.
        self.write("cli/src/devices/x.ts", "readFileSync('../../../backend/src/app.ts')")
        self.assertEqual(planner.undeclared_reads(self.root, "windows-e2e"), [("cli/src/devices/x.ts", "backend/src/app.ts")])

    def test_strings_that_are_only_data_are_listed_with_a_reason(self):
        for source, (reason, targets) in planner.NOT_READS.items():
            with self.subTest(source=source):
                self.assertTrue(reason.strip() and targets)
                self.assertTrue(all(isinstance(target, str) and target for target in targets))
        self.write("backend/src/fixture.test.ts", "work('lead', 'Own', ['cli/src/lib'])")
        self.assertEqual(planner.undeclared_reads(self.root, "backend"), [("backend/src/fixture.test.ts", "cli/src/lib/")])
        original = dict(planner.NOT_READS)
        self.addCleanup(lambda: (planner.NOT_READS.clear(), planner.NOT_READS.update(original)))
        planner.NOT_READS["backend/src/fixture.test.ts"] = ("owned-code strings in a fixture", {"cli/src/lib/"})
        self.assertEqual(planner.undeclared_reads(self.root, "backend"), [])

    def test_a_data_folder_covers_the_paths_under_it_but_never_a_relative_read(self):
        # Task #4511: backend tests hold owned paths ('desktop/lib/c.dart') as task data; every Desktop change on main
        # then refused backend's reuse at merge, though nothing opened those files.
        self.write("backend/src/fixture.test.ts", "work(['cli/src/lib/a.ts', 'desktop/lib/devices/x.dart']); "
                                                   "readFileSync(new URL('../../cli/src/lib/a.ts', import.meta.url))")
        original = dict(planner.NOT_READS)
        self.addCleanup(lambda: (planner.NOT_READS.clear(), planner.NOT_READS.update(original)))
        planner.NOT_READS["backend/src/fixture.test.ts"] = ("test data: owned paths", {"cli/", "desktop/"})
        self.assertEqual(planner.undeclared_reads(self.root, "backend"), [("backend/src/fixture.test.ts", "cli/src/lib/a.ts")])

    def test_every_cross_read_in_this_repository_is_declared(self):
        # The merge helper runs this scan too, on its own full checkout, before accepting reuse.
        repository = REPOSITORY
        full_checkout(self, "cli/src", "desktop/lib", "mobile/lib", "backend/src")
        for suite in sorted(planner.SUITES):
            with self.subTest(suite=suite):
                self.assertEqual(planner.undeclared_reads(repository, suite), [])
                # The end-to-end suites' path lists and the scan's own files select them on purpose, never what their
                # files read: those reads count for reuse (DEPENDS) alone.
                if suite not in planner.E2E | {"cross-read-scan"}:
                    self.assertEqual(planner.undeclared_reads(repository, suite, inputs=planner.PR_READS), [])


class FullCheckoutTests(unittest.TestCase):
    """The tests ci.yml's cross-read-scan job runs on a full checkout, with CROSS_READ_SCAN_REQUIRED=1."""
    NAMES = ("SelectionTests.test_every_desktop_file_the_phone_tests_read_selects_mobile",
             "SelectionTests.test_the_dial_host_files_are_the_ones_cli_e2e_leaves_out",
             "SelectionTests.test_every_declared_input_exists",
             "CrossReadTests.test_every_cross_read_in_this_repository_is_declared")

    def results_without_a_checkout(self, required):
        """Each test's result in a checkout that holds none of what it reads."""
        results = {}
        module = sys.modules[__name__]
        with tempfile.TemporaryDirectory() as empty, \
                mock.patch.object(module, "REPOSITORY", Path(empty), create=True), \
                mock.patch.dict(os.environ, {"CROSS_READ_SCAN_REQUIRED": required}):
            for name in self.NAMES:
                result = unittest.TestResult()
                unittest.defaultTestLoader.loadTestsFromName(name, module).run(result)
                results[name] = result
        return results

    def test_the_scan_jobs_tests_fail_without_a_full_checkout_and_skip_elsewhere(self):
        # A skip exits 0: in the job that exists to run them, a checkout without their files would pass as green.
        for name, result in self.results_without_a_checkout("1").items():
            with self.subTest(name=name, required=True):
                self.assertEqual((result.testsRun, len(result.failures), len(result.errors), len(result.skipped)),
                                 (1, 1, 0, 0))
                self.assertIn("needs a full checkout", result.failures[0][1])
        # process-checks' checkout is sparse: there they skip.
        for name, result in self.results_without_a_checkout("").items():
            with self.subTest(name=name, required=False):
                self.assertEqual((result.testsRun, len(result.failures), len(result.errors), len(result.skipped)),
                                 (1, 0, 0, 1))


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

    def test_a_receipt_from_a_planner_that_adds_a_job_passes_the_older_helper(self):
        # The merge helper runs from main; a PR that adds a CI job (#2804: backend-integration) brings a receipt listing a
        # job main's JOBS does not know yet. Every job main requires ran and passed, so it may merge (batch #2815 refused).
        self.github.add_run(12, self.head, self.tree, ["mobile", "backend"])
        receipt = self.github.receipts[12]
        receipt["required_jobs"] = sorted(receipt["required_jobs"] + ["backend-new-shards"])
        receipt["results"]["backend-new-shards"] = "success"
        gate = self.evidence.passed_gate(self.head)
        self.assertIn("backend-new-shards", gate["receipt"]["required_jobs"])

    def test_a_receipt_missing_a_job_main_requires_or_with_a_failed_extra_job_is_refused(self):
        self.github.add_run(12, self.head, self.tree, ["mobile", "backend"])
        receipt = self.github.receipts[12]
        receipt["required_jobs"] = [job for job in receipt["required_jobs"] if job != "backend-desk"]
        with self.assertRaisesRegex(ValueError, "does not run every suite"):
            self.evidence.passed_gate(self.head)
        self.github.add_run(13, self.head, self.tree, ["mobile", "backend"])
        receipt = self.github.receipts[13]
        receipt["required_jobs"] = sorted(receipt["required_jobs"] + ["backend-new-shards"])
        receipt["results"]["backend-new-shards"] = "failure"
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            self.evidence.passed_gate(self.head)
        # A duplicate or unsorted list is refused: the subset check alone would let one through (review of #2817).
        for index, edit in enumerate([lambda jobs: sorted(jobs + [jobs[0]]), lambda jobs: list(reversed(jobs))]):
            with self.subTest(index=index):
                self.github.add_run(14 + index, self.head, self.tree, ["mobile", "backend"])
                receipt = self.github.receipts[14 + index]
                receipt["required_jobs"] = edit(receipt["required_jobs"])
                with self.assertRaisesRegex(ValueError, "does not run every suite"):
                    self.evidence.passed_gate(self.head)

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
