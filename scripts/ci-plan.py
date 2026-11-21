#!/usr/bin/env python3
"""Select fast CI suites from a complete Git diff and verify their final results.

A PR runs the unit suite of each component it changes and of each suite that reads a changed file (PR_READS), and each
end-to-end suite (E2E: windows-e2e, linux-e2e, dial-hosts, device-app-e2e, device-app-update, device-app-desktop,
device-app-install) whose own path list names a changed file; linux-e2e runs the CLI e2e files the PR adds or modifies.
A change to this planner, its test, the tables it reads or the CLI lists they copy runs the repository-wide cross-read
scan and the planner's other full-checkout tests on a full checkout.
Merge groups run only the plan and process checks: the PR run already covered the code.
After GitHub merges main into a PR head whose ci/required passed, a component whose
inputs main's new commits left untouched reuses that run's result instead of running
again (docs/validation-and-release.md#reuse-after-update-branch).
Checks outside PR CI are listed in docs/validation-and-release.md#what-pr-ci-does-not-run.
"""
import argparse
import fnmatch
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
import zipfile

_spec = importlib.util.spec_from_file_location("ci_evidence", Path(__file__).with_name("record-ci-validation.py"))
ci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci)

_local_spec = importlib.util.spec_from_file_location("local_checks", Path(__file__).with_name("local-checks.py"))
local_checks = importlib.util.module_from_spec(_local_spec)
_local_spec.loader.exec_module(local_checks)


CORE = {"cli", "desktop", "tui", "backend", "companions"}
EXTRA = {"website", "os", "provider", "firmware", "mobile", "daemons", "pty", "device-app"}
# End to end on Windows and Linux, each selected by its own path list (below).
E2E = {"windows-e2e", "linux-e2e", "dial-hosts", "device-app-e2e", "device-app-update", "device-app-desktop",
       "device-app-install"}
SUITES = CORE | EXTRA | {"pro", "cross-read-scan"} | E2E
JOBS = {
    "cli": {"cli-typecheck", "cli-tests"},
    "pro": {"pro-firmware-build", "pro-golden"},
    "desktop": {"desktop-tests"},
    # backend-integration: the Super Tab integration suite (backend/integration) in four shards (task #2459).
    "tui": {"tui-test"}, "backend": {"backend-desk", "backend-integration"}, "companions": {"companion-subsystems"},
    **{name: {name + "-checks"} for name in EXTRA},
    # windows-e2e calls windows.yml; device-app-e2e is the app on Linux and on Windows. linux-e2e's summary holds each
    # file to its own result, in both of its modes; dial-hosts calls cli-e2e-dial-hosts.yml.
    "windows-e2e": {"windows-e2e"}, "device-app-e2e": {"device-app-linux", "device-app-windows"},
    "linux-e2e": {"linux-e2e", "linux-e2e-summary"},
    **{name: {name} for name in ("dial-hosts", "device-app-update", "device-app-desktop", "device-app-install",
                                 "cross-read-scan")},
}
# all: every component's suite and the cross-read scan. The end-to-end suites cost far more runner time; each runs by
# its own scope.
MANUAL = {"full": CORE, "all": SUITES - E2E, "process": set(), **{name: {name} for name in SUITES}}
# Each component's own directory selects its suite. Everything else (docs, workflows,
# scripts, store, fixtures) is covered by the plan's actionlint and process checks.
COMPONENTS = {"cli": "cli", "tests": "cli", "desktop": "desktop", "tui": "tui", "backend": "backend",
              "companions": "companions", "website": "website", "os": "os", "provider": "provider",
              "devices": "firmware", "mobile": "mobile", "daemons": "daemons", "pty": "pty", "term": "pty",
              "device-app": "device-app",
              # harness-install.exe's model and steps test on Linux; its Windows half runs in windows-desktop.yml.
              "installer": "pty"}
# Code inside another component that a suite runs as its own (its references are scanned as the suite's reads): the PTY
# host's suite runs the CLI's ptyhost terminal contract against the host it builds, and the host builds on the vendored
# terminal. The shipped TUI (`hn`) builds on term/ as the host does, so a term/ change runs its tests too. A file a suite
# only reads is in DEPENDS.
ALSO = {"cli/src/lib/ptyHost/": "pty", "cli/src/lib/ptyHostBackend": "pty",
        "cli/src/lib/terminalBackend.contract.ts": "pty", "tui/vendor/": "pty", "term/": "tui"}
# The Desktop VM runner and the measured file times it splits the shards by (task #3458): a change to either runs those
# shards, so a split that runs short cannot merge on process checks alone.
ALSO.update({"scripts/test-desktop.py": "desktop", "scripts/desktop-test-durations.json": "desktop"})
# The desktop test helper the phone's tests import (session_work_page_test.dart).
ALSO.update({"desktop/test/support/real_fonts.dart": "mobile"})
# The VS Code extension: the CLI's build inlines the folder and the CLI's vitest runs its tests.
ALSO.update({"plugins/harness-device-vscode/": "cli"})
# Orca's plugin: the CLI's build inlines the folder.
ALSO.update({"plugins/harness-device-orca/": "cli"})
# test_ci_plan's repository-wide scan and its other full-checkout tests skip in process-checks' sparse checkout, where
# two undeclared reads slipped in: their own job runs them on a full checkout. They run for a change to the planner, its
# test, the tables it reads (DEPENDS takes the desktop's from record-ci-validation.py) and the CLI's lists its tables
# copy (dialHosts.ts's DIAL_HOST_FILES, the CI config's exclude), and select() adds them for any component change: an
# undeclared read an ordinary component pull request added was found only by the next planner pull request or make
# merge-pr's reuse check, and the scan costs about 0.5 runner-minutes (measured in #4526).
ALSO.update({path: "cross-read-scan" for path in ("scripts/ci-plan.py", "scripts/tests/test_ci_plan.py",
                                                  "scripts/record-ci-validation.py", "cli/e2e/harness/dialHosts.ts",
                                                  "cli/vitest.e2e.ci.config.ts")})
# Narrower directories that add a suite on top of their component's (the ESP32-P4 build and golden screens).
SUBCOMPONENTS = {"devices/harness-pro/": "pro"}

# The end-to-end suites' own paths: what each one's jobs build, run or install. Narrow on purpose, and no PR_READS: each
# costs many times a unit suite (windows-e2e about 43 runner-minutes, the Device suites about 200 together), so only a
# change to code its jobs exercise runs one, and a typical CLI pull request runs none. A file their tests merely read
# runs its component's unit suite; reuse after Update branch still counts it (DEPENDS).
# windows-e2e: windows.yml's specs (both of its `$paths` lists, cli/-relative there), each with the module it tests.
WINDOWS_SPECS = (
    "cli/src/lib/ptyHostBackend.contract.spec.ts", "cli/src/lib/ptyHostBackend.spec.ts",
    "cli/src/lib/ptyHostBackend.restart.spec.ts", "cli/src/lib/ptyHost/", "cli/src/lib/windows/",
    "cli/src/scripts/windowsCiChecks.spec.ts", "cli/src/lib/uninstall/",
    "cli/src/engines/kit/hookRemoval.spec.ts", "cli/src/engines/kit/windowsHooks.spec.ts",
    "cli/src/engines/kit/windowsFiles.spec.ts", "cli/src/engines/kit/nativePaths.windows.spec.ts",
    "cli/src/engines/kit/launchExecutable.windows.spec.ts", "cli/src/dsh/runtime.windows.spec.ts",
    "cli/src/engines/removeHooks.spec.ts", "cli/src/engines/windowsHomes.spec.ts", "cli/src/cable/windowsSerial.spec.ts",
    "cli/src/cable/serialWindows.spec.ts", "cli/src/engines/kit/folderTrust.spec.ts",
    "cli/src/lib/tied.spec.ts", "cli/src/lib/connectors/call.spec.ts", "cli/src/lib/secureState.spec.ts",
    "cli/src/lib/registryLock.publish.spec.ts", "cli/src/lib/pidFileSettle.spec.ts",
    "cli/src/devices/listenerPipe.windows.real.spec.ts", "cli/src/devices/claudePlugin.windows.real.spec.ts",
    "cli/src/deviceClaude/inbox.windows.real.spec.ts", "cli/src/hookCaller.windows.real.spec.ts",
    "cli/src/harnessDevicePlugin.spec.ts", "plugins/harness-device-vscode/src/",
    "cli/src/lib/engineBin.pathEntries.spec.ts",
    # The two real builds.
    "cli/src/lib/hostMove/hostMove.real.spec.ts", "cli/src/lib/ptyHost/drain.spec.ts",
    "cli/src/lib/windows/ptyInstall.windows.real.spec.ts", "cli/src/scripts/installPs1.spec.ts",
    "cli/src/testing/windowsPowerShell.spec.ts",
)
# A spec tests the module beside it named up to its first dot: secureState.spec.ts tests secureState.ts.
WINDOWS_SPEC_MODULES = {str(PurePosixPath(spec).with_name(PurePosixPath(spec).name.split(".")[0] + ".ts"))
                        for spec in WINDOWS_SPECS if not spec.endswith("/")}
# Harness Device's suites: what each of ci.yml's Device jobs tests. "dir/" is a folder; a "*" matches within the last
# name. Each also selects on the jobs' setup action, as dial-hosts on its own: device-app-update's jobs and the
# device-app-build packages the others install set up through it.
DEVICE_APP_SETUP = ".github/actions/device-app-setup/"
DEVICE_APP_PATHS = {
    # The app end to end on Linux and on Windows: any change to it.
    "device-app-e2e": ("device-app/", DEVICE_APP_SETUP),
    # One build updating to the next: the updater, the pair of builds, each driver's update path, how a release builds,
    # and the app's configuration and dependencies.
    "device-app-update": (DEVICE_APP_SETUP, "device-app/src-tauri/src/update.rs",
                          "device-app/scripts/e2e/update-pair.sh",
                          "device-app/scripts/e2e/linux.sh", "device-app/scripts/e2e/windows.ps1",
                          "device-app/scripts/release-build.sh", "device-app/scripts/release-check.sh",
                          "device-app/scripts/release-setup.sh", "device-app/src-tauri/tauri*.conf.json",
                          "device-app/src-tauri/Cargo.toml", "device-app/src-tauri/Cargo.lock"),
    # Desktop installs the app: Desktop's half, the Linux signature check it runs (with the update check that one
    # extends), the end-to-end install test and the test signer it signs the Device package with, so a change to how
    # that package's signature is made or checked runs it; the Flutter its jobs set up on each arch, and the app's
    # install, packaging and instance code.
    "device-app-desktop": (DEVICE_APP_SETUP, ".github/actions/desktop-flutter/", ".github/actions/desktop-flutter-arm64/",
                           "desktop/lib/devices/", "desktop/lib/update/tauri_signature.dart",
                           "desktop/lib/update/update_signature.dart",
                           "desktop/integration_test/device_app_install_windows_linux_native_test.dart",
                           "desktop/test/support/tauri_test_signer.dart",
                           "device-app/src-tauri/src/install.rs", "device-app/src-tauri/src/packaging.rs",
                           "device-app/src-tauri/src/instance.rs", "device-app/src-tauri/tauri*.conf.json"),
    # The one-line install on each Ubuntu: the website's script, its stand-in CDN, and how the AppImage starts.
    "device-app-install": (DEVICE_APP_SETUP, "website/scripts/device-install.sh",
                           "device-app/scripts/e2e/linux-install.sh",
                           "device-app/scripts/e2e/https-fake-cdn.py", "device-app/src-tauri/src/appimage_env.rs",
                           "device-app/src-tauri/src/packaging.rs", "device-app/src-tauri/tauri*.conf.json"),
}
# The debug packages (bundle, arch) the Device suites' jobs install, in device-app-build's order. That job is in no
# suite's JOBS: its rows are the running suites' packages, so a suite reused after Update branch builds nothing and its
# jobs skip, while ci/required still needs the job (a failed build fails the gate).
DEVICE_APP_PACKAGES = (("appimage", "x64"), ("appimage", "arm64"), ("nsis", "x64"), ("nsis", "arm64"))
DEVICE_APP_BUILDS = {"device-app-e2e": DEVICE_APP_PACKAGES, "device-app-desktop": DEVICE_APP_PACKAGES,
                     "device-app-install": (("appimage", "x64"),)}
# linux-e2e: a CLI e2e file the PR adds or modifies, but those another job runs: windows-e2e the dial and the apps'
# sessions on it on Windows, diskfull.e2e.ts needs macOS, the agent browser's Podman file runs by hand (about 50
# minutes), and dial-hosts the files that need the hosts installed (cli/e2e/harness/dialHosts.ts's DIAL_HOST_FILES, which
# the CI config leaves out).
LINUX_E2E_NEVER = {"cli/e2e/dialWindows.e2e.ts", "cli/e2e/dialWindowsAppSessions.e2e.ts", "cli/e2e/diskfull.e2e.ts",
                   "cli/e2e/agentBrowserPodman.e2e.ts"}
# What every e2e file runs on but none tests itself: the jobs' setup action (its real backend, which dial-hosts does not
# ask for), the harness, Vitest's e2e configs and the timing hints. A change to one runs linux-e2e's canary, a short file
# (two daemons on the real backend, one case) beside the PR's own; the canary's own deletion runs it, so that PR fails.
LINUX_E2E_CANARY = "cli/e2e/twoAccounts.spike.e2e.ts"
LINUX_E2E_CANARY_PATHS = (".github/actions/cli-e2e-setup/", "cli/e2e/harness/", "cli/vitest.e2e*.config.ts",
                          "cli/ci-e2e-durations.json", LINUX_E2E_CANARY)
# The e2e files that drive an Orca terminal through Orca's terminal-host stand-in (InOrca with a handle) and run on
# Linux; the macOS-only ones are run locally (docs/plans/2026-11-21-dial-linux-followups-plan.md, Verification), as no
# PR CI suite runs macOS.
LINUX_E2E_ORCA_FILES = ("cli/e2e/dialOrcaFocus.e2e.ts", "cli/e2e/dialOrcaFullRing.e2e.ts", "cli/e2e/dialStream.e2e.ts",
                        "cli/e2e/dialPaneFollow.e2e.ts", "cli/e2e/dialClaudeAppFollow.e2e.ts")
# What they cover and no other linux-e2e file does: the stand-in, InOrca, the fake orca CLI and Orca's adapter. A change
# to one runs them beside the PR's own files; its deletion too, as a canary path's does.
LINUX_E2E_ORCA_PATHS = ("cli/e2e/harness/orcaHost.ts", "cli/e2e/harness/inOrca.ts", "cli/e2e/harness/fakeOrca.ts",
                        "cli/src/cable/hosts/orca.ts")
DIAL_HOST_FILES = ("cli/e2e/dialHost*.e2e.ts", "cli/e2e/deviceHerdr.e2e.ts")
# dial-hosts: those files, the code they run and the job's own definition. The daemon runs every host adapter from its
# bundle, and the adapters share their folder's code (observed.ts finds the hosts): the whole folder, and what it and the
# files import from the cable. The files drive them through the harness's stand-in dial and desk and each host's helper.
# test_ci_plan walks the imports.
DIAL_HOST_PATHS = (
    "cli/e2e/harness/dialHosts.ts", "cli/vitest.e2e.dialHosts.config.ts", "cli/src/cable/hosts/",
    *(f"cli/src/cable/{name}.ts" for name in ("cableFrame", "portAccess", "roundGlyphs")),
    *(f"cli/e2e/harness/{name}.ts" for name in ("desk", "fakeBackend", "fakeDial", "fakeOrca", "herdrServer", "inOrca",
                                                 "kittyWindow", "orcaHost", "outsideAgent", "swayDesk", "weztermMux",
                                                 "x11Desk", "zellijSession")),
    ".github/workflows/cli-e2e-dial-hosts.yml", ".github/actions/cli-e2e-setup/",
)
# The names linux-e2e passes on: they reach the jobs' shells through env, and Vitest as file filters, so plain names only.
E2E_FILE = re.compile(r"cli/e2e/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.e2e\.ts")
# Answer 6: one runner per 10 hinted minutes (cli/ci-e2e-durations.json), at most 4. Above 40 files the full suite runs
# instead, as the nightly runs it: cli-e2e.yml's `shard: [1..8]`, `vitest.e2e.ci.config.ts --shard=N/8`, which its
# duration sequencer splits.
LINUX_E2E_RUNNERS = 4
LINUX_E2E_FILES_MAX = 40
LINUX_E2E_RUNNER_MS = 600_000
LINUX_E2E_FULL_SHARDS = 8

# Reuse after Update branch. Reusing an earlier result needs every file a suite may read outside its own directory,
# because main's commits were never tested together with this PR: these sets are broad on purpose, as the scan misses a
# path joined from parts, and a miss here would reuse a stale result. "dir/" is a prefix, else a file.
# test_ci_plan.CrossReadTests scans the components' sources and fails on an undeclared read.
# The desktop VM tests run in a sparse checkout of exactly these inputs (ci-source-inputs.py).
DEPENDS = {
    "backend": ("cli/src/lib/productHealthContract.ts", "cli/src/lib/productUsageContract.ts",
                "daemons/frames.json",
                "desktop/lib/measurement/", "mobile/lib/measurement/",
                "provider/reference-provider/", "tests/fixtures/"),
    "cli": ("backend/src/lib/deviceAck.vectors.json", "backend/src/lib/deviceAckCore.ts", "desktop/",
            "cli/e2e/harness/", "devices/harness-device/firmware/main/ui/habitat/focus_faces.c",
            "devices/harness-device/firmware/test/vectors/", "docs/contracts/", "mobile/", "pty/", "store/", "tui/"),
    "companions": ("cli/", "docs/research/2026-09-30-memory-batch-extraction-cases.json",
                   "docs/research/2026-09-30-memory-extraction-cases.json"),
    # Its generators write (and its checks may compare) these outputs.
    "daemons": ("backend/src/lib/daemonRoster.g.ts", "companions/src/companion/", "desktop/assets/daemon-art/",
                "desktop/lib/daemons/illustrated_alignment.g.dart", "desktop/lib/daemons/plates.g.dart",
                "desktop/lib/daemons/roster.g.dart", "mobile/lib/daemons/plates.g.dart", "mobile/lib/daemons/roster.g.dart"),
    "firmware": ("cli/scripts/", "cli/src/", "daemons/plates/tux.mjs", "daemons/review/traits.html",
                 "daemons/tools/illustrated/daemon_art.py", "daemons/tools/plate.mjs", "desktop/assets/model-icons/claude.png"),
    # Its tools also import the web release scripts; its tests see only the sparse inputs.
    "desktop": ci.SOURCE_INPUTS["desktop"] + ("website/scripts/harness-web-assets.mjs", "website/scripts/precompress.mjs"),
    # Its release tests read both release workflows (test_release_workflow.py, a path built from parts).
    # app_list.rs holds its Linux app-list entry to the vectors every writer of it reads.
    "device-app": (".github/workflows/release-desktop.yml", ".github/workflows/release-device.yml",
                   "tests/fixtures/app-list-entry-vectors.json"),
    "mobile": ("backend/src/types/productHealthContract.ts", "backend/src/types/productUsage.ts", "cli/src/",
               "daemons/banner.json", "daemons/frames.json", "daemons/plates.json", "daemons/roster.json", "desktop/",
               "docs/performance/"),
    # pty-checks also runs the CLI's ptyhost contract, which imports CLI code.
    # os-checks reads the CLI's dial ids (cli/src/cable/serial.ts), its version and the TUI it packages;
    # term/ by hand: the update fixture copies `git ls-files -- tui term`, which the scan cannot see.
    "os": ("cli/", "devices/harness-device/firmware/README.md", "docs/naming-system.md", "docs/terminology.md", "term/", "tui/"),
    "pty": ("cli/", "desktop/windows/runner/resources/app_icon.ico"),
    # THIRD_PARTY_NOTICES.md: tui/src/main.rs includes ../THIRD_PARTY_NOTICES.md, which names a root file too.
    "tui": ("THIRD_PARTY_NOTICES.md", "cli/package.json", "os/network.py", "os/onboarding.py", "os/root/usr/bin/hn",
            "tests/fixtures/shared-pane-layouts.json"),
    # device-install.spec.ts holds the one-line installer's app-list entry to the vectors.
    "website": ("backend/src/", "cli/packages/harness-mcp/", "cli/src/agentClient/commands.ts", "cli/src/lib/newCommand.ts",
                "cli/src/messages/command.ts", "desktop/lib/core/phone_app_links.dart",
                "desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_512.png",
                "tests/fixtures/app-list-entry-vectors.json"),
}
# An end-to-end suite reads what the unit suites of the code it runs read, and all of that code: windows.yml builds the
# PTY host, the serial bridge and the TUI, and runs the CLI's specs, the dial plugins' and the website's flasher; the
# Device jobs run the app, Desktop's install of it and the website's one-line installer. linux-e2e and dial-hosts run the
# CLI's e2e files on its build, which inlines the dial plugins; linux-e2e also starts the real backend.
DEPENDS.update({
    "windows-e2e": DEPENDS["cli"] + DEPENDS["pty"] + DEPENDS["tui"] + (
        "cli/", "tests/", "plugins/", "pty/", "serial/", "term/", "tui/", "website/"),
    # device-app/src-tauri/: dialAppFilterOnDial.e2e.ts starts the Device app's debug build (with a dial, by hand).
    # .github/actions/, in both: their setup action's folder (a shared input), where the scan also places the action's
    # `../backend`.
    "linux-e2e": DEPENDS["cli"] + ("cli/", "tests/", "plugins/harness-device-orca/", "plugins/harness-device-vscode/",
                                   "backend/", "device-app/src-tauri/", ".github/actions/"),
    "dial-hosts": DEPENDS["cli"] + ("cli/", "tests/", "plugins/harness-device-orca/", "plugins/harness-device-vscode/",
                                    ".github/actions/"),
    "device-app-e2e": DEPENDS["device-app"] + ("device-app/",),
    "device-app-update": DEPENDS["device-app"] + ("device-app/",),
    "device-app-desktop": DEPENDS["device-app"] + DEPENDS["desktop"] + ("device-app/", "desktop/"),
    "device-app-install": DEPENDS["device-app"] + ("device-app/", "website/scripts/device-install.sh"),
    # The scan reads every component's files and the docs their strings may name; the planner's tables name them all.
    # Only a PR that changes the CLI's lists alone may reuse it (its other files are under scripts/, a shared input).
    "cross-read-scan":tuple(sorted({path.split("/", 1)[0] + "/" for path in (*COMPONENTS, *ALSO, *SUBCOMPONENTS)}
                                    | {"docs/"})),
})

# Selection. The files each suite reads outside its own directory, as narrow as the scan shows: a PR that changes one
# runs that suite (#4033 changed a CLI file Desktop's tests read and ran the CLI's suite only). Each is inside the
# suite's DEPENDS above. Name files, not their folders: a folder runs its reader on every PR that touches it.
# test_ci_plan.CrossReadTests scans the components' sources against these too; a path built from parts is declared by
# hand, or named in full where it is read. A miss here runs one suite too few on a PR; reuse still sees the change.
PR_READS = {
    "backend": ("cli/src/lib/productHealthContract.ts", "cli/src/lib/productUsageContract.ts",
                "daemons/frames.json",
                "desktop/lib/measurement/", "mobile/lib/measurement/",
                "provider/reference-provider/", "tests/fixtures/"),
    # cli/scripts/connector-assets.mjs, which a spec imports, names the connector icons' desktop and phone copies it writes.
    # store/: the dsh specs read its agents, viewers and starter (the scan skips it: a path outside every component).
    # focus_faces.c: roundGlyphs.spec.ts holds the daemon's copy of the dial's glyph table to the firmware's.
    "cli": ("backend/src/lib/deviceAck.vectors.json", "backend/src/lib/deviceAckCore.ts",
            "cli/e2e/harness/", "desktop/assets/connector-icons/",
            "desktop/lib/connectors/connector_icons.dart", "desktop/lib/measurement/product_health_contract.dart",
            "desktop/test/viewer/deviceAck.vectors.json", "desktop/test/viewer/deviceHistory.vectors.json",
            "devices/harness-device/firmware/main/ui/habitat/focus_faces.c",
            "devices/harness-device/firmware/test/vectors/", "docs/contracts/", "mobile/assets/connector-icons/",
            "mobile/lib/phone/connector_icons.dart", "mobile/test/viewer/deviceAck.vectors.json",
            "mobile/test/viewer/deviceHistory.vectors.json",
            "pty/", "store/", "tui/"),
    "companions": ("cli/", "docs/research/2026-09-30-memory-batch-extraction-cases.json",
                   "docs/research/2026-09-30-memory-extraction-cases.json"),
    # Its generators write (and its checks may compare) these outputs.
    "daemons": ("backend/src/lib/daemonRoster.g.ts", "companions/src/companion/plates/",
                "companions/src/companion/roster.g.ts", "desktop/assets/daemon-art/",
                "desktop/lib/daemons/illustrated_alignment.g.dart", "desktop/lib/daemons/plates.g.dart",
                "desktop/lib/daemons/roster.g.dart", "mobile/lib/daemons/plates.g.dart", "mobile/lib/daemons/roster.g.dart"),
    # test_touch_ui.py holds the dial's host names and busy fuse to the daemon's (cli/src/cable/hosts/hostDetect.ts,
    # cli/src/services/devices.ts REMIND_MS). The Pro's run.sh checks main/pod/app_icons.c against every file in
    # .github/assets/apps (gen_app_icons.py --check, test_app_icons.py); .github/ already reruns every suite on reuse.
    "firmware": (".github/assets/apps/", "cli/src/cable/hosts/hostDetect.ts", "cli/src/services/devices.ts",
                 "daemons/plates/tux.mjs", "daemons/review/traits.html", "daemons/tools/illustrated/daemon_art.py",
                 "daemons/tools/plate.mjs", "desktop/assets/model-icons/claude.png"),
    # Its tests run in a sparse checkout (ci.SOURCE_INPUTS["desktop"]) and read these from it. By hand: the phone's P2P and
    # E2EE files test/p2p/mobile_parity_test.dart compares (its paths are built), the phone's lockfile, store/ (its
    # agents, branding and hands-on list) and docs/images/ (the Store's example images store_discover_test.dart opens);
    # the scan skips a path outside every component. Its tools also import the web release scripts.
    "desktop": ("backend/src/lib/communityContract.ts", "backend/src/lib/hubMetricsContract.ts", "cli/src/engines/",
                "cli/src/lib/__fixtures__/github-repository-vectors.json", "cli/src/lib/e2ee/applicationFrames.ts",
                "cli/src/lib/e2ee/core.ts", "cli/src/lib/engineInstall.ts", "cli/src/lib/engineLaunch.ts",
                "cli/src/lib/relayFrames.ts", "cli/src/lib/shellProtocol.ts", "cli/src/lib/viewerFrames.ts",
                # The Windows pipe's shared proof vectors.
                "cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json", "cli/src/messages/wire.ts",
                "cli/src/sharing/protocol.ts", "daemons/frames.json", "docs/images/",
                "daemons/plates.json",
                "daemons/roster.json", "daemons/tools/illustrated/appearance.py", "daemons/tools/illustrated/daemon_art.py",
                "daemons/tools/illustrated/generate.py",
                # tauri_signature_test.dart holds Desktop's pinned update key to the Device app's.
                "device-app/src-tauri/tauri.conf.json", "mobile/lib/e2ee/relay_session_crypto.dart",
                "mobile/lib/p2p/terminal_p2p_link.dart", "mobile/lib/p2p/terminal_p2p_plugin.dart",
                "mobile/lib/p2p/terminal_p2p_policy.dart", "mobile/lib/ws/relay_codec.dart",
                "mobile/lib/ws/terminal_transport_plugin.dart", "mobile/pubspec.lock", "store/",
                "tests/fixtures/shared-pane-layouts.json",
                # device_app_launcher_test.dart holds the app-list entry Desktop writes to the vectors.
                "tests/fixtures/app-list-entry-vectors.json",
                "website/scripts/harness-web-assets.mjs", "website/scripts/precompress.mjs"),
    # test_release_workflow.py reads its own release workflow and Desktop's runners and signing inputs, through a path
    # built from parts, which the scan cannot see.
    # app_list.rs holds its Linux app-list entry to the vectors every writer of it reads.
    "device-app": (".github/workflows/release-desktop.yml", ".github/workflows/release-device.yml",
                   "tests/fixtures/app-list-entry-vectors.json"),
    # The desktop files the phone's tests read: the words and helpers its tests compare; a desktop-only change to one once
    # failed only in a batch, two batches later (River, 2026-11-03). test_ci_plan's
    # test_every_desktop_file_the_phone_tests_read_selects_mobile scans mobile/test and fails on one missing here.
    "mobile": ("backend/src/types/productHealthContract.ts", "backend/src/types/productUsage.ts", "cli/src/engines/",
               "cli/src/lib/e2ee/applicationFrames.ts", "cli/src/lib/e2ee/core.ts", "cli/src/lib/engineLaunch.ts",
               "cli/src/lib/productUsageSignals.ts", "cli/src/lib/relayFrames.ts", "cli/src/lib/shellProtocol.ts",
               "cli/src/lib/viewerFrames.ts", "cli/src/messages/wire.ts", "cli/src/sharing/protocol.ts",
               "daemons/banner.json", "daemons/frames.json", "daemons/plates.json", "daemons/roster.json",
               "desktop/lib/widgets/engine_identity.dart",
               "docs/performance/"),
    # pty-checks also runs the CLI's ptyhost contract, which imports CLI code.
    # os-checks reads the CLI's dial ids (cli/src/cable/serial.ts), its version and the TUI it packages;
    # term/ by hand: the update fixture copies `git ls-files -- tui term`, which the scan cannot see.
    "os": ("cli/package.json", "cli/src/cable/serial.ts", "devices/harness-device/firmware/README.md", "docs/naming-system.md",
           "docs/terminology.md", "term/", "tui/"),
    "pty": ("cli/", "desktop/windows/runner/resources/app_icon.ico"),
    # THIRD_PARTY_NOTICES.md: tui/src/main.rs includes ../THIRD_PARTY_NOTICES.md, which names a root file too.
    "tui": ("THIRD_PARTY_NOTICES.md", "cli/package.json", "os/network.py", "os/onboarding.py", "os/root/usr/bin/hn",
            "tests/fixtures/shared-pane-layouts.json"),
    # device-install.spec.ts holds the one-line installer's app-list entry to the vectors.
    # backend/src/lib/: its Hub contract specs import the backend's contract modules, named without an extension.
    "website": ("backend/src/lib/", "cli/packages/harness-mcp/", "cli/src/agentClient/commands.ts", "cli/src/lib/newCommand.ts",
                "cli/src/messages/command.ts", "desktop/lib/core/phone_app_links.dart",
                "desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_512.png",
                "tests/fixtures/app-list-entry-vectors.json"),
}
# Folders inside a suite's own component that its PR jobs never read: the CLI's typecheck and unit
# tests cover src/ (end to end runs elsewhere). backend/integration is read: backend-integration runs it.
# CrossReadTests fails when a file outside the folder refers into it.
NOT_READ = {"cli": ("cli/e2e/",)}
# Strings in a suite's files that name another directory's path but are not read by its PR jobs:
# test data, or a script run only by hand. {source: (why, {path the scan reports, or a folder "dir/" covering it})}.
# A folder covers the paths under it named from the repository root. A relative read ("../../cli/x.ts") is always a
# read, but one that also names a path inside its file's own directory, which the scan then fails closed on: there an
# entry naming exactly the outside path covers it (the setup action's `../backend`, also beside it in .github/actions/).
NOT_READS = {
    ".github/actions/cli-e2e-setup/action.yml": ("the real backend, set up only for a job that asks (linux-e2e, which "
                                                 "declares backend/); dial-hosts does not", {"backend/"}),
    # cli-tests runs vitest on src/ only; these start the real backend with its installed prisma.
    **{source: ("end-to-end and local stack scripts, run by hand", {"backend/"})
       for source in ("cli/e2e/harness/realBackend.ts", "cli/scripts/box-claim-e2e.ts", "cli/scripts/local-stack-peer.ts",
                      "cli/scripts/remote-viewers-stack.ts", "cli/scripts/share-harness-e2e.ts")},
    "cli/src/engines/__fixtures__/other-runtime.golden.json": ("test data: a model name", {"provider/"}),
    "cli/src/lib/connectors/call.spec.ts": ("test data: files in a temporary home", {"docs/"}),
    "cli/src/lib/sessionSearch/turns.spec.ts": ("test data: a tool call's file path", {"desktop/"}),
    "cli/src/lib/handoffChangedFiles.spec.ts": ("test data: changed file names", {"docs/"}),
    "cli/src/lib/opencodeOneShot.spec.ts": ("test data: a model name", {"provider/"}),
    "cli/src/lib/runtimeProfile.spec.ts": ("test data: a model name", {"provider/"}),
    "cli/src/lib/transcriptReader.spec.ts": ("test data: a tool result's text", {"devices/"}),
    "companions/src/application/modelProfile.spec.ts": ("test data: a model name", {"provider/"}),
    "companions/src/memory/lessons/signals.spec.ts": ("test data: a test id", {"tests/"}),
    "desktop/tool/native_benchmark/connected_stack.mjs": ("a benchmark run by hand against the built CLI", {"cli/"}),
    "desktop/tool/test_test_flavor_isolation.py": ("a macOS check run by hand with the CLI's installed packages", {"cli/"}),
    "devices/harness-device/firmware/test/device_release_check.py": ("a release check run by hand that fingerprints the "
                                                                     "CLI's sources", {"cli/"}),
    "desktop/test/p2p/mobile_parity_test.dart": ("reads ../mobile/<file> only for the phone files desktop-tests' sparse "
                                                  "checkout holds, each declared in ci.SOURCE_INPUTS", {"mobile/"}),
    "desktop/test/community_publish_test.dart": ("test data: a file in a temporary folder", {"docs/"}),
    "desktop/test/runtime_model_name_test.dart": ("test data: a model name", {"provider/"}),
    "mobile/lib/demo/sample_scripts.dart": ("demo transcript text", {"tests/"}),
    "mobile/test/runtime_model_name_test.dart": ("test data: a model name", {"provider/"}),
    "os/tests/build-update-fixture.py": ("the CLI bundle a hand-run build copies from its work folder", {"cli/"}),
    "tui/src/runtime_model.rs": ("test data: a model name", {"provider/"}),
    # tui-test runs cargo test only (tui/tests/ holds no Rust tests); these read build output and installed packages.
    "tui/tests/local-first.py": ("a script run by hand against the built CLI (cli/dist)", {"cli/"}),
    "tui/tests/viewer-live.mjs": ("a script run by hand with the backend's installed prisma", {"backend/"}),
    "website/src/app/download/page.spec.tsx": ("test data: text the page must not show", {"desktop/"}),
    "website/src/app/hub/publish/page.spec.tsx": ("test data: a file in an upload", {"docs/"}),
}
# Inputs every suite shares: a change here reruns everything, and a PR that changes them
# never reuses (PR CI runs the PR's own planner and workflow; the merge helper is in scripts/).
SHARED_PREFIXES = (".github/", "scripts/")
SHARED_FILES = {"Makefile", ".gitattributes", ".gitignore", ".gitmodules"}
LOCKS_AND_TOOLCHAINS = {
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lockb",
    "bun.lock", "Cargo.lock", "pubspec.lock", "go.sum", "go.mod", "go.work", "go.work.sum", "uv.lock", "poetry.lock",
    "Pipfile.lock", "Gemfile.lock", "Podfile.lock", "flake.lock", "gradle.lockfile", "composer.lock",
    ".nvmrc", ".node-version", ".tool-versions", ".python-version", ".ruby-version", ".go-version",
    "rust-toolchain", "rust-toolchain.toml", ".fvmrc", ".flutter-version", "global.json",
}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=120).decode().strip()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("CI requires a full immutable Git SHA")
    return value


def owners(path):
    """The suites whose own files include this path: its component's, and ALSO's and SUBCOMPONENTS' extras."""
    suite = COMPONENTS.get(path.split("/", 1)[0])
    scopes = {suite} if suite else set()
    scopes |= {also for prefix, also in ALSO.items() if path.startswith(prefix)}
    scopes |= {extra for prefix, extra in SUBCOMPONENTS.items() if path.startswith(prefix)}
    return scopes


def windows_docs(path):
    """Docs and images in windows-e2e's folders: nothing windows.yml builds or runs reads them, but the notices the TUI
    compiles in (tui/src/main.rs)."""
    return (path.endswith((".md", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"))
            and path != "tui/THIRD_PARTY_NOTICES.md")


def windows_only(path):
    """Code that runs on Windows alone, where windows-e2e's arm64 leg tests what its x64 leg does not."""
    return not windows_docs(path) and (
        # The host's crate, the terminal it builds on (term/, and the vendored one in tui/vendor/), the serial bridge.
        path.startswith(("pty/", "term/", "tui/vendor/", "serial/", "cli/src/lib/ptyHost", "cli/scripts/windows-ci/"))
        or PurePosixPath(path).name == "install.ps1"
        or path in {".github/workflows/windows.yml", "cli/vitest.e2e.windows.config.ts",
                    "cli/scripts/windows-install-manifest.mjs"}
        # A file's own name, not a folder's (cli/src/lib/windows/ runs x64 alone), in the code its specs and the dial's
        # end to end run: arm64 adds about 27 runner-minutes a run.
        or (path.startswith(("cli/src/", "cli/e2e/")) and re.search(r"[wW]indows", PurePosixPath(path).name) is not None))


def windows_e2e(path):
    """What windows-e2e tests: Windows-only code, cross-platform code with win32 branches that broke only on Windows
    (#4513: the devices, the cable, the engines' hook scripts, the dial plugins), the TUI and the flasher windows.yml
    runs, and its specs with the modules they test."""
    return windows_only(path) or not windows_docs(path) and (
        path.startswith(("cli/src/lib/windows/", "cli/src/devices/", "cli/src/cable/", "cli/hook/", "tui/",
                         "website/src/app/flash-circle.ps1/"))
        or re.match(r"plugins/harness-device[^/]*/", path) is not None
        or path in WINDOWS_SPEC_MODULES or any(covers(spec, path) for spec in WINDOWS_SPECS))


def listed(entry, path):
    """covers(), and a "*" in the entry's last name matching within that name."""
    folder, _, name = entry.rpartition("/")
    return covers(entry, path) or ("*" in name and str(PurePosixPath(path).parent) == folder
                                   and fnmatch.fnmatchcase(PurePosixPath(path).name, name))


def linux_e2e_file(path):
    """A CLI e2e file linux-e2e runs when a PR adds or modifies it."""
    return (path.startswith("cli/e2e/") and path.endswith(".e2e.ts") and path not in LINUX_E2E_NEVER
            and not dial_hosts_path(path))


def linux_e2e_canary_path(path):
    """What linux-e2e runs its canary for."""
    return any(listed(entry, path) for entry in LINUX_E2E_CANARY_PATHS)


def linux_e2e_orca_path(path):
    """What linux-e2e runs LINUX_E2E_ORCA_FILES for."""
    return path in LINUX_E2E_ORCA_PATHS


def dial_hosts_path(path):
    """What the dial-hosts job runs: its files (a "*" stays within e2e/, as Vitest's glob does), adapters and helpers."""
    return any(listed(entry, path) for entry in (*DIAL_HOST_FILES, *DIAL_HOST_PATHS))


def e2e_owners(path):
    """The end-to-end suites whose own paths include this path."""
    suites = {"windows-e2e"} if windows_e2e(path) else set()
    if linux_e2e_file(path) or linux_e2e_canary_path(path) or linux_e2e_orca_path(path):
        suites.add("linux-e2e")
    if dial_hosts_path(path):
        suites.add("dial-hosts")
    # No Device job reads the docs or runs the release scripts' Python tests (device-app-checks runs those).
    if not path.endswith(".md") and not listed("device-app/scripts/test_*.py", path):
        suites |= {suite for suite, entries in DEVICE_APP_PATHS.items() if any(listed(entry, path) for entry in entries)}
    return suites


def owns(suite, path):
    """Whether the path is one of the suite's own files. Only an end-to-end suite reads the path lists: the cross-read
    scan asks for every file, and they made a unit suite's scan half again as slow."""
    return suite in owners(path) or (suite in E2E and suite in e2e_owners(path))


def select(paths, present=None):
    """Each changed path runs its owners' suites, the end-to-end suites whose own paths include it, and every suite
    that declares reading it (PR_READS); a component's path runs the cross-read scan too. linux-e2e runs an e2e file
    only when the diff leaves it in the tree (present: the paths it adds or modifies; None, all of them), its canary
    for any change to what it runs for, and the Orca files for any change to what they cover."""
    selected, reasons = set(), {}
    for path in paths:
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("invalid changed path")
        own = owners(path)
        scopes = own | e2e_owners(path) | {
            suite for suite, entries in PR_READS.items() if any(covers(entry, path) for entry in entries)}
        if own - {"cross-read-scan"}:
            scopes.add("cross-read-scan")
        if present is not None and path not in present and not (linux_e2e_canary_path(path)
                                                                 or linux_e2e_orca_path(path)):
            scopes.discard("linux-e2e")
        selected |= scopes
        reasons[path] = sorted(scopes)
    return selected, reasons


CI_WORKFLOW = ".github/workflows/ci.yml"


def yaml_entries(text):
    """A YAML mapping's keys at its first key's indent, each with the rest of its line and the lines indented below it;
    comment lines left out."""
    text = re.sub(r"(?m)^[ \t]*#.*\n", "", text)
    first = re.search(r"(?m)^([ \t]*)[\w-]", text)
    if first is None:
        return {}
    indent = first.group(1)
    return dict(re.findall(rf"(?m)^{indent}([\w-]+):(.*\n(?:(?:{indent}[ \t]+.*)?\n)*)", text))


def ci_jobs(text):
    """ci.yml's jobs: each id under `jobs:` and its definition."""
    return yaml_entries(yaml_entries(text).get("jobs", ""))


# A YAML anchor (`key: &name`, `- &name`) and an alias of one (`key: *name`, `<<: *name`, `- *name`).
YAML_ANCHOR = re.compile(r"(?m)(?:^[ \t]*-|:)[ \t]+&([\w-]+)")
YAML_ALIAS = re.compile(r"(?m)(?:^[ \t]*-|:)[ \t]+\*([\w-]+)")


def edited_job_suites(root, base, head):
    """The suites whose ci.yml jobs head edits, adds or removes: a job's definition is part of what its suite tests, with
    what it takes from the rest of the file (the env variables it names, the permissions, defaults and concurrency, the
    anchors it names). device-app-build's are the Device suites that install its packages; the plan, process and gate
    jobs run none."""
    def top(commit):
        try:
            return yaml_entries(git(root, "show", f"{commit}:{CI_WORKFLOW}") + "\n")
        except subprocess.CalledProcessError:
            return {}  # No ci.yml there: every job of the other side changed.

    old_top, new_top = top(base), top(head)
    old, new = yaml_entries(old_top.get("jobs", "")), yaml_entries(new_top.get("jobs", ""))
    jobs = old.keys() | new.keys()
    edited = {job for job in jobs if old.get(job) != new.get(job)}
    if any(old_top.get(key) != new_top.get(key) for key in ("permissions", "defaults", "concurrency")):
        edited |= jobs
    old_env, new_env = yaml_entries(old_top.get("env", "")), yaml_entries(new_top.get("env", ""))
    variables = [re.escape(name) for name in old_env.keys() | new_env.keys() if old_env.get(name) != new_env.get(name)]
    named = re.compile(rf"\b(?:{'|'.join(variables)})\b") if variables else None
    edited |= {job for job in jobs if named and named.search(old.get(job, "") + new.get(job, ""))}
    # An edited anchor reaches each job that names it, and through it what that job anchors.
    sections = {key for key in old_top.keys() | new_top.keys() if key != "jobs" and old_top.get(key) != new_top.get(key)}
    while True:
        changed = "".join(old_top.get(key, "") + new_top.get(key, "") for key in sections)
        changed += "".join(old.get(job, "") + new.get(job, "") for job in edited)
        anchors = set(YAML_ANCHOR.findall(changed))
        reached = {job for job in jobs - edited if anchors & set(YAML_ALIAS.findall(old.get(job, "") + new.get(job, "")))}
        if not reached:
            break
        edited |= reached
    return ({suite for suite, names in JOBS.items() if names & edited}
            | (set(DEVICE_APP_BUILDS) if "device-app-build" in edited else set()))


def covers(entry, path):
    return path == entry or (entry.endswith("/") and path.startswith(entry))


def inert(path):
    """Paths no suite reads: the docs (except the posters desktop shows) and top-level notes."""
    return ((path.startswith("docs/") and not path.startswith("docs/images/"))
            or ("/" not in path and path.endswith(".md")))


def shared_input(path):
    """Why a changed path invalidates every suite, or None."""
    if path.startswith(SHARED_PREFIXES) or path in SHARED_FILES:
        return "workflow, CI script, merge tool or repository setting"
    if PurePosixPath(path).name in LOCKS_AND_TOOLCHAINS:
        return "lockfile or toolchain pin"
    if not owners(path) and not inert(path):
        return "outside every component"
    return None


def reads(suite, path, inputs=None):
    """Whether the suite reads this path: its own files, or its inputs (DEPENDS for reuse; PR_READS for selection)."""
    own = owns(suite, path) and not any(covers(skip, path) for skip in NOT_READ.get(suite, ()))
    return own or any(covers(entry, path) for entry in (DEPENDS if inputs is None else inputs).get(suite, ()))


def changed_paths(root, old, new, present_only=False):
    """The paths new changes from old; present_only, those it adds or modifies (a rename is a deletion and an addition)."""
    present = ["--diff-filter=d"] if present_only else []
    changed = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", *present, old, new], cwd=root,
                                      timeout=120)
    return sorted(p.decode() for p in changed.split(b"\0") if p)


def is_ancestor(root, old, new):
    return subprocess.run(["git", "merge-base", "--is-ancestor", old, new], cwd=root, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=120).returncode == 0


def update_parents(root, head, base):
    """The passed head and main commit that GitHub's Update branch merged, or ValueError."""
    parents = git(root, "rev-list", "--parents", "-n", "1", head).split()[1:]
    if len(parents) != 2:
        raise Rerun("head is not a merge of main into an earlier head")
    passed, main = (sha(value) for value in parents)
    if not is_ancestor(root, main, base):
        raise Rerun("the merged main commit is not on the base branch")
    return passed, main


def own_shared_change(root, head, base):
    """A shared input this PR itself changes (its own CI runs its own planner), or None."""
    own = changed_paths(root, git(root, "merge-base", base, head), head)
    return next((path for path in own if path.startswith(SHARED_PREFIXES) or path in SHARED_FILES), None)


# A changed path the job summary's Markdown may name.
PLAIN_PATH = re.compile(r"[A-Za-z0-9_./-]+")


def shown(path):
    """A changed path as a reason names it: the job summary writes reasons into its Markdown, and git allows backticks
    and newlines in a path."""
    return path if PLAIN_PATH.fullmatch(path) else "a path of other characters"


def reuse_blocker(root, suite, origin, head):
    """(scope, reason) when the result tested at origin cannot stand for head; scope "all" or "suite"."""
    if not is_ancestor(root, origin, head):
        return "suite", f"its recorded run tested {origin[:12]}, which is not an ancestor of this head"
    paths = changed_paths(root, origin, head)
    for path in paths:
        reason = shared_input(path)
        if reason:
            return "all", f"main changed {shown(path)} ({reason})"
    touched = [path for path in paths if reads(suite, path)]
    if touched:
        more = f" and {len(touched) - 1} more" if len(touched) > 1 else ""
        return "suite", f"main changed its input {shown(touched[0])}{more}"
    return None, "; ".join(map(shown, paths[:3])) + (f" and {len(paths) - 3} more" if len(paths) > 3 else "")


REUSE_LOOKUP_SECONDS = 60


class Rerun(ValueError):
    """A deliberate refusal to reuse: its message is the receipt's reason."""


REUSE_ERRORS = (OSError, RuntimeError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError,
                zipfile.BadZipFile, json.JSONDecodeError)


BATCH_MEMBERS_MAX = 40


def batch_members(root, head, base):
    """The tested heads a batch branch merged, in merge order: read from its own merges, never from the PR's text.

    Every commit on the head's first-parent line down to the base branch is a two-parent merge; its second parent is a
    member PR's tested head, or a main commit merged again, which brings only main's commits."""
    members, commit = [], head
    for _ in range(BATCH_MEMBERS_MAX + 1):
        if is_ancestor(root, commit, base):
            break
        parents = git(root, "rev-list", "--parents", "-n", "1", commit).split()[1:]
        if len(parents) != 2:
            raise Rerun(f"{commit[:12]} on its first-parent line is not a merge and not on the base branch")
        first, second = (sha(value) for value in parents)
        if not is_ancestor(root, second, base) and second not in members:
            members.append(second)
        commit = first
    else:
        raise Rerun(f"its first-parent line has more than {BATCH_MEMBERS_MAX} merges before the base branch")
    if not members:
        raise Rerun("it merges no member PR")
    return members[::-1]


def reuse_sources(root, head, base):
    """The commits whose passed runs may stand for this head's components, and how they were found: the passed head of
    GitHub's Update branch (its second parent is a main commit), or the member heads a batch branch merged."""
    parents = git(root, "rev-list", "--parents", "-n", "1", head).split()[1:]
    if len(parents) == 2 and is_ancestor(root, sha(parents[1]), base):
        passed, main = update_parents(root, head, base)
        return [passed], dict(kind="update", passed_head=passed, main_parent=main)
    members = batch_members(root, head, base)
    return members, dict(kind="batch", members=members)


def passed_receipt(evidence, commit):
    """The exact passed ci/required run of a tested commit, or ValueError."""
    gate = evidence.passed_gate(commit)
    receipt = gate["receipt"]
    if receipt["source_sha"] != commit or receipt["status"] != "passed":
        raise ValueError("the passed head's ci/required receipt names another source")
    return gate


def run_origin(evidence, commit, gate, suite):
    """Where a passed run's result for this suite was proved: the run itself, or the run it reused (an earlier one)."""
    receipt = gate["receipt"]
    earlier = receipt.get("reused") or {}
    if suite in earlier:
        record = earlier[suite]
        origin, run_id, attempt = sha(record["origin_sha"]), record["run_id"], record["run_attempt"]
        found = evidence.ran(origin, run_id, attempt, suite)
        return origin, run_id, attempt, found["tree"], found["url"]
    return commit, gate["run_id"], gate["run_attempt"], receipt["source_tree"], gate["url"]


def plan_reuse(root, head, base, suites, evidence):
    """Reuse what an exact passed ci/required run proved, for suites nothing else in this head changed the inputs of.

    After Update branch the run is the passed head's; in a batch PR, a member PR's (task #2720). Fails closed: any doubt
    or unreadable evidence leaves the suite, or every suite, to run as before."""
    reuse = dict(status="none", reason=None, passed_head=None, main_parent=None, rerun={})
    reused = {}
    try:
        if evidence is None:
            raise Rerun("no CI evidence reader")
        origins, source = reuse_sources(root, head, base)
        reuse.update(source)
        changed = own_shared_change(root, head, base)
        if changed:
            raise Rerun(f"this PR changes {shown(changed)}, which its own CI run reads")
        probed = {}
        if source["kind"] == "update":
            try:
                probed[origins[0]] = passed_receipt(evidence, origins[0])
            except REUSE_ERRORS:
                # A batch PR that merged main again: its earlier head never ran alone, but its members did.
                try:
                    origins = batch_members(root, head, base)
                    reuse.update(kind="batch", members=origins, passed_head=None, main_parent=None)
                except Rerun:
                    pass
        batch = reuse["kind"] == "batch"
        gates, unread = [], {}
        for commit in origins:
            if not batch:
                # An update has one source: doubt reruns all.
                gates.append((commit, probed[commit] if commit in probed else passed_receipt(evidence, commit)))
                continue
            try:
                gates.append((commit, passed_receipt(evidence, commit)))
            except REUSE_ERRORS as error:
                # Its changes stay in every other member's diff to the head: it is only no candidate.
                unread[commit] = str(error) or type(error).__name__
        if batch and not gates:
            raise Rerun("no member's passed run could be verified: " + "; ".join(f"{c[:12]}: {e}" for c, e in unread.items()))
        for suite in sorted(suites):
            reasons = []
            for commit, gate in gates:
                if suite not in gate["receipt"]["suites"]:
                    reasons.append(f"member {commit[:12]}'s run did not run it" if batch else "the passed head's run did not run it")
                    continue
                if batch:
                    try:
                        origin, run_id, attempt, tree, url = run_origin(evidence, commit, gate, suite)
                    except REUSE_ERRORS as error:
                        reasons.append(f"member {commit[:12]}'s earlier run could not be verified: {str(error) or type(error).__name__}")
                        continue
                else:
                    origin, run_id, attempt, tree, url = run_origin(evidence, commit, gate, suite)
                scope, reason = reuse_blocker(root, suite, origin, head)
                if scope == "all":
                    raise Rerun(reason)
                if scope == "suite":
                    reasons.append(reason)
                    continue
                why = (f"passed in run {run_id} on {origin[:12]}, merged here as member {commit[:12]}; nothing else in the "
                       f"batch or on main changes its inputs ({reason})" if batch else
                       f"passed in run {run_id} on {origin[:12]}; main's new commits change none of its inputs ({reason})")
                reused[suite] = dict(origin_sha=origin, origin_tree=sha(tree), run_id=run_id, run_attempt=attempt, run_url=url,
                                     reason=why)
                break
            else:
                reasons += [f"member {c[:12]}'s passed run could not be read: {e}" for c, e in unread.items()]
                reuse["rerun"][suite] = "; ".join(reasons)
    except Rerun as refusal:
        return {}, dict(reuse, rerun={}, reason=str(refusal))
    except REUSE_ERRORS as error:
        return {}, dict(reuse, rerun={}, reason=f"earlier evidence could not be verified: {str(error) or type(error).__name__}")
    whence = "the batch's member runs" if reuse.get("kind") == "batch" else "the passed head's run"
    reuse.update(status="applied" if reused else "none", reason=f"reused {len(reused)} of {len(suites)} suites from {whence}")
    return reused, reuse


# Literal relative paths into another top-level directory ("../backend/x.ts", "../../tests/fixtures/").
SOURCE_FILE = re.compile(r"\.(ts|tsx|mts|cts|js|mjs|cjs|dart|rs|py|sh|go|c|h|cc|cpp|kt|swift|toml|yaml|yml|json|gradle|cmake)$"
                         r"|(^|/)(Makefile|CMakeLists\.txt|Dockerfile)$")
RELATIVE_READ = re.compile(r"(?<![\w/.-])((?:\.\./)+)([A-Za-z0-9_.-]+(?:/[^'\"`\s$(){}<>,;]*)?)")
# A quoted path from the repository root ("ROOT / 'cli/src/cable/serial.ts'", "join(repo, 'backend/src/')").
QUOTED_PATH = re.compile(r"""(?<![\w/.-])['"](?!\.\.?/)([A-Za-z0-9_.-]+/[^'"`\s$(){}<>,;*]*)""")
COMMENT_LINE = ("//", "#", "*", "/*", "<!--")


def undeclared_reads(root, suite, known_paths=(), inputs=None):
    """Files of this suite that name another directory's path without an entry in inputs (DEPENDS): [(source, target)].

    Run on a full checkout (the merge helper's, before accepting reuse; or locally). A read the scan
    cannot see (a path built from parts) belongs in DEPENDS by hand. known_paths count as existing:
    the helper passes every path main changed, deletions included, so a read of a deleted file stays a read."""
    listed = subprocess.check_output(["git", "ls-files", "-z"], cwd=root, timeout=60).decode().split("\0")
    sources = {path for path in listed if path}
    tracked = sources | set(known_paths)
    folders = {str(PurePosixPath(path).parent) for path in tracked}
    folders |= {str(parent) for folder in list(folders) for parent in PurePosixPath(folder).parents}
    tops = {path.split("/", 1)[0] for path in tracked if "/" in path}
    found = []
    for source in sorted(sources):
        if not SOURCE_FILE.search(source) or "/evidence/" in source or not owns(suite, source):
            continue
        try:
            text = (Path(root) / source).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            if not os.path.lexists(Path(root) / source):
                # A sparse checkout lists files it does not hold: skipping them would report no read.
                raise ValueError(f"the cross-read scan needs a full checkout; {source} is not in it") from None
            continue
        top = source.split("/", 1)[0]
        if not reads(suite, source, inputs):
            continue  # In a folder this suite skips; what it refers to is read only if a read file says so.

        def existing(target):
            """The tracked file or folder ("dir/") a path names, trimmed to what exists; or None."""
            known = target
            while known not in tracked and known not in folders and "/" in known:
                known = known.rsplit("/", 1)[0]
            if known not in tracked and known not in folders:
                return None
            return known + "/" if known in folders else known

        data = NOT_READS.get(source, ("", set()))[1]
        code = "\n".join("" if line.lstrip().startswith(COMMENT_LINE) else line for line in text.splitlines())
        for match in RELATIVE_READ.finditer(code):
            relative = match.group(1) + match.group(2)
            targets = []
            for start in (str(PurePosixPath(source).parent), top):  # beside the file, or from its package root
                resolved = os.path.normpath(os.path.join(start, relative)).replace(os.sep, "/")
                if not resolved.startswith("../") and resolved not in {".", ".."}:
                    targets.append(resolved)
            # Inside its own directory (an existing file or folder there): an internal path, unless it
            # reaches into a folder this suite's jobs skip.
            inside = [t for t in targets if t.split("/", 1)[0] == top
                      and (t in tracked or t in folders or str(PurePosixPath(t).parent) in folders)]
            if inside:
                known = existing(inside[0])
                if known and not reads(suite, known + "x" if known.endswith("/") else known, inputs):
                    found.append((source, known))
                # Fail closed when the other reading names a real path too: a look-alike file inside the
                # component (which the PR controls) must not hide a read of another directory.
                for target in targets:
                    if target.split("/", 1)[0] != top and (target in tracked or target in folders):
                        known = target + "/" if target in folders else target
                        probe = known + "x" if known.endswith("/") else known
                        if known not in data and not shared_input(probe) and not reads(suite, probe, inputs):
                            found.append((source, known))
                continue
            for target in targets:
                if target.split("/", 1)[0] == top:
                    continue
                known = existing(target)
                if known is None:
                    continue  # Names nothing in this repository (a URL path, a generated file).
                # A folder read (a path built at run time) needs the whole folder declared.
                probe = known + "x" if known.endswith("/") else known
                if not shared_input(probe) and not reads(suite, probe, inputs):
                    found.append((source, known))
                break

        # Paths named from the repository root, on lines that are not comments.
        for match in QUOTED_PATH.finditer(code):
            target = os.path.normpath(match.group(1)).replace(os.sep, "/")
            if target.split("/", 1)[0] not in tops or target.split("/", 1)[0] == top:
                continue
            # The same path inside its own directory or beside the file ("OS / 'tests/x.py'") is internal,
            # but only when the repository root has no such path: an ambiguous path counts as a read.
            if target not in tracked and target not in folders and any(
                    f"{start}/{target}" in tracked or f"{start}/{target}" in folders
                    for start in (top, str(PurePosixPath(source).parent))):
                continue
            known = existing(target)
            if known is None or any(covers(entry, known) for entry in data):
                continue
            probe = known + "x" if known.endswith("/") else known
            if not shared_input(probe) and not reads(suite, probe, inputs):
                found.append((source, known))
    return sorted(set(found))


def verify_reuse(root, receipt, base, evidence):
    """Re-derive a receipt's reused results from Git and the exact runs they name, or raise ValueError.

    The merge helper runs this from main's copy of the planner: PR CI ran the PR's own copy."""
    head = sha(receipt.get("source_sha"))
    if git(root, "rev-parse", "HEAD") != head or git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("reused results are verified only in a clean checkout of the reviewed head")
    reused = check_reused_records(receipt.get("reused"), receipt.get("suites") or [], head, receipt.get("event"))
    if not reused:
        return {}
    reuse = receipt.get("reuse")
    if not isinstance(reuse, dict):
        raise ValueError("reused results name no update merge or batch")
    try:
        if reuse.get("kind") == "batch":
            if reuse.get("members") != batch_members(root, head, base):
                raise ValueError("reused results name other members than the batch head's merges")
        elif (reuse.get("passed_head"), reuse.get("main_parent")) != update_parents(root, head, base):
            raise ValueError("reused results name other parents than the head's update merge")
    except Rerun as refusal:
        raise ValueError(f"reused results refused: {refusal}") from None
    changed = own_shared_change(root, head, base)
    if changed:
        raise ValueError(f"reused results refused: this PR changes {changed}, which its own CI run reads")
    for suite, record in sorted(reused.items()):
        found = evidence.ran(record["origin_sha"], record["run_id"], record["run_attempt"], suite)
        if found["tree"] != record["origin_tree"]:
            raise ValueError(f"reused {suite} names another tree than its run tested")
        if found["url"] != record["run_url"]:
            raise ValueError(f"reused {suite} names another link than its run")
        scope, reason = reuse_blocker(root, suite, record["origin_sha"], head)
        if scope:
            raise ValueError(f"reused {suite} refused: {reason}")
        # The planner ran in a sparse checkout; this full one shows reads DEPENDS is missing.
        changed = changed_paths(root, record["origin_sha"], head)
        for source, target in undeclared_reads(root, suite, changed):
            hit = next((path for path in changed if covers(target, path)), None)
            if hit:
                raise ValueError(f"reused {suite} refused: {source} reads {target}, which main changed ({hit}), "
                                 "and DEPENDS in scripts/ci-plan.py does not declare it; push a commit to run it again")
    return reused


def main_planner(root, base):
    """main's copy of this planner, loaded from the reviewed base commit rather than the PR checkout."""
    import tempfile
    try:
        with tempfile.TemporaryDirectory(prefix="main-ci-plan-") as folder:
            names = ["ci-plan.py", "record-ci-validation.py"]
            # Older reviewed bases predate the local-receipt module.
            if git(root, "ls-tree", sha(base), "--", "scripts/local-checks.py"):
                names.append("local-checks.py")
            for name in names:
                data = subprocess.check_output(["git", "show", f"{sha(base)}:scripts/{name}"], cwd=root,
                                               stderr=subprocess.PIPE, timeout=15)
                (Path(folder) / name).write_bytes(data)
            spec = importlib.util.spec_from_file_location("main_ci_plan", Path(folder) / "ci-plan.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        if not callable(getattr(module, "verify_reuse", None)) or not callable(getattr(module, "GitHubEvidence", None)):
            raise ValueError("no verify_reuse")
    except Exception as error:  # Any failure to load main's verifier refuses reuse; nothing else depends on it.
        raise ValueError(f"main's planner cannot verify reused results ({type(error).__name__})") from None
    return module


def read_gate(client, run):
    """The verified ci/required receipt of one passed automatic CI run: (receipt, artifact, archive)."""
    ci.check_run(run, client.repository, run["id"])
    if run.get("event") not in {"pull_request", "merge_group"}:
        raise ValueError("only automatic PR or merge-group CI can authorize queued integration")
    jobs = client.pages(f"actions/runs/{run['id']}/jobs?filter=latest", "jobs")
    gates = [j for j in jobs if j["name"] == "ci/required"]
    if (len(gates) != 1 or gates[0].get("head_sha") != run["head_sha"]
            or gates[0].get("status") != "completed" or gates[0].get("conclusion") != "success"):
        raise ValueError("automatic required CI gate did not pass")
    artifacts = client.pages(f"actions/runs/{run['id']}/artifacts", "artifacts")
    matches = [a for a in artifacts if a.get("name") == "ci-required"]
    if len(matches) != 1 or matches[0].get("size_in_bytes", 65537) > 65536:
        raise ValueError("expected one bounded required-gate receipt")
    artifact = matches[0]
    archive = client.command("api", f"repos/{client.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
    receipt = ci.summary_contents(artifact, archive, run, "ci-required")
    commit = client.api(f"git/commits/{run['head_sha']}")
    if (commit.get("sha") != run["head_sha"] or receipt.get("schema") != 1
            or receipt.get("kind") != "ci-required" or receipt.get("status") != "passed"
            or receipt.get("source_sha") != run["head_sha"] or receipt.get("event") != run["event"]
            or receipt.get("source_tree") != commit.get("tree", {}).get("sha")
            or receipt.get("run_id") != run["id"] or receipt.get("run_attempt") != gates[0].get("run_attempt")
            or not receipt.get("required_jobs")
            or any(receipt.get("results", {}).get(job) != "success" for job in receipt["required_jobs"])
            or receipt.get("results", {}).get("plan") != "success"):
        raise ValueError("required-gate receipt has inconsistent source, coverage or run identity")
    suites = receipt.get("suites")
    if not isinstance(suites, list) or not set(suites) <= SUITES:
        raise ValueError("required-gate receipt has invalid suites")
    reused = check_reused_records(receipt.get("reused", {}), suites, receipt["source_sha"], receipt["event"])
    # Every job this planner requires must have run and passed (checked above for each listed job). A receipt may list more:
    # the merge helper runs from main, so a PR that adds a CI job brings jobs main does not know yet (#2804, batch #2815).
    # Only adding works: a PR that removes or renames a job main requires still fails here until main has the change.
    required = receipt["required_jobs"]
    if (required != sorted(set(required))
            or not {"process-checks"} | set().union(*(JOBS[name] for name in set(suites) - set(reused))) <= set(required)):
        raise ValueError("required-gate receipt does not run every suite it did not reuse")
    after = client.api(f"actions/runs/{run['id']}")
    ci.check_run(after, client.repository, run["id"])
    if any(after[key] != run[key] for key in ["head_sha", "run_attempt", "updated_at"]):
        raise ValueError("CI changed during queue evidence collection")
    return receipt, artifact, archive


class GitHubEvidence:
    """Passed ci/required runs read from GitHub; every lookup is pinned to an exact run and attempt."""

    def __init__(self, client):
        self.client = client
        # (commit, run, attempt) -> (run, receipt): a run stands for several suites, each looked up inside one budget.
        self.gates = {}

    def gate(self, sha_value, run_id, attempt):
        """A pull request run of the commit and its verified ci/required receipt, read once."""
        key = (sha_value, run_id, attempt)
        if key not in self.gates:
            run = self.pr_run(sha_value, run_id, attempt)
            self.gates[key] = (run, read_gate(self.client, run)[0])
        return self.gates[key]

    def pr_run(self, sha_value, run_id, attempt):
        run = self.client.api(f"actions/runs/{run_id}")
        ci.check_run(run, self.client.repository, run_id)
        if run.get("event") != "pull_request" or run.get("head_sha") != sha_value:
            raise ValueError("the recorded run belongs to another source or event")
        if run.get("run_attempt") != attempt:
            raise ValueError("the recorded run attempt is no longer its latest attempt")
        return run

    def passed_gate(self, sha_value):
        """The run behind the commit's latest ci/required check, which must be a pass."""
        checks = self.client.pages(f"commits/{sha(sha_value)}/check-runs?check_name=ci%2Frequired&filter=latest", "check_runs")
        checks = [c for c in checks if c.get("name") == "ci/required" and c.get("head_sha") == sha_value
                  and c.get("app", {}).get("slug") == "github-actions" and positive(c.get("id"))]
        if not checks:
            raise ValueError("the passed head has no ci/required check")
        latest = max(checks, key=lambda c: c["id"])
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            raise ValueError("the passed head's latest ci/required is not a pass")
        job = self.client.api(f"actions/jobs/{latest['id']}")
        if (job.get("id") != latest["id"] or job.get("name") != "ci/required" or job.get("head_sha") != sha_value
                or job.get("conclusion") != "success" or not positive(job.get("run_id")) or not positive(job.get("run_attempt"))):
            raise ValueError("the ci/required check does not match its job")
        run, receipt = self.gate(sha_value, job["run_id"], job["run_attempt"])
        return dict(run_id=run["id"], run_attempt=run["run_attempt"], url=run["html_url"], receipt=receipt)

    def ran(self, sha_value, run_id, attempt, suite):
        """The tested tree and link of a run that itself ran and passed this suite."""
        run, receipt = self.gate(sha_value, run_id, attempt)
        if suite not in receipt["suites"] or suite in receipt.get("reused", {}):
            raise ValueError("the recorded run did not run this suite")
        return dict(tree=receipt["source_tree"], url=run["html_url"])


def make_plan(root, event_name, event, scope="full", source=None, evidence=None, e2e_files=""):
    head = sha(source or git(root, "rev-parse", "HEAD"))
    if git(root, "rev-parse", "HEAD") != head:
        raise ValueError("checkout differs from the requested source")
    base = None
    draft = False
    paths, reasons, present = [], {}, None
    if event_name == "pull_request":
        pr = event["pull_request"]
        draft = pr.get("draft", False)
        if not isinstance(draft, bool):
            raise ValueError("invalid PR draft state")
        if sha(pr["head"]["sha"]) != head:
            raise ValueError("PR head differs from the checkout")
        # Use Git, not the event's truncated paths or GitHub's limited file API.
        base = sha(git(root, "merge-base", sha(pr["base"]["sha"]), head))
    elif event_name == "merge_group":
        group = event["merge_group"]
        if event.get("action") != "checks_requested" or sha(group["head_sha"]) != head:
            raise ValueError("merge group differs from the checkout")
        base = sha(group["base_sha"])
        git(root, "merge-base", "--is-ancestor", base, head)
    elif event_name not in {"workflow_dispatch", "workflow_call"}:
        raise ValueError("unsupported CI event")
    if base:
        # Treat renames as deletion + addition so both input boundaries apply.
        paths = changed_paths(root, base, head)
        present = set(changed_paths(root, base, head, present_only=True))
        suites, reasons = select(paths, present)
        if CI_WORKFLOW in paths:
            edited = edited_job_suites(root, base, head)
            suites |= edited
            reasons[CI_WORKFLOW] = sorted(set(reasons[CI_WORKFLOW]) | edited)
        if event_name == "merge_group":
            suites = set()  # The PR run tested these changes; releases test the rest.
    else:
        if scope not in MANUAL:
            raise ValueError("invalid manual CI scope")
        suites = MANUAL[scope]
    # A run by hand names linux-e2e's files; a pull request's come from its diff.
    files = e2e_files.split()
    if not base and scope == "linux-e2e" and not files:
        raise ValueError("scope linux-e2e runs the cli/e2e files e2e_files names, and it names none")
    if files and (base or scope != "linux-e2e"):
        raise ValueError("e2e_files is only for a run by hand with scope linux-e2e")
    for path in files:
        # -r: a folder named like a file lists what is inside it.
        if not linux_e2e_file(path) or git(root, "ls-tree", "-r", "--name-only", head, "--", path) != path:
            raise ValueError(f"e2e_files: {path!r} is not a cli/e2e file at {head[:12]} that linux-e2e runs")
    reused, reuse = {}, dict(status="none", reason="only a ready PR's update merge can reuse", rerun={})
    if event_name == "pull_request" and not draft and suites:
        reused, reuse = plan_reuse(root, head, base_sha(event), suites, evidence)
    running = suites - set(reused)
    required = {"process-checks"} | set().union(*(JOBS[name] for name in running))
    return dict(schema=1, kind="ci-plan", event=event_name, head=head, base=base, draft=draft,
                tree=git(root, "rev-parse", "HEAD^{tree}"), paths=paths, reasons=reasons,
                suites=sorted(suites), required_jobs=sorted(required), reused=reused, reuse=reuse,
                e2e=e2e_plan(paths, running, root, head, present, files or None),
                local_checks=local_checks.required_checks(paths) if event_name == "pull_request" else [],
                manual_acceptance="Review still selects relevant native, real-engine, hardware and visual acceptance.")


def e2e_plan(paths, running, root=None, head=None, present=None, files=None):
    """What the running end-to-end suites' jobs read besides their flags: whether windows-e2e adds arm64 (for a
    Windows-only path, or a run by hand, which names none), the Device packages to build, and linux-e2e's files
    (cli/-relative; a run by hand's files, else the present paths', the Orca files for what they cover, and the canary
    for what it runs for or when its job's definition changed alone) and rows, or the full suite above
    LINUX_E2E_FILES_MAX files."""
    arm64 = "windows-e2e" in running and (not paths or any(windows_only(path) for path in paths))
    builds = [dict(bundle=bundle, arch=arch) for bundle, arch in DEVICE_APP_PACKAGES
              if any((bundle, arch) in DEVICE_APP_BUILDS.get(suite, ()) for suite in running)]
    linux = dict(linux_files=[], linux_shards=0, linux_full=False)
    if "linux-e2e" in running:
        if files is None:
            files = [path for path in paths if (present is None or path in present) and linux_e2e_file(path)]
            if any(linux_e2e_orca_path(path) for path in paths):
                at_head = git(root, "ls-tree", "-r", "--name-only", head, "--", *LINUX_E2E_ORCA_FILES).splitlines()
                missing = [path for path in LINUX_E2E_ORCA_FILES if path not in at_head]
                if missing:
                    raise ValueError(f"linux-e2e: {', '.join(missing)} not at {head[:12]}; update "
                                     "LINUX_E2E_ORCA_FILES in scripts/ci-plan.py")
                files += LINUX_E2E_ORCA_FILES
            if not files or any(linux_e2e_canary_path(path) for path in paths):
                if git(root, "ls-tree", "-r", "--name-only", head, "--", LINUX_E2E_CANARY) != LINUX_E2E_CANARY:
                    raise ValueError(f"linux-e2e: its canary {LINUX_E2E_CANARY} is not at {head[:12]}; name another "
                                     "real-backend e2e file as LINUX_E2E_CANARY in scripts/ci-plan.py")
                files.append(LINUX_E2E_CANARY)
        for path in files:
            if not E2E_FILE.fullmatch(path):
                raise ValueError(f"linux-e2e: {path!r} is not a plain file name; name e2e files with letters, digits, "
                                 "'_', '-' and '.'")
        files = sorted({path.removeprefix("cli/") for path in files})
        if len(files) > LINUX_E2E_FILES_MAX:
            linux.update(linux_shards=LINUX_E2E_FULL_SHARDS, linux_full=True)
        else:
            linux.update(linux_files=files, linux_shards=linux_e2e_shards(root, head, files))
    return dict(windows_arm64=arm64, device_app_builds=builds, **linux)


def linux_e2e_shards(root, head, files):
    """One runner per LINUX_E2E_RUNNER_MS of the files' hinted time (the head's cli/ci-e2e-durations.json, as the nightly
    shards are split), at least one, and at most one per file and LINUX_E2E_RUNNERS."""
    try:
        hints = json.loads(git(root, "show", f"{head}:cli/ci-e2e-durations.json"))
        total = sum(float(hints["durationMs"].get(file, hints["defaultDurationMs"])) for file in files)
        runners = math.ceil(total / LINUX_E2E_RUNNER_MS)
    except (subprocess.CalledProcessError, ValueError, KeyError, TypeError, AttributeError, OverflowError) as error:
        raise ValueError(f"linux-e2e: cli/ci-e2e-durations.json at {head} gives no timing hints "
                         f"({type(error).__name__})") from None
    return min(LINUX_E2E_RUNNERS, len(files), max(1, runners))


def outputs(record):
    """The plan job's outputs (ci.yml): the plan, whether it is ready, each suite's flag, and the end-to-end inputs."""
    values = dict(plan=json.dumps(record, separators=(",", ":")), ready="false" if record["draft"] else "true")
    # A reused suite's jobs skip; ci/required accepts that skip only for it.
    for suite in sorted(SUITES):
        values[suite] = "true" if suite in record["suites"] and suite not in record["reused"] else "false"
    e2e = record["e2e"]
    values["windows-e2e-arm64"] = "true" if e2e["windows_arm64"] else "false"
    values["device-app-builds"] = json.dumps(e2e["device_app_builds"], separators=(",", ":"))
    values["linux-e2e-files"] = " ".join(e2e["linux_files"])
    values["linux-e2e-shards"] = json.dumps(list(range(1, e2e["linux_shards"] + 1)), separators=(",", ":"))
    values["linux-e2e-full"] = "true" if e2e["linux_full"] else "false"
    # The canary runs on the real backend: in the run, it must pass a case, never skip as without that backend.
    canary = LINUX_E2E_CANARY.removeprefix("cli/")
    values["linux-e2e-must-pass"] = canary if e2e["linux_full"] or canary in e2e["linux_files"] else ""
    return values


def base_sha(event):
    return sha(event["pull_request"]["base"]["sha"])


def verify(plan, needs, source):
    if plan.get("schema") != 1 or plan.get("kind") != "ci-plan" or plan.get("head") != sha(source):
        raise ValueError("CI plan identity does not match this source")
    sha(plan.get("tree"))
    if plan.get("draft") is not False:
        raise ValueError("Draft PR: complete component validation is deferred until ready_for_review")
    suites = plan.get("suites")
    if not isinstance(suites, list) or len(set(suites)) != len(suites) or not set(suites) <= SUITES:
        raise ValueError("invalid planned suites")
    reused = check_reused_records(plan.get("reused", {}), suites, plan["head"], plan.get("event"))
    expected = {"process-checks"} | set().union(*(JOBS[name] for name in set(suites) - set(reused)))
    if plan.get("required_jobs") != sorted(expected):
        raise ValueError("CI plan has incomplete job coverage")
    if needs.get("plan", {}).get("result") != "success":
        raise ValueError("CI planning did not pass")
    for job in expected:
        if needs.get(job, {}).get("result") != "success":
            raise ValueError(f"required CI job did not pass: {job}")
    for job in set().union(*(JOBS[name] for name in reused)):
        if needs.get(job, {}).get("result") != "skipped":
            raise ValueError(f"reused CI job ran again: {job}")
    for job, result in needs.items():
        if result.get("result") not in {"success", "skipped"}:
            raise ValueError(f"CI job did not complete successfully: {job}")
    required = local_checks.planned_checks(plan)
    try:
        receipts = json.loads(needs.get("process-checks", {}).get("outputs", {}).get("local_receipts", "[]"))
    except (ValueError, TypeError):
        receipts = None  # No receipt: validate_receipts names what is missing.
    receipts = local_checks.validate_receipts(plan["head"], required, receipts)
    return dict(schema=1, kind="ci-required", status="passed", source_sha=plan["head"],
                source_tree=plan["tree"], event=plan["event"], base=plan["base"],
                suites=suites, required_jobs=sorted(expected), results={k: v["result"] for k, v in needs.items()},
                reused=reused, reuse=plan.get("reuse"),
                local_receipts=receipts,
                run_id=int(os.environ.get("GITHUB_RUN_ID", "0")), run_attempt=int(os.environ.get("GITHUB_RUN_ATTEMPT", "0")))


RUN_URL = re.compile(r"https://github\.com/[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*/actions/runs/[1-9][0-9]*")


def is_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def positive(value):
    return type(value) is int and value > 0


def check_reused_records(reused, suites, head, event):
    """The shape of a plan's or receipt's reused results; the merge helper re-derives their substance."""
    if not isinstance(reused, dict) or not set(reused) <= set(suites):
        raise ValueError("reused suites must be planned suites")
    if reused and event != "pull_request":
        raise ValueError("only a pull request's update merge can reuse results")
    for suite, record in reused.items():
        if (not isinstance(record, dict) or not is_sha(record.get("origin_sha")) or record["origin_sha"] == head
                or not is_sha(record.get("origin_tree"))
                or not positive(record.get("run_id")) or not positive(record.get("run_attempt"))
                or not isinstance(record.get("run_url"), str) or not RUN_URL.fullmatch(record["run_url"])
                or not record["run_url"].endswith(f"/actions/runs/{record['run_id']}")
                or not isinstance(record.get("reason"), str)):
            raise ValueError(f"malformed reused result: {suite}")
    return reused


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--scope", default="full")
    parser.add_argument("--e2e-files", default="", help="with scope linux-e2e: the cli/e2e files to run, separated by spaces")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.verify:
        plan = json.loads(os.environ["CI_PLAN"])
        if (git(Path.cwd(), "rev-parse", "HEAD") != os.environ["CI_SOURCE_SHA"]
                or git(Path.cwd(), "rev-parse", "HEAD^{tree}") != plan.get("tree")):
            raise ValueError("CI gate checkout differs from the planned source")
        record = verify(plan, json.loads(os.environ["CI_NEEDS"]), os.environ["CI_SOURCE_SHA"])
    else:
        event_name = os.environ["GITHUB_EVENT_NAME"]
        # Read-only Actions lookups with a one-minute budget; any failure reruns as before.
        evidence = (GitHubEvidence(ci.Client(os.environ["GITHUB_REPOSITORY"], time.monotonic() + REUSE_LOOKUP_SECONDS))
                    if event_name == "pull_request" and os.environ.get("GH_TOKEN") else None)
        record = make_plan(Path.cwd(), event_name, json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()),
                           args.scope, os.environ["CI_SOURCE_SHA"], evidence, args.e2e_files)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.writelines(f"{name}={value}\n" for name, value in outputs(record).items())
    args.output.write_text(json.dumps(record, indent=2) + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Source: `{record.get('head', record.get('source_sha'))}`\n\n")
        summary.write("Automatic suites: " + ", ".join(record["suites"] or ["repository process checks"]) + ".\n")
        if record.get("local_checks"):
            summary.write("\nRequired local receipts: " + ", ".join(record["local_checks"]) + ".\n")
        for suite, reused in sorted((record.get("reused") or {}).items()):
            summary.write(f"\nReused `{suite}` from [run {reused['run_id']}]({reused['run_url']}) "
                          f"(attempt {reused['run_attempt']}, `{reused['origin_sha']}`): {reused['reason']}.\n")
        if (record.get("reuse") or {}).get("reason"):
            summary.write(f"\nReuse: {record['reuse']['reason']}.\n")
        for suite, reason in sorted(((record.get("reuse") or {}).get("rerun") or {}).items()):
            summary.write(f"- `{suite}` runs again: {reason}.\n")
        e2e = record.get("e2e")  # A plan's; the gate's receipt has none.
        if e2e and "windows-e2e" in set(record["suites"]) - set(record["reused"]):
            first = next((path for path in record["paths"] if windows_only(path)), None)
            summary.write("\nWindows end to end: " + (
                "x64 alone.\n" if not e2e["windows_arm64"] else "x64 and arm64, run by hand.\n" if first is None else
                # The PR names its paths, and git allows backticks and newlines in one.
                f"x64 and arm64, for the Windows-only `{first}`.\n" if PLAIN_PATH.fullmatch(first) else
                "x64 and arm64, for a Windows-only file.\n"))
        if e2e and e2e["device_app_builds"]:
            summary.write("\nHarness Device builds: "
                          + ", ".join(f"{build['bundle']} {build['arch']}" for build in e2e["device_app_builds"]) + ".\n")
        if e2e and e2e["linux_full"]:
            summary.write(f"\nLinux end to end: more than {LINUX_E2E_FILES_MAX} e2e files, so the full suite on "
                          f"{LINUX_E2E_FULL_SHARDS} shards.\n")
        elif e2e and e2e["linux_files"]:
            files, runners = len(e2e["linux_files"]), e2e["linux_shards"]
            summary.write(f"\nLinux end to end: {files} file{'' if files == 1 else 's'} on {runners} "
                          f"runner{'' if runners == 1 else 's'}: " + ", ".join(f"`{name}`" for name in e2e["linux_files"])
                          + ".\n")
        if record.get("draft"):
            summary.write("Draft PR: only workflow/process checks run; mark ready for review to run the complete affected suites. The integration gate remains blocked.\n")
        summary.write("Native, real-engine, hardware and visual acceptance remain explicit review requirements.\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
