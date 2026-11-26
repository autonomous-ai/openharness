# Windows: a running Codex is found again after a restart: Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with **devcrew phase 3** (a queue: each task starts once the tasks it
> depends on have landed and no running task shares one of its files). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a daemon restart on Windows, the open scan finds a Codex running in VS Code's terminal before its next
hook (embedded TUI or Codex 0.167+ daemon) and places it on VS Code's page; a daemon's hooks are placed by their client,
as on macOS and Linux.

**Architecture:** A one-shot `harness-pty files --json <pid>…` (Rust, `pty/`) lists, for at most 32 processes, their open
disk files and their working folder. A reader beside `lib/windows/processTable.ts` runs it; `processView.openFilesOf`
and `processCwds` (`lib/sessionSearch/externals/support.ts`) answer from it on win32. `codexServed` turns on for win32,
where every Codex TUI counts as on a terminal. The running PTY host, its protocol, the core and the services are not
touched.

**Tech Stack:** Rust 2024 + `windows-sys` 0.59 (`pty/`), TypeScript (Node 24), Vitest; Windows tests in PR CI's
`windows.yml` (x64 and arm64).

**Spec:** `docs/plans/2026-11-27-windows-codex-rescan-design.md` (approved; read it with this plan). Base:
`fix/windows-codex-rescan` at `5eca6c7253`.

Paths: `P/` is `pty/src/`, `W/` is `cli/src/lib/windows/`, `X/` is `cli/src/lib/sessionSearch/externals/`, `H/` is
`cli/src/cable/hosts/`. TypeScript commands run in `cli/`, Rust in `pty/`.

## Decisions already made (PM, 2026-11-27): not reopened

1. Turning on `codexServed` on Windows also places a daemon's hooks by their client (`observed.ts` `askServed`), in this
   PR: one lookup for the scan and the hooks.
2. The read is a one-shot `harness-pty files --json <pid>…` subcommand, never an op of the running PTY host; no protocol
   change.

## What this plan decides from the code (read for this plan, not run)

- **The folder is named as Node's `realpath` names it.** `codexServed` matches `cwds.get(pid) === await
  deps.folder(ask.cwd)`, and `folder` is `folderKey` (`realpath`, which on Windows is `GetFinalPathNameByHandleW`, `\\?\`
  stripped, `\\?\UNC\` made `\\`). The PEB's `CurrentDirectory.DosPath` keeps the spelling the process was given (case,
  an 8.3 short name, a trailing `\`) and would never match. So harness-pty reads `CurrentDirectory.Handle` from the PEB
  (still `PROCESS_VM_READ`, the spec's rights), duplicates it as it does file handles, and names it with
  `GetFinalPathNameByHandleW`: the folder the process pins, named the way `folderKey` names the session's. No path is
  opened, so no share is reached.
- **`codexServed` must carry start markers to its app walk.** It builds `names` without `startMarker`, so on Windows
  `learnApps`' walk (`windowsPtyMaker` → `parentChain`) does not stop at a reused pid: a daemon whose first TUI exited,
  its pid now a later `Code.exe`, reads as VS Code's own app server and is placed by its hints. `names` keep the row's
  marker (Task 4).
- **A Windows TUI is npm's launcher and its native Codex, as on macOS.** `node.exe …\codex\bin\codex.js` matches Codex
  (`engineProcessMatch`, score 2), so the candidate is the launcher and its `codex.exe` child is not counted again: the
  client's pid is the launcher's (`client:420` below). `openFilesOf(['codex','Codex'])` selects by image name, so it
  reads `codex.exe` alone.
- **One memo per view.** `processView` on win32 asks harness-pty once per pid per view; `openFilesOf` and `cwds` share
  it. `openFilesOf` drops a row whose `startMarker` is not the table's (spec); `processCwds` has no table and checks
  none, as `lsof -p` and `/proc` do not.
- **A bound on handles.** The spec bounds files (4096) but not the handle snapshot; the code standards ask every list be
  bounded: at most 65,536 handles a process (a Codex holds hundreds; the snapshot stays under 3 MiB), past it the row is
  left out.
- **Nothing in the core or services changes.** `services/devices.ts` already wires `served: servedLookup(platform)` and
  `services/externalSessions.ts` already builds `processView()`; `support.ts` is not in `src/architecture.coreFiles.txt`.

## Tasks at a glance

| # | Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 | `harness-pty files --json` | `P/open_files.rs` (new), `P/lib.rs`, `P/cli.rs`, `pty/Cargo.toml` | none | xhigh | `open_files.rs` pure tests, `cli.rs` "parses_files" (Mac); Windows tests in windows.yml |
| 2 | The reader in `lib/windows` | `W/openFiles.ts` (new), `W/openFiles.spec.ts` (new) | none | high | `openFiles.spec.ts` (no module) |
| 3 | `processView` and `processCwds` read it on win32 | `X/support.ts`, `X/support.spec.ts` | 2 | high | `support.spec.ts` "on Windows asks harness-pty files …" |
| 4 | `codexServed` on Windows | `H/codexServed.ts`, `H/codexServed.spec.ts`, `H/observed.ts` (comment) | none | high | `codexServed.spec.ts` "on Windows …" cases, "servedLookup" |
| 5 | The real host's rows match the reader and `folderKey` | `W/openFiles.windows.real.spec.ts` (new) | 1, 2 | high | none locally (skipped off Windows); runs in windows.yml |
| 6 | The scan and the hooks on Windows, end to end in the source | `H/observed.spec.ts` | 3, 4 | high | the new cases, red against the base's `support.ts` and `codexServed.ts` |
| 7 | Docs | `cli/AGENTS.md`, `docs/windows-rules.md` | 1, 3, 4 | medium | none: docs, one commit |

**Longest chain:** 2 → 3 → 6 (three tasks; 2 → 3 → 7 is as long). Tasks 1, 2 and 4 start at once; 1 is the longest
single task, and 5 follows it.

## Global Constraints

- `cd cli && npm ci` first if the worktree has no `node_modules`.
- **Windows only.** `harness-pty files` elsewhere prints `{"unsupported":true}` and exits 3 (as `ps`); the CLI never
  spawns it off win32. macOS and Linux behave exactly as today.
- **Rights:** `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ)` and nothing else.
  `DuplicateHandle` with desired access `0` and options `0`: never `DUPLICATE_CLOSE_SOURCE` (it would close the
  target's handle), never `DUPLICATE_SAME_ACCESS`. Each duplicate is an `OwnedHandle`, dropped at once, never used for
  I/O. Nothing writes to another process.
- **Never `NtQueryObject`** on a handle. A handle is named only when `GetFileType` is `FILE_TYPE_DISK` and
  `FILE_STANDARD_INFO.Directory` is false.
- **Bounds:** ≤ 32 pids a run (CLI refuses more; the reader says unknown past it); ≤ 65,536 handles and ≤ 4096 distinct
  files a process; each path ≤ 32 Ki UTF-16 units; stdout ≤ 4 MiB; 3 s timeout. Past a per-process bound that row is
  left out.
- **Unknown is never "nothing".** A process not read is absent from the output; a failed, timed-out or over-bound run
  is `null` in the reader and an empty map plus `externalReadFailed(error, 'process files')` in `support.ts`.
- **Nothing logged:** no path, folder, pid or argument, in Rust or TS; errors by kind only. Paths stay in memory
  (stdout of a child, then the claim), as on macOS.
- **Spawning:** `execFile` through `patientExec`, `windowsHide: true`, never `detached` (`docs/windows-rules.md` §1).
  Test children (`ping.exe`) the same.
- **No protocol change**; `serve` gains nothing; nothing under `cli/src/core/` or `cli/src/services/`, so
  `npm run test:core` does not apply.
- Every behavior task: a red commit (the failing tests), then a green commit. `npm run typecheck` when a TS type or
  signature changes. Comments say why and name the spec. Names follow `docs/naming-system.md`.
- **This Mac is shared:** a task runs only its own specs, `npm run typecheck` and `cargo test --locked` in `pty/`; any
  suite (`scripts/local-checks.py --run`) waits for the PM's go. Never `pgrep -f`, `ps aux`, `ps -o args`, never
  `harness device notify`, no screenshots, no real Codex or VS Code.

## Review Focus

1. **A TUI working in a folder spelled differently from the session's `cwd`** (other case, an 8.3 short name such as
   `RUNNER~1`, a trailing `\`): its session still finds that client. Tests: Task 1
   `a_childs_folder_is_named_as_windows_resolves_it`; Task 5 "names a folder as folderKey does".
2. **A pid reused between the table's read and harness-pty's, or the daemon's exited first TUI's pid now held by a later
   app:** never placed by the newcomer. Tests: Task 3 "drops a row whose start marker is not the table's"; Task 4 "the
   first TUI gone, its pid taken by a later VS Code: the daemon is still the daemon".
3. **A handle that could block a name query** (a synchronous pipe with a read pending; a disk file with a long
   synchronous wait): the read returns, or the reader's 3 s kill makes it unknown. Tests: Task 1
   `a_pipe_with_a_pending_read_is_skipped_and_the_read_returns`; Task 2 "a run that timed out is null, even with output".
4. **Many Codex processes, or harness-pty failing:** unknown with `externalReadFailed`, never "nothing open" (which
   would let an adoption through). Test: Task 3 "past 32 Codex processes or a failed read says unknown".
5. **A process harness-pty may not open or read** (System, the idle process, one that exited, a 32-bit one's folder):
   left out, or listed without a folder, never "holds nothing". Tests: Task 1 `processes_it_may_not_open_so_are_left_out`,
   `a_32_bit_process_has_no_folder`, the exited child in `a_childs_folder_is_named_as_windows_resolves_it`; Task 2 "a pid
   absent from the rows is absent from the map".

---

### Task 1: `harness-pty files --json`

**Depends on:** none. **Effort:** xhigh (reads other processes' handles and memory through `unsafe` FFI).
**Test that must fail first:** on the Mac, `open_files.rs`'s pure tests and `cli.rs` "parses_files" (no module, no
variant). The Windows tests compile and run only in `windows.yml`.

**Files:**
- Create: `P/open_files.rs` (the module doc says what it reads, the rights, and why never `NtQueryObject`)
- Modify: `P/lib.rs` (`pub mod open_files;`), `P/cli.rs` (`Command::Files`, parse, `files()`, `USAGE`, module doc),
  `pty/Cargo.toml` (add `"Win32_System_Diagnostics_Debug"` for `ReadProcessMemory`; `Cargo.lock` does not change)
- Test: `P/open_files.rs` (`#[cfg(test)] mod tests`, and the Windows tests in its `#[cfg(windows)] mod windows`),
  `P/cli.rs` tests

**Interfaces:**
- Produces, the command (Task 2's contract): `harness-pty files --json <pid>…`, 1 to 32 positive pids, each read once,
  first-seen order. On Windows, exit 0 and
  `{"rows":[{"pid":421,"startMarker":"w:134087000000040000","cwd":"C:\\work\\dial","files":["C:\\Users\\someone\\.codex\\sessions\\2026\\11\\27\\rollout-…-<uuid>.jsonl"]}]}`,
  rows in the order asked, `cwd` absent when unknown, a pid left out as below. Elsewhere `{"unsupported":true}`, exit 3.
  A usage error exits 2 (the existing path).
- Produces, in `P/open_files.rs`: `pub const MAX_PIDS: usize = 32; pub const MAX_HANDLES: usize = 65_536; pub const
  MAX_FILES: usize = 4096; pub const MAX_PATH_UNITS: usize = 32 * 1024;`
  `#[derive(Debug, Clone, Serialize, PartialEq, Eq)] #[serde(rename_all = "camelCase")] pub struct OpenFilesRow { pub
  pid: u32, pub start_marker: String, #[serde(skip_serializing_if = "Option::is_none")] pub cwd: Option<String>, pub
  files: Vec<String> }`;
  `pub fn dos_path(final_path: &[u16]) -> Option<String>` (`\\?\UNC\` → `\\`, `\\?\` → nothing, anything else as is;
  `None` only for invalid UTF-16);
  `pub fn collect(paths: impl IntoIterator<Item = String>) -> Option<Vec<String>>` (each once, sorted; `None` past
  `MAX_FILES`);
  `#[cfg(windows)] pub fn read(pids: &[u32]) -> Vec<OpenFilesRow>`.
- Consumes: `crate::ps::{process_exited, process_started}` (the `pub(crate)` re-exports in `P/ps.rs`), `crate::ps`'s
  `w:<FILETIME>` marker form.
- `read`, per pid: pid 0, or `OpenProcess` with the three rights failing → left out. `process_exited(h, false)` → left
  out; `process_started(h)` none → left out; else `start_marker = format!("w:{created}")`. Handles:
  `NtQueryInformationProcess(ProcessHandleInformation)` (51, `Wdk_System_Threading`) into a buffer grown on
  `STATUS_INFO_LENGTH_MISMATCH` (at most 3 tries, as `ps.rs` `command_line`), the snapshot and its entries as local
  `#[repr(C)]` structs (`PROCESS_HANDLE_SNAPSHOT_INFORMATION { NumberOfHandles: usize, Reserved: usize, Handles: [ENTRY]
  }`, `PROCESS_HANDLE_TABLE_ENTRY_INFO { HandleValue: HANDLE, HandleCount: usize, PointerCount: usize, GrantedAccess:
  u32, ObjectTypeIndex: u32, HandleAttributes: u32, Reserved: u32 }`); a failed query or more than `MAX_HANDLES` → left
  out. Each handle: duplicate (Global Constraints), skip when that fails, keep only `FILE_TYPE_DISK` and not a
  directory (`GetFileInformationByHandleEx(FileStandardInfo)`), name it with `GetFinalPathNameByHandleW(…,
  VOLUME_NAME_DOS)` into a `MAX_PATH_UNITS + 1` buffer: 0 → skip that file, longer than the buffer → row left out,
  `dos_path` `None` → skip that file. `collect` `None` → row left out. Folder: none when `IsWow64Process` says TRUE;
  else `ProcessBasicInformation` → `PebBaseAddress` → `ReadProcessMemory` of `PEB.ProcessParameters` → the 8 bytes at
  parameters + `0x48` (`CURDIR.Handle` in the 64-bit `RTL_USER_PROCESS_PARAMETERS`; harness-pty ships x64 and arm64
  only, so guard with `#[cfg(target_pointer_width = "64")]`) → duplicate → must be a directory → named as a file is.
  Any step failing: no `cwd`, the row kept.

- [ ] **Step 1: Write the failing tests.**
  - `open_files.rs` (every platform): `dos_path_names_a_path_as_node_realpath_does` (`\\?\C:\work\dial` →
    `C:\work\dial`; `\\?\UNC\srv\share\x` → `\\srv\share\x`; `C:\x` unchanged; a lone surrogate → `None`);
    `collect_keeps_each_path_once_and_refuses_past_the_bound` (4096 distinct plus repeats → `Some`, sorted, 4096 long;
    4097 distinct → `None`); `a_row_serializes_in_the_daemons_field_names` (keys `pid`, `startMarker`, `cwd`, `files`;
    no `cwd` key when `None`).
  - `cli.rs` `parses_files`: `files --json 7 8` → `Files { pids: vec![7, 8] }`; `files --json 8 7 8` → `[8, 7]`; 32
    distinct pids taken; refused: `files`, `files --json`, `files 7`, `files --json 0`, `files --json x`,
    `files --json 7 --x`, 33 distinct pids.
  - `open_files.rs`, Windows only (compare paths with `std::fs::canonicalize(..)` and `\\?\` trimmed by hand, never with
    `dos_path`):
    - `lists_a_file_this_process_holds_and_its_folder`: a file held open in a temp folder is in `files`; `cwd` is this
      process's folder; `start_marker` equals this process's row in `ps::snapshot()`.
    - `a_file_closed_before_the_read_is_not_listed`.
    - `a_pipe_with_a_pending_read_is_skipped_and_the_read_returns`: `CreatePipe`; a thread says on a channel that it is
      about to read, then blocks in `ReadFile`; `read(&[own pid])` three times, each on a thread awaited with
      `recv_timeout(10 s)` (fail, never hang); every `files` entry starts with a drive letter or `\\`; then one byte
      written ends the read and the thread is joined.
    - `a_childs_folder_is_named_as_windows_resolves_it`: `ping.exe -n 30 127.0.0.1` started in a temp subfolder
      `Work Dial` given upper-cased → its `cwd` is the folder in its on-disk case and long name; its marker equals its
      `ps::snapshot()` row's; killed and waited (its `Child` still holding the handle) → `read(&[pid])` is empty.
    - `a_32_bit_process_has_no_folder`: `%SystemRoot%\SysWOW64\PING.EXE` (present on both runners' images) → its row
      is listed with `cwd: None`.
    - `processes_it_may_not_open_so_are_left_out`: `read(&[0, 4])` is empty.
    - `a_read_is_quick`: the fastest of 5 reads of this process under 500 ms; `eprintln!("files: {n} files in
      {took:?}")` (the number before the VM's).
- [ ] **Step 2: Run** `cargo test --locked open_files parses_files` on the Mac. Expected: FAIL (no `open_files`, no
  `Command::Files`).
- [ ] **Step 3: Implement** the module, `files()` in `cli.rs` (as `ps()`: Windows prints `{"rows": rows}`, elsewhere
  `{"unsupported":true}` and exit 3), `USAGE` gains `| files --json <pid>…`, the module doc lists `files`.
- [ ] **Step 4: Run** `cargo test --locked` on the Mac. Expected: PASS. The Windows tests run in PR CI's `windows.yml`
  (`cargo test --locked --target …`, x64 and arm64): each passes, and each leg prints a `files:` line.
- [ ] **Step 5: Commit** red, then green: `harness-pty: files --json lists a process's open disk files and its folder
  on Windows`.

### Task 2: The reader in `lib/windows`

**Depends on:** none (Task 1's contract is above). **Effort:** high. **Test that must fail first:** `W/openFiles.spec.ts`.

**Files:**
- Create: `W/openFiles.ts`, `W/openFiles.spec.ts`

**Interfaces:**
- Consumes: `WindowsProcessRowsOptions`, `WindowsPsRun` (`W/processTable.ts`), `ptyHostBinary` (`lib/ptyHost/launch.ts`),
  `patientExec` (`lib/patientExec.ts`), `windowsStartTime` (`W/treeKill.ts`).
- Produces: `export const WINDOWS_FILES_TIMEOUT_MS = 3_000`, `WINDOWS_FILES_MAX_PIDS = 32`,
  `WINDOWS_FILES_MAX_BUFFER = 4 * 1024 * 1024`, `WINDOWS_FILES_MAX_PER_PID = 4096`, `WINDOWS_PATH_MAX_UNITS = 32 * 1024`;
  `export interface WindowsOpenFiles { startMarker: string; cwd?: string; files: string[] }`;
  `export type WindowsFilesRead = (pids: readonly number[]) => Promise<Map<number, WindowsOpenFiles> | null>`;
  `export function windowsOpenFilesRows(value: unknown, asked: ReadonlySet<number>): Map<number, WindowsOpenFiles> | null`;
  `export function windowsOpenFiles(pids: readonly number[], options?: WindowsProcessRowsOptions): Promise<Map<number, WindowsOpenFiles> | null>`.
- Rules: no pids → empty map, no run; more than 32 distinct → `null`, no run; no binary (or its lookup throws) → `null`.
  Runs `[binary, ['files', '--json', ...distinct pids]]` with `{ timeout: 3_000, maxBuffer: 4 MiB, windowsHide: true }`.
  Any `error` (exit code, timeout, buffer) → `null`, whatever was printed; output that is not JSON or has no `rows`
  array (`{"unsupported":true}`) → `null`. A row is dropped when: its pid is not a positive safe integer or was not
  asked; `startMarker` is not a `w:<FILETIME>` (`windowsStartTime` reads it); `files` is not an array of strings, holds
  more than 4096, or one longer than 32 Ki units; `cwd` is present and not a string of at most 32 Ki units. A pid's
  first row wins. Rows parsed but empty → an empty map (each pid unknown). No logging here: the callers log.

- [ ] **Step 1: Write the failing tests** in `W/openFiles.spec.ts`, with a fake `run` (`vi.fn<WindowsPsRun>`) and
  `binary: () => 'C:\\h\\harness-pty.exe'`:
  - "runs harness-pty files --json for the pids asked, hidden, within 3 s and 4 MiB" (args `['files', '--json', '421',
    '430']` for `[421, 430, 421]`; options contain the three values) and maps two rows, one with `cwd`, one without.
  - "drops a malformed row and a row past a bound" (each drop rule above, one row each, beside a good row that stays).
  - "a pid absent from the rows is absent from the map, and empty rows are an empty map".
  - "no pids: an empty map, nothing run; more than 32: null, nothing run".
  - "null when there is no binary, it fails, it prints something else, or it throws".
  - "a run that timed out is null, even with output" (`done(timeoutError, '{"rows":[]}', '')`).
  - "runs it for real when no runner is given: a binary that is not there is null".
- [ ] **Step 2: Run** `npx vitest run src/lib/windows/openFiles.spec.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `W/openFiles.ts` (module doc: what it runs, unknown is never nothing, as
  `processTable.ts`).
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** red, then green: `Windows: a reader for harness-pty files, unknown on any failure`.

### Task 3: `processView` and `processCwds` read it on win32

**Depends on:** 2. **Effort:** high (admission reads this: unknown must never read as nothing). **Test that must fail
first:** the `support.spec.ts` cases below (today win32 answers empty maps without spawning).

**Files:**
- Modify: `X/support.ts` (`processView`, `processCwds`, their doc comments)
- Test: `X/support.spec.ts` (the case "reads no tty, cwd or open file on Windows, and runs neither ps nor lsof" is
  replaced by the cases below; its `processTtys` win32 assertion moves into the last one)

**Interfaces:**
- Consumes: `windowsOpenFiles`, `WindowsFilesRead`, `WINDOWS_FILES_MAX_PIDS` (Task 2).
- Produces: `processCwds(pids, exec = run, os = process.platform, link = readlink, files: WindowsFilesRead =
  windowsOpenFiles)`: on win32, more than 32 pids or a `null` read → empty map and `externalReadFailed(error, 'process
  files')`; else each row's `cwd`. Never `ps` or `lsof` there.
- Produces: `processView(exec = run, alive = processAlive, list: () => Promise<Array<RunningProcess & { startMarker?:
  string }>> = listProcesses, cwds?: (pids: readonly number[]) => Promise<Map<number, string>>, platform =
  process.platform, files: WindowsFilesRead = windowsOpenFiles): ProcessView`. On win32 the view wraps `files` in a
  per-view memo (each pid asked once a view; the pids not yet asked in one call go in one run; a failed run answers
  `null` for its pids). `openFilesOf(commands)`: from `list()`, the rows with a start marker whose image name (win32
  basename, `.exe` dropped, lower-cased) starts with a command lower-cased; none → empty map, no run; more than 32 →
  empty map and `externalReadFailed`; else the memo, `null` → empty map and `externalReadFailed`, and only rows whose
  `startMarker` equals the table row's. `cwds`: the given one, else `processCwds(pids, exec, platform, readlink, memo)`.
  `openFiles` stays empty on win32. macOS and Linux unchanged.

- [ ] **Step 1: Write the failing tests** (fake table: `Code.exe` 400, `pwsh.exe` 409, `node.exe` 420, `codex.exe` 421
  (TUI), `codex.exe` 430 (daemon), each with a `w:` marker; a fake `files` spy; `exec` recording calls):
  - "on Windows asks harness-pty files for the Codex processes alone, once a view, and keeps what the table vouches
    for": `openFilesOf(['codex', 'Codex'])` → `{421: [], 430: [ROLLOUT]}`, `files` called `[[421, 430]]`; then
    `view.cwds([421])` → `{421: 'C:\\work\\dial'}` with no new call; `view.cwds([420])` → one call `[[420]]`;
    `view.openFiles([421])` → empty, no call; `exec` never called.
  - "on Windows drops a row whose start marker is not the table's: its pid was reused between the reads" (430 answered
    with `w:9`).
  - "on Windows spawns nothing with no Codex running, and past 32 Codex processes or a failed read says unknown, never
    nothing open": no `codex*.exe` → empty, no call; 33 → empty, no call, and `externalEvidence(() =>
    view.openFilesOf([...]))` is `{ ok: false, detail: "The conversation's process files could not be verified." }`;
    `files` → `null` → empty and the same evidence.
  - "on Windows matches a command as a prefix of the image name, in any case, as lsof -c does" (`Codex.EXE`,
    `codex-acp.exe` in; `node.exe`, `xcodex.exe` out).
  - "on Windows reads each folder from harness-pty files, never ps or lsof, and reads no tty": standalone
    `processCwds([7, 8], exec, 'win32', undefined, files)` → `{7: 'C:\\work\\dial'}` (8 has no `cwd`); `[]` → no call;
    33 pids → no call and failed evidence; `null` → empty and failed evidence; `processTtys([7], exec, 'win32')` empty;
    `exec` never called.
- [ ] **Step 2: Run** `npx vitest run src/lib/sessionSearch/externals/support.spec.ts`. Expected: FAIL (empty maps, no
  `files` call).
- [ ] **Step 3: Implement** the signatures above; the doc comments of `processCwds` and `processView` say what Windows
  reads now and why unknown is never nothing.
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS (the macOS and Linux cases unchanged).
- [ ] **Step 5: Commit** red, then green: `Dial on Windows: the open scan reads which Codex holds a rollout, and a
  process's folder, through harness-pty`.

### Task 4: `codexServed` on Windows

**Depends on:** none (until Task 3 lands, `processCwds` on win32 is empty and a lookup finds no client: a state inside
the branch only). **Effort:** high. **Test that must fail first:** the `codexServed.spec.ts` cases below.

**Files:**
- Modify: `H/codexServed.ts` (header comment, `CodexServedDeps`, `codexServed`, `clientsIn`, `servedLookup`),
  `H/observed.ts` (the `ObservedDeps.served` doc comment alone: no longer "Absent (Windows, …)")
- Test: `H/codexServed.spec.ts`

**Interfaces:**
- Consumes: `WindowsProcess` (`H/scannedApp.ts`), `processCwds` (as today).
- Produces: `CodexServedDeps.processes(): Promise<readonly (RunningProcess & { startMarker?: string })[]>`;
  `CodexServedDeps.apps(pids: readonly number[], rows: readonly WindowsProcess[])`; `names` keep each row's
  `startMarker` when it has one. `clientsIn` on win32 never calls `deps.tty`: every candidate in the session's folder
  counts as on a terminal, exactly one is the client, `{ app, pid }` (no `tty`); a folder not read is none (as today).
  `servedLookup(platform)` returns the lookup on every platform (win32 included; deps unchanged: `processes:
  listProcesses, cwds: processCwds, tty: readTtyName, apps: learnApps, folder: folderKey`).

- [ ] **Step 1: Write the failing tests** in a `describe('codexServed on Windows')` with Windows rows (`Code.exe` 400 →
  `Code.exe` 401 → `pwsh.exe` 409 → `node.exe` 420 (npm's `codex.js`) → `codex.exe` 421 → `codex.exe app-server --listen
  unix:// --analytics-default-enabled` 430; markers rising in that order), `platform: 'win32'`, `apps` = `scannedApps`
  with `platform: 'win32'` over the names given, `folder: async (p) => p`, `tty` a spy:
  - "the one TUI in the session's folder is the client, with no terminal read: Windows names none" → `[{ client: { app:
    'vscode', pid: 420 } }]`; `tty` not called; `cwds` called `[[420]]`.
  - "its folder unread, none; two TUIs there, none" → `[{}]` each (a second VS Code terminal 410 → 440/441 in the same
    folder).
  - "the daemon's parent is the first TUI, in Windows Terminal: the client in VS Code places it" (430's parent a
    `WindowsTerminal.exe` → `pwsh.exe` → `node.exe` 520 → `codex.exe` 521 in `C:\work\other`) → `client: { app:
    'vscode', pid: 420 }`.
  - "the first TUI gone, its pid taken by a later VS Code: the daemon is still the daemon" (430's parent 405 is a
    `Code.exe` whose marker is after 430's) → `client: { app: 'vscode', pid: 420 }` (today `[undefined]`).
  - `servedLookup` case: "reads this machine on every platform" (`'win32'` gives a function too).
- [ ] **Step 2: Run** `npx vitest run src/cable/hosts/codexServed.spec.ts`. Expected: FAIL (tty read, `{}`,
  `[undefined]`, `servedLookup('win32')` undefined).
- [ ] **Step 3: Implement**; the header and `servedLookup`'s comments say Windows reads folders through harness-pty and
  counts every TUI as on a terminal; the cost line says Windows' numbers come from the VM (spec, Cost).
- [ ] **Step 4: Run** the spec and `npm run typecheck`. Expected: PASS (the macOS cases unchanged).
- [ ] **Step 5: Commit** red, then green: `Dial on Windows: a Codex session its daemon runs is placed by its one TUI in
  the session's folder`.

### Task 5: The real host's rows match the reader and `folderKey`

**Depends on:** 1, 2. **Effort:** high (the contract between two components built apart). **Test that must fail
first:** none locally: the spec is skipped off Windows or without `HARNESS_PTY_BIN`; its first run is `windows.yml`'s
(its step "Contract suite against the real host, and the Windows CLI specs" runs `src/lib/windows/` against the release
`harness-pty.exe`). Test only: one commit.

**Files:**
- Create: `W/openFiles.windows.real.spec.ts` (header: how to run it by hand on Windows, as
  `W/processControl.real.spec.ts`'s)

- [ ] **Step 1: Write the spec**, enabled when `process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN`:
  - "lists a file this process holds and its folder, as the PTY host's table and folderKey name them": a file held open
    in a `mkdtemp` folder (the runner's TEMP may be an 8.3 name) → `windowsOpenFiles([process.pid])`'s row has
    `realpathSync.native(file)` in `files`, `cwd === await folderKey(process.cwd())`, and `startMarker` equal to this
    pid's row in `windowsProcessRows(null)`; closed and read again → not listed.
  - "names a folder as folderKey does": `ping.exe -n 30 127.0.0.1` spawned (`windowsHide: true`) with `cwd` the temp
    folder upper-cased → its `cwd === await folderKey(dir)`; killed, then read → no row.
- [ ] **Step 2: Run** `npx vitest run src/lib/windows/openFiles.windows.real.spec.ts` on the Mac. Expected: skipped.
- [ ] **Step 3: Commit:** `Windows: harness-pty files' rows match the reader and folderKey on the real host`. Its
  evidence is the PR's `windows.yml` run on x64 and arm64.

### Task 6: The scan and the hooks on Windows, end to end in the source

**Depends on:** 3, 4. **Effort:** high. Test only (no behavior of its own): one commit, with the red shown against the
base's sources.

**Files:**
- Test: `H/observed.spec.ts` (a new `describe('ObservedSource and a Codex on Windows after a restart')` beside the
  #4634 block, with its `process.platform` stub)
- Modify `H/observed.ts` only if a case fails for a reason Tasks 3 and 4 do not cover; then it is a behavior change:
  say so, red then green.

**Interfaces:**
- Consumes: `processView`, `processCwds` (Task 3); `codexServed` (Task 4); `codexProvider` (`X/codex.ts`);
  `OpenSessions`, `SessionRows`; `learnApps`; `createVscodeAdapter`, `createVscodeClientAdapter`.
- Fixture: a temp Codex home with `sessions/2026/11/27/rollout-2026-11-27T09-00-00-<THREAD>.jsonl` (`session_meta` with
  `id: THREAD`, `cwd: 'C:\\work\\dial'`, `source: 'vscode'`, `originator: 'codex-tui'`; then a `task_complete` event);
  the Windows rows of Task 4 with `startMarker`s (VS Code's TUI 420/421, the daemon 430, Windows Terminal's 520/521); one
  fake `files` reader serving both the view and `processCwds` (420, 421: `cwd 'C:\\work\\dial'`; 430: the rollout's
  temp path in `files`; 520, 521: `C:\\work\\other`); `OpenSessions({ view: () => processView(undefined, alive, async ()
  => rows, undefined, 'win32', files), ttys: Windows' nulls, harnessTtys: async () => new Set() })`; `setup({ platform:
  'win32', …, apps: learnApps over the tree, served: (asks) => codexServed(asks, { platform: 'win32', processes: async
  () => rows, cwds: (pids) => processCwds(pids, undefined, 'win32', undefined, files), tty: spy, apps: (pids, names) =>
  learnApps(pids, names, undefined, 'win32'), folder: async (p) => p }) })`; adapters `vscode` and `vscode-tab`.

- [ ] **Step 1: Write the cases:**
  - "the daemon holds the rollout: on VS Code's page at its TUI's terminal" → one agent `{ sessionId: THREAD, app:
    'vscode' }`, no `appPending`, `paneOf(id, 'vscode-tab') === 'client:420'`, `paneOf(id, 'vscode')` undefined, the log
    `/^\[observed\] scan · 1 found · 1 app known · /`, the lookup's `tty` never called.
  - "the TUI holds it itself: on VS Code's page at its terminal" (no daemon row; 421 holds it) → `paneOf(id, 'vscode')
    === 'term:421'`.
  - "two TUIs in its folder: on no app's page, never a guess" → `app: 'terminal'`, neither pane.
  - "the daemon's parent is a TUI in Windows Terminal: VS Code's page, never the daemon's parents'" → `client:420`.
  - "the daemon's hooks keep it at its client, whatever the first TUI's hints say" (decision 1): after the last case's
    scan, `session-start`, `turn-start`, `turn-stop` from caller 430, `cwd: 'C:\\work\\dial'`, hints `{ WT_SESSION:
    '0b5f…' }` → after each, `app: 'vscode'` and `client:420`; the app read by `onChange` never leaves `'vscode'`.
  - "a daemon's first hook, the scan not run: on no page while asked, then VS Code's" → `appPending` while the lookup
    runs, then `client:420`.
- [ ] **Step 2: Show red against the base**, with no stash (shared): `git show 5eca6c7253:cli/src/lib/sessionSearch/externals/support.ts
  > src/lib/sessionSearch/externals/support.ts`, the same for `src/cable/hosts/codexServed.ts`; run `npx vitest run
  src/cable/hosts/observed.spec.ts -t 'a Codex on Windows'`. Expected: FAIL (0 found; no client). Restore with `git
  checkout HEAD -- src/lib/sessionSearch/externals/support.ts src/cable/hosts/codexServed.ts`.
- [ ] **Step 3: Run** `npx vitest run src/cable/hosts/observed.spec.ts`. Expected: PASS, the whole file.
- [ ] **Step 4: Commit:** `Dial on Windows: the scan and a daemon's hooks put a Codex on VS Code's page at its
  terminal (tests)`.

### Task 7: Docs

**Depends on:** 1, 3, 4 (the docs name what they built). **Effort:** medium. **Test that must fail first:** none: docs,
one commit.

**Files:**
- Modify: `cli/AGENTS.md`, `docs/windows-rules.md`

- [ ] **Step 1: `cli/AGENTS.md`**, the devices row's Codex daemon clause: "the folder of each Codex TUI (on macOS one
  `lsof -a -d cwd` for them all, on Linux `/proc/<pid>/cwd`)" gains "on Windows one `harness-pty files --json` for them
  all"; "one `ps -o tty=` for each in the session's folder and that TUI's parents, on macOS and Linux, never on Windows"
  becomes the `ps -o tty=` off Windows, where every TUI counts as on a terminal since Windows names none. The row's
  Windows list, after "`harness-pty ps --json --ancestors` (`cli/hook/notify.mjs`)", gains: the open scan's Codex
  owners and the TUIs' folders read by `harness-pty files --json` (at most 32 processes; each one's open disk files,
  at most 4096, and its working folder; handles named only when Windows says disk; nothing kept but in memory, nothing
  logged) (`lib/windows/openFiles.ts`, `lib/sessionSearch/externals/support.ts`).
- [ ] **Step 2: `docs/windows-rules.md` §3,** after "There is no `ps`": "There is no `lsof`." A process's open files
  and folder come from `harness-pty files --json` (`lib/windows/openFiles.ts`); a read that could not run is unknown,
  never "nothing open": `processView` answered an empty map without spawning, so the open scan never found a running
  Codex after a restart (Ken's VM, 2026-11-26). Name a handle only when `GetFileType` says disk: `NtQueryObject` hangs
  on a synchronous pipe. Tests: `X/support.spec.ts` (the "on Windows" cases), `P/open_files.rs`.
- [ ] **Step 3: Commit:** `docs: Windows reads a process's open files and folder through harness-pty files`.

---

## Verification

1. **Types:** `cd cli && npm run typecheck`. Expected: no error.
2. **Unit specs touched** (local, no slot needed outside an eval): `npx vitest run src/lib/windows/openFiles.spec.ts
   src/lib/windows/openFiles.windows.real.spec.ts src/lib/sessionSearch/externals/support.spec.ts
   src/cable/hosts/codexServed.spec.ts src/cable/hosts/observed.spec.ts`. Expected: pass; the real spec reports
   skipped on the Mac.
3. **Rust on the Mac:** `cd pty && cargo test --locked`. Expected: pass (pure helpers, parse). The Windows code compiles
   only in `windows.yml`.
4. **The repo's local check for `pty/*`** (PR CI does not run it): `python3 scripts/local-checks.py --run` from a clean
   tree at the final commit selects `cli-pty` (`npm run test:terminal-contract`, macOS); paste its receipt into the PR
   body. Wait for the PM's go (shared Mac, never beside an eval). `npm run test:core`: not needed, no task touches
   `cli/src/core/` or `cli/src/services/`.
5. **PR CI (automatic, GitHub):** `pty-checks` (Linux `cargo test`: the pure helpers and the `unsupported` path);
   the CLI's Linux unit checks (`src/architecture.spec.ts` among them: the core's process loads no new file);
   `windows-e2e` → `.github/workflows/windows.yml` on x64 and arm64 (`pty/` is Windows-only code to
   `scripts/ci-plan.py`): `cargo test --locked --target …` runs Task 1's Windows tests (read each leg's `files:` line),
   and "Contract suite against the real host, and the Windows CLI specs" runs `src/lib/windows/` with the release
   `harness-pty.exe`, Tasks 2 and 5 included. `windows.yml` is also `workflow_dispatch`, but no extra run is started.
6. **No local end-to-end:** none applies. The fake-engine e2e cannot run Windows on this Mac, and `windows.yml`'s dial
   e2e has no stand-in Codex. Proposal for later PRs, not in this one: a stand-in `codex.exe` holding a rollout in
   `cli/e2e/dialWindows.e2e.ts` would run spec step 6 on every Windows PR.
7. **Windows VM, held for the user** (the PM through Ken; Windows 11 ARM64 VM; one VM at a time): the spec's "VM steps
   for Ken", 1-4 on today's release and 5-10 on the PR's head, with a test account (Codex signed in to a test account,
   or a stub provider at a local `OPENAI_BASE_URL`), never a real person's; Harness from the PR's build with its own data
   folder; no Harness agent running. A person sees: `[observed] scan · 1 found · 1 app known · …` within 70 s and the
   Codex on VS Code's page before any hook (6); a tap brings VS Code to that terminal (7); the Windows Terminal Codex on
   Other's page, neither on the other's (8); `codex --no-daemon` on VS Code's page (9); two in one folder on no app's
   page, back at the next hook (10). Step 5 gives `harness-pty files` in ms for the daemon and the TUI (target under
   50 ms). Counts and ms only, no paths or command lines.
8. **The PR body says:** platforms (Windows x64 and arm64 changed; macOS and Linux unchanged, their paths identical);
   the receipts and numbers above; that on Windows ⌘P and the welcome page now see a running Codex session as open in
   an app, the open scan counts Harness's own Codex panes too (shown once, Harness's, in the dial's merged list), and an
   adoption of a Codex session open outside Harness now holds, as #4634 made so for Claude Code.

## Questions answered (PM, 2026-11-27)

1. **A Codex on no terminal counts on Windows.** Keep the spec's rule: every Codex TUI candidate counts on Windows; two
   candidates in the session's folder (a `codex queue` or `codex exec` among them) place it on no page, never a wrong one.
2. **The same cause elsewhere.** `lib/openclawStore.ts` and `lib/captureResumeIdentity.ts` stay out of this PR; the PM
   keeps them in the backlog.
