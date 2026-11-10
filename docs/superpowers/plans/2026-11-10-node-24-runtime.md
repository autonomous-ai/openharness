# Node 24 Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harness's CLI and daemon run on Node 24 LTS on every new and existing install (macOS, Linux, Windows, Harness OS, Team accounts), with engines installed under Node 22 still found.

**Architecture:** `MINIMUM_NODE_MAJOR = 24` lives in `cli/src/lib/nodeRuntime.ts`. The updater installs the manifest's Node 24 and writes `current-node` before it stages a build. `startMasterFromBundle` probes and execs on `managedNodePath()` when that meets the minimum, so the switch happens in the update's existing exec gap. The update's probation covers the Node switch. After a switch, the launcher, the service definition and Team links follow `current-node`. Engine lookup searches every managed Node folder.

**Tech Stack:** TypeScript (Node), vitest, bash/PowerShell installers, GitHub Actions, Arch/Fedora packaging (Python tests).

**Spec:** `docs/superpowers/specs/2026-11-10-openclaw-engine-design.md`, section "Part 0: Harness runs on Node 24".

## Global Constraints

- **`NODE24`**: the newest `v24.x` in `https://nodejs.org/dist/index.json` with `lts` set, a `date` at least 14 days before the pin, and ≥ `24.16.0`. Pin that exact version wherever this plan says `NODE24`.
- **Scope**: the Node that runs the CLI/daemon. These stay on `22.23.2`: `backend/Dockerfile*`, `website/Dockerfile.k8s`, `ci.yml:407,444`, and the backend-cache, website, store, home-assistant, experience and authoring CI jobs.
- **The bundle keeps running on Node 22** for one release window. The esbuild targets (`node20`) and `@types/node` (`^20.14.10`) stay unchanged. Task 10 opens the follow-up.
- **Release order**: staging manifest, then E2E, then production manifest, then the CLI release.
- **Every failure is seen**: a log line, a reason in `harness status`, and on Desktop. Every network call has a timeout.
- **No commits until Ken asks.** "Commit" steps mean "stage for the PR", and run only on his word.
- **Checks**: PR CI runs Linux unit checks only. The CLI coverage gates and Desktop macOS tests run once, at the end, and their receipts go in the PR.

## Review Focus

1. A Node 22 machine whose manifest has no Node 24 for its platform. Expected: stays on 22, `harness status` says why, and the daemon keeps running.
2. Node 24 installs but the core crash-loops on it. Expected: probation fails, `current-node` goes back to 22, the master re-execs onto 22, and the status says it rolled back.
3. Claude Code installed with npm under `node-v22…/bin`, then the switch. Expected: New and resume still find it, with no reinstall.
4. A reboot after the switch. Expected: launchd/systemd start the daemon on Node 24 directly, with no second migration.
5. Two `harness start` running at once during migration. Expected: one Node 24 directory, and both end on the same `current-node`.

---

### Task 1: Minimum major and a fetch with a timeout

**Files:**
- Modify: `cli/src/lib/nodeRuntime.ts`
- Modify: `cli/src/lib/runtimeInstall.ts:191-310`
- Test: `cli/src/lib/runtimeInstall.spec.ts`; create `cli/src/lib/nodeRuntime.spec.ts`

**Interfaces:**
- Produces:
  - `export const MINIMUM_NODE_MAJOR = 24` (`nodeRuntime.ts`).
  - `export function nodeMajorOf(binaryPath: string): number | null`. It reads `<major>` from the nearest ancestor folder named `node-v<major>.<minor>.<patch>-<key>`. It accepts `…/bin/node`, `…\node.exe` and the hard link `…/libexec/harnessd/<name>`, and returns null otherwise. It does not exec.
  - `export async function ensureNodeMeetsMinimum(log: (m: string) => void, timeoutMs?: number): Promise<{ node: string | null; reason: NodeMigrationReason | null }>` (`runtimeInstall.ts`). Here `type NodeMigrationReason = 'no-manifest-entry' | 'manifest-unreachable' | 'download-failed' | 'does-not-run' | 'unmanaged'`.
    - When the managed Node already meets the minimum, `node` is that path and no fetch is made.
    - Otherwise it installs the manifest's Node (staged, sha256, `--version`, `current-node` last) and returns the new path.
    - On failure, `node` is the old path and `reason` is set.
  - `ensureManagedRuntime` keeps its behavior.
  - The manifest fetch passes `signal: AbortSignal.timeout(timeoutMs ?? 15_000)`.

- [ ] **Step 1: Write the failing tests.**
  - In `runtimeInstall.spec.ts`, using `buildArchive` and the fake manifest server:
    - `ensureNodeMeetsMinimum installs the manifest Node when the managed one is 22`: installed `node-v22.23.2-<key>`, manifest `v24.22.2`. Expect `node === join(rt,'node-v24.22.2-<key>','bin','node')`, `current-node` naming it, and the v22 folder kept.
    - `ensureNodeMeetsMinimum makes no request when the managed Node is 24`: expect 0 requests.
    - `ensureNodeMeetsMinimum keeps 22 when the manifest only has 22`: expect the old path, `reason: 'no-manifest-entry'` and `current-node` unchanged.
    - `ensureNodeMeetsMinimum keeps 22 when 24 does not run`: `--version` exits 1. Expect `reason: 'does-not-run'`.
    - `ensureNodeMeetsMinimum gives up on a manifest that never answers`: the server holds the request; `timeoutMs: 50`. Expect `reason: 'manifest-unreachable'` within 1 s.
  - In `nodeRuntime.spec.ts`, `nodeMajorOf reads the runtime folder`, with these cases:
    - `.../node-v24.22.2-darwin-arm64/bin/node` → 24
    - `...\node-v22.23.2-win32-x64\node.exe` → 22
    - `.../node-v22.23.2-linux-x64/libexec/harnessd/harnessd` → 22
    - `/usr/local/bin/node` → null
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/lib/runtimeInstall.spec.ts src/lib/nodeRuntime.spec.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement.** Reuse `ensureManagedArchive` with an `acceptsVersion` that refuses majors below the minimum, and report the reason it stopped. Add `signal` to its `fetch`.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `Managed Node: a minimum major, a reason when it is not met, and a fetch timeout`.

### Task 2: Engines installed under any managed Node are found

**Files:**
- Modify: `cli/src/engines/kit/launchExecutable.ts:123` (`npmRuntimeBins`)
- Test: `cli/src/engines/kit/launchExecutable.spec.ts`

**Interfaces:**
- Produces: `npmRuntimeBins(): string[]`. It returns the `bin` folder (on Windows, the folder itself) of every `node-v*-<key>` under `env.ADAPTER_RUNTIME_DIR`. The current `current-node` folder comes first, then the rest by version, newest first.

- [ ] **Step 1: Write the failing test** `finds an engine installed under the previous Node`: create `node-v22.23.2-<key>/bin/claude` and `node-v24.22.2-<key>/bin/node`, with `current-node` naming v24. Expect the lookup for `claude` to return the v22 path. Add the same case on win32 (`node-v22…-win32-x64\claude.cmd`).
- [ ] **Step 2: Run it and see it fail.** Run: `cd cli && npx vitest run src/engines/kit/launchExecutable.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the ordering above.
- [ ] **Step 4: Run it and see it pass.** Then re-record the launch goldens that print the search path (`RECORD_LAUNCH_GOLDEN=1`, `RECORD_LAUNCH_PREP_GOLDEN=1`) and read the diff: only the extra folders appear. Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `Find npm engines under every managed Node`.

### Task 3: The update moves the master onto Node 24, on probation

**Files:**
- Modify: `cli/src/lib/selfUpdate.ts` (before a build is staged), `cli/src/masterProcess.ts:352,400` (`startMasterFromBundle`: probe and exec node), `cli/src/harnessd/master.ts` and `cli/src/harnessd/reexec.ts` (probation holds the previous Node, and rollback rewrites `current-node`)
- Test: `cli/src/lib/selfUpdate.spec.ts`, `cli/src/masterProcess.spec.ts`, `cli/src/harnessd/master.spec.ts`

**Interfaces:**
- Consumes: `ensureNodeMeetsMinimum`, `nodeMajorOf` and `MINIMUM_NODE_MAJOR` (Task 1), and `managedNodePath()`.
- Produces:
  - The updater calls `ensureNodeMeetsMinimum` once before it stages a downloaded build. It stores the reason in the update state that `harness status` reads (Task 5).
  - `startMasterFromBundle` probes and execs on `namedNode(managedNodePath(), …)` when `nodeMajorOf(managedNodePath()) >= MINIMUM_NODE_MAJOR`, and on its current Node otherwise.
  - The probation record gains `previousNode: string | null`. A failed probation whose `previousNode` differs from the current one writes `previousNode` back to `current-node` before it re-execs, and logs `[harnessd] the core did not come up on Node <v>; back on <old>`.
  - Windows: the handover's `harness-launch.exe` already reads `current-node` (`masterProcess.ts:218`), so the updater writing it first is the whole change there.

- [ ] **Step 1: Write the failing tests.**
  - `selfUpdate.spec.ts`:
    - `an update installs Node 24 before staging the build`: managed v22, manifest v24. Expect `ensureNodeMeetsMinimum` called before the stage step, and `current-node` = v24 by the time staging runs.
    - `an update whose Node 24 fails still stages the build and records why`: expect the stage to happen and the status to hold `reason`.
  - `masterProcess.spec.ts`:
    - `startMasterFromBundle probes and execs on the managed Node 24`: `current-node` v24 while this process runs on v22. Expect the probe argv[0] and the exec file to be the v24 link.
    - `Windows writes current-node before the handover launch`: platform `win32`. Expect `current-node` = v24 before the `launch` fake is called.
  - `master.spec.ts`:
    - `failed probation after a Node switch restores current-node`: probation with `previousNode` v22, and the core never healthy. Expect `current-node` = v22, the re-exec file to be the v22 link, and one log line.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/lib/selfUpdate.spec.ts src/masterProcess.spec.ts src/harnessd/master.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run them and the harnessd gate, and see them pass.** Run: `cd cli && npx vitest run src/lib/selfUpdate.spec.ts src/masterProcess.spec.ts src/harnessd/master.spec.ts && npm run test:harnessd`. Expected: PASS. Compare any red against a clean `main` worktree (memory `test-suite-baseline`).
- [ ] **Step 5: Commit** (once Ken asks): `Update: move the daemon to Node 24 in the update's own gap, with rollback`.

### Task 4: Everything that names the Node follows the switch

**Files:**
- Modify: `cli/src/cli.ts:1583-1588` and the core's start path in `cli/src/core/main.ts` (after the core is up on a Node different from the one in the launcher, call `ensureLauncher(managedNodePath())`). Also modify `cli/src/harnessd/platform.ts:122,196`, where the launchd plist and systemd unit are rewritten when their node differs from `managedNodePath()`, and `cli/src/team/script.ts:79,189,193,205,736` with `linkTeamNodeTools`, which replaces a link that points at another Node folder.
- Test: `cli/src/harnessd/platform.spec.ts`, `cli/src/team/script.spec.ts`, `cli/src/lib/launcher.spec.ts` (or the spec that covers `ensureLauncher`; find it with `git grep -l ensureLauncher -- '*.spec.ts'`)

**Interfaces:**
- Produces: `refreshNodeReferences(node: string, log): Promise<{ launcher: boolean; service: boolean; team: boolean }>` in `cli/src/lib/nodeReferences.ts` (create). Each flag says whether that reference was rewritten. Once the core is up, it is called once per core start.

- [ ] **Step 1: Write the failing tests.**
  - `refreshNodeReferences rewrites a launcher that names node 22`
  - `rewrites the launchd plist and systemd unit whose node is 22` (fake fs, darwin and linux)
  - `repoints team node, npm and npx links` (fake team layout from `team/script.spec.ts`)
  - `leaves everything alone when it already names node 24`: all flags false, no writes.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/lib/nodeReferences.spec.ts src/harnessd/platform.spec.ts src/team/script.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, reusing `ensureLauncher`, the service-definition writer in `platform.ts`, and `linkTeamNodeTools`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `Launcher, service and Team links follow the managed Node`.

### Task 5: Node version and migration reason in status

**Files:**
- Modify: the `/api/status` and `harness status` builders (`git grep -n "writeStatusFile\|statusCommand" cli/src`), and Desktop's status view that shows the daemon version (`git grep -n "daemonVersion" desktop/lib`)
- Test: the status spec beside each builder, and a Desktop widget test for the status row

**Interfaces:**
- Consumes: `NodeMigrationReason` (Task 1), as stored by Task 3.
- Produces: status fields `node: { version: string; managed: boolean; migration: NodeMigrationReason | 'rolled-back' | null }`. `harness status` prints `node  v24.22.2` or `node  v22.23.2 (stays on 22: <reason copy>)`. Reason copy:
  - `no-manifest-entry` → `no Node 24 for this computer yet`
  - `manifest-unreachable` → `could not reach the update server`
  - `download-failed` → `the download failed`
  - `does-not-run` → `Node 24 did not start here`
  - `unmanaged` → `this Harness runs on a Node it does not manage; install Node 24`
  - `rolled-back` → `Node 24 did not come up; back on 22`

- [ ] **Step 1: Write the failing tests**: one status spec per reason, printing the exact copy above. On Desktop, `the status row shows the Node version and why it stayed on 22`.
- [ ] **Step 2: Run them and see them fail.** Run the specs found above, and `cd desktop && flutter test <the widget test>`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `Status: Node version and why a migration did not happen`.

### Task 6: Installers and floors

**Files:**
- Modify: `cli/scripts/install.sh:547-611` (`node_is_usable` reuses a managed Node ≥ 22; a fresh install gets the manifest's Node), `cli/scripts/install-cli.sh:77-78` (22.15), and `cli/package.json` (`engines.node` → `>=22.15.0`). Ruling after the final review: every floor is 22, what the bundle runs on during the window; the updater moves a managed 22 to 24.
- Modify Desktop: `desktop/lib/bootstrap/environment_provisioner.dart:1496` (the check is ≥ 22), `:296,305,637,640` (copy `Node 22+`), and `desktop/lib/widgets/dsh_install_panel.dart:341` (`brew install node@22`).
- Test: `cli/src/scripts/install.spec.ts`, `desktop/test/environment_provisioner_test.dart`, `desktop/test/dsh_install_panel_test.dart`

- [ ] **Step 1: Write the failing tests.**
  - `install.sh replaces a managed Node below 24`: a pre-made `runtime/node-v22.23.2-<key>`, and a fake CDN with `v24.22.2`. Expect `current-node` = v24, with v22 kept.
  - `the provisioner refuses Node 22`, which accepts it today.
  - Update the copy expectations.
- [ ] **Step 2: Run them and see them fail.** Run: `cd cli && npx vitest run src/scripts/install.spec.ts`, then `cd desktop && flutter test test/environment_provisioner_test.dart test/dsh_install_panel_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement.** A source install on an older Node prints `error: Harness needs Node 24.16 or newer (found <v>)`.
- [ ] **Step 4: Run them and see them pass.** Expected: PASS.
- [ ] **Step 5: Commit** (once Ken asks): `Installers: Node 24 floor`.

### Task 7: Publish through staging

**Files:**
- Modify: `desktop/scripts/publish-managed-node-runtime.sh` (default `METADATA_PATH=harness/staging/runtime/metadata.json`; production only through an explicit `METADATA_PATH=harness/runtime/metadata.json`; a `DRY_RUN=1` that prints the object paths and uploads nothing; usage example `NODE24`), `cli/scripts/publish-node-runtime-windows.sh:11,22` and `cli/scripts/windows-install-manifest.mjs:12` (examples), `cli/scripts/windows-cli-e2e/fake-cdn.sh:65` (default `NODE_VERSION` → `NODE24`).
- Modify docs: `desktop/Makefile:30`, `desktop/README.md:418`, `desktop/RELEASE.md:69,79` and `desktop/CLAUDE.md:139`, giving the staging, then E2E, then production steps.
- Test: create `cli/src/scripts/publishManagedNodeRuntime.spec.ts`, modeled on `publishNodeRuntimeWindows.spec.ts`.

- [ ] **Step 1: Write the failing test** `defaults to the staging manifest`: run the script with `DRY_RUN=1 <NODE24>`. Expect stdout to contain `harness/staging/runtime/metadata.json` and no production path.
- [ ] **Step 2: Run it and see it fail.** Run: `cd cli && npx vitest run src/scripts/publishManagedNodeRuntime.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it and see it pass.** Expected: PASS.
- [ ] **Step 5: Publish to staging.** This is an outward action, so ask Ken first. Run `make -C desktop upload-node-runtime ARGS=<NODE24>`, then the `release-node-runtime-windows.yml` workflow with `<NODE24>`. Verify: `curl -s https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/runtime/metadata.json | jq '.node | map_values(.version)'` shows `v<NODE24>` for all six keys.
- [ ] **Step 6: Commit** (once Ken asks): `Node runtime: macOS and Linux publish through staging`.

### Task 8: CI, release and OS images

**Files:**
- Modify (`22.23.2` → `NODE24`): `.github/workflows/ci.yml:34` (`CLI_NODE_VERSION`), `cli-e2e.yml:32`, `release.yml:210,395,484`, `release-tui.yml:125`, `windows.yml:71,259,265`, `windows-desktop.yml:128,463`, `release-node-runtime-windows.yml:14,40`, `os.yml:192,266,685`, `os-arm-boot.yml:23`, `os-arm-session.yml:28`, `os-runtime.yml:29`, `os-runtime-updates.yml:29`, `os-t2.yml:45`, `os-t2-update.yml:36`.
- Modify: `scripts/record-ci-validation.py:22` (its stale `serial-native` job names, which match no CI job: delete them, or point them at the jobs that exist).
- Modify OS:
  - Arch: `os/packages.x86_64:62`, `os/tools/build-package.py:20`, `os/README.md:143` (`nodejs-lts-jod` → Node 24's LTS package; confirm the name with `pacman -Si` in the Arch image). In `os/` `runtime_update.py:234`, an update replacing the old package must not abort on the conflict prompt: pass the replaced package explicitly, so `pacman` removes it.
  - Fedora: `os/packaging/fedora/harness-os-session.spec:16` (`nodejs24`, `nodejs24-bin`; confirm with `dnf info` in the image), `os/tests/arm_session_root.sh:13` (the npm sub-package too).
  - Orange Pi: `os/platforms/orangepi-4pro/build-docker.sh:55` and `build-base.sh:20` (`setup_24.x`).
- Test: `os/tests/test_package.py:56`, `os/tests/test_runtime_update.py:201,223` (add `an update from jod to the Node 24 package replaces it without a prompt`), `os/tests/test_asahi_image.py:74-79`, `os/tests/test_hardware_update_fixture.py:400`.

- [ ] **Step 1: Update the OS tests** to the Node 24 package names, and add the replace test. Run: `cd os && python -m pytest tests/test_package.py tests/test_runtime_update.py tests/test_asahi_image.py tests/test_hardware_update_fixture.py`. Expected: FAIL.
- [ ] **Step 2: Change the packages, `runtime_update.py` and the workflows.** Run the same command. Expected: PASS.
- [ ] **Step 3: Check that no CLI pin is left.** Run: `git grep -n "22\.23\.2" -- ':!cli/scripts/windows-cli-e2e/evidence' ':!docs'`. Expected: only the out-of-scope jobs, plus spec strings that use a Node path as an arbitrary example.
- [ ] **Step 4: Commit** (once Ken asks): `CI, release and OS images: Node 24`.

### Task 9: Re-measure Node 22 behavior on Node 24

**Files:**
- Create: `cli/scripts/probe-node-behavior.mjs`. Each check prints `ok`/`changed` with the value seen:
  - `zlib` zstd: does a truncated final block throw (`kit/zstdFrames.ts:2`)?
  - `process.execve` of a missing file: exit code and signal (`harnessd/reexec.ts:633`, `masterProcess.ts:397`)
  - `performance.now()` and `Date.now()` across a `sleep` (`lib/sleepAware.ts:5`)
  - a child held in I/O exiting 0 with empty stdout (`lib/patientExec.ts:8`)
  - NTFS ctime after a rename without a write, Windows only (`kit/windowsFiles.ts:52`)
  - `node:sqlite` availability and `busyTimeout` (`lib/sqliteRead.ts:7`)
- Modify: each comment above, to name the version it now holds on. Change the code only if a probe says `changed`, and then add a spec that pins the new behavior first.

- [ ] **Step 1: Run the probe on both Nodes.** Run `node cli/scripts/probe-node-behavior.mjs` on 22.23.2 and on `NODE24` (`npx -y node@<NODE24>`), on macOS. Then run the Windows check on the VM (memory `windows-vm-e2e`). Expected: both outputs are saved in the PR.
- [ ] **Step 2: For each `changed`**, write the failing spec, fix it, and watch it pass.
- [ ] **Step 3: Update the comments.** Drop the local `process.execve` cast in `harnessd/master.ts:102` only once `@types/node` is raised by the Task 10 follow-up. Not now.
- [ ] **Step 4: Commit** (once Ken asks): `Re-measure Node-specific behavior on Node 24`.

### Task 10: End to end, numbers, release

- [ ] **Step 1: Migration E2E against the staging manifest** (`ADAPTER_RUNTIME_METADATA_URL` and `HARNESS_RUNTIME_METADATA_URL` pointed at staging). The migration lags one release: an updater from before this release only replaces `cli.js`, so a machine moves to Node 24 on the first update after this release is installed. On each machine, start from a released Harness on Node 22 with Claude Code installed through Harness's npm recipe. Install this build as an update (the updater path, not `make install-cli`); it still runs on 22. Then serve a newer build from the staging manifest, let this build's updater install it, and check:
  - `harness status` shows `node v<NODE24>`;
  - `current-node` names v24, and v22 is kept;
  - Claude Code still starts from New;
  - after a reboot, the daemon starts on v24 with no second migration;
  - the launcher (`harness --version` run from a new shell) runs on v24.

  Do this on:
  - macOS (this Mac);
  - Linux (a box installed with `install.sh`, not `cli/docker/remote-machine`'s system Node);
  - Windows (the VM and the Dell PC, memories `windows-vm-e2e` and `windows-x64-dell-e2e`), recording the session's windows: none opens;
  - Harness OS (`os-runtime-updates` workflow, run once by hand);
  - a Team account on macOS.
- [ ] **Step 2: Rollback E2E.** On macOS, point staging at a Node 24 build that fails to start a core (for example, `HARNESS_TEST_CORE_CRASH=1`, if such a hook exists; otherwise a fixture manifest whose binary exits 1 after `--version`). Expect `rolled-back` in status, and the daemon on 22.
- [ ] **Step 3: Idle numbers.** Record daemon CPU and RSS at rest for 10 minutes with the same agents, on 22 and then on 24 (`ps -o %cpu,rss` every 10 s). Expected: not worse. Put both tables in the PR.
- [ ] **Step 4: Gates.** Run once, on Node 24: `cd cli && npm run test:core && npm run test:harnessd && npm run test:resume && npm run test:orchestrator && npm run test:sharing && npm run test:remote-viewers && npm run test:portability && npm run test:local-models`, plus Desktop's macOS tests. Compare against a clean `main` worktree, and record the receipts.
- [ ] **Step 5: Production, then release.** Only on Ken's word, and inside the release window (memory `release-window`):
  - publish both runtimes with `METADATA_PATH=harness/runtime/metadata.json`;
  - verify all six production keys show `v<NODE24>`;
  - then release the CLI;
  - cut the next CLI release within the window: installs move to Node 24 on that update, the first after this one;
  - release Desktop only after the production manifest has Node 24.
- [ ] **Step 6: Follow-up task.** "CLI esbuild targets `node20` → `node24`, and `@types/node` → `^24` (drop the `execve` cast), no earlier than <release date + 30 days>."
