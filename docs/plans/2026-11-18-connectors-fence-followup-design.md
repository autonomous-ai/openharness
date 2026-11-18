# Connections upload fence: identity, not spelling

Follow-up to #4442 (`cli/src/lib/connectors/call.ts`). `harness connections call ... --form k=@path` uploads a local
file with a connected account's token. The fence refuses a file inside a folder where credentials or configs live.
#4442 made the fence compare the file system's own spelling of both paths; its review left four gaps.

## Intent

The fence must hold however the caller names the file and whatever environment it runs the command with: the caller
shapes the arguments and the environment, never the file system or the registry. Every case of the same cause is
closed: "the fence decides by a name the caller can shape".

## Gaps

1. **Windows folder redirection.** AppData moved elsewhere (a Group Policy or a user's own move) is known today only
   through `APPDATA`/`LOCALAPPDATA`, which the caller can unset.
2. **Check, then read.** `uploadPath` checks one path, `multipart` later reads it by name: the file can be swapped in
   between.
3. **Case-folded folders on Linux** (ext4/f2fs casefold): `realpath` keeps the spelling given, so `~/.SSH` passes a
   string compare with `~/.ssh`.
4. **Shares.** The fence opens a forbidden folder named by the environment to resolve it, so a variable set to a share
   makes Windows connect to it; a relative path from a working folder on a share is not seen as a share before it is
   opened; a mapped drive (`Z:` to `\\server\share`) is an alias the string compare does not know.

## Goals

- "Inside a forbidden folder" is decided by **identity**: the file's ancestors, walked from its resolved path to the
  root, compared by `dev`+`ino` (bigint) with the forbidden folders' `dev`+`ino`. Case, 8.3 names, `\\?\` prefixes,
  `subst` and mapped drives, links and case-folded folders all reach the same identity.
- The bytes sent are the bytes of the file that was checked: open once, check the open file's identity, read from
  that descriptor.
- On Windows, the account's real AppData folders are found from the registry, never from the environment, once per
  process.
- The fence never opens a share it was not asked to upload from: every path (the file's and each forbidden folder's)
  is made absolute before the share check, and a forbidden folder on a share is dropped without being opened.
- Messages and exit codes stay as they are (exit 2, "not a media file the helper may send" / "cannot read upload").

## Non-goals

- No new forbidden folders beyond the AppData that redirection moves, and no change to the allowed suffixes.
- Uploading from a share stays refused, as #4442 decided.
- A writer that renames the credential folders themselves while the fence runs is out of scope: such a writer can copy
  the file out of the folder anyway. The guarantee is: the bytes sent belong to the file whose identity was checked,
  and at the check that file's ancestors held no forbidden folder.

## Anti-goals

- A fence that refuses ordinary uploads (a document in `~/Documents`, a file in Windows' own temporary folder) on any
  platform.
- A fence that opens or connects to a share to decide anything.
- A slower `harness connections call` for requests without an `@path` upload.

## Design

### Rule (all platforms)

`uploadFile(raw, env)` replaces `uploadPath`. It returns `{ name, content }` and `multipart` uses them; nothing reads
the path by name after the check.

1. Expand `~`. A share path (`unc` on that path, or on its `resolve()` against the working folder) is refused here,
   before anything is opened. `resolve()` serves this check only, and only Windows has shares: every later step uses
   the path as given after `~` expansion, so a `..` after a link goes where the kernel takes it.
2. Suffix check on that path (string only), so nothing that is not a media file or document is opened.
3. Open it read-only (`O_NONBLOCK` on posix, so a FIFO never blocks the open); `fstat` the descriptor (bigint). Not a
   regular file: refused.
4. `realpathSync.native` of the path; a share result (a mapped drive resolves to one) is refused; the suffix check
   again on the result; `stat(real)` must have the descriptor's `dev`+`ino`, else refused (the path moved), and one
   link, else refused (a hard link made after the open may be the name `realpath` took).
5. Walk `real`'s ancestors upward (`stat`, bigint). An ancestor whose identity is a forbidden folder's: refused. The
   temporary folder's identity reached first: stop, allowed (the rule #4442 set: inside Windows' temporary folder,
   only a forbidden folder inside it fences the file). An `ino` of `0` refuses below the root only (see the calls).
6. Read the content from the descriptor; close it in every case.

Forbidden folders: as today (`forbiddenDirs`: HOME, USERPROFILE, `os.homedir()` and the account's home from
`userInfo`, the connections folder, `/etc`, `/proc`, `/sys`, Windows' AppData under each home, `APPDATA`,
`LOCALAPPDATA`), plus the registry's AppData folders on Windows. Each is resolved absolute; one on a share is dropped
unopened; the rest are `stat`ed (bigint, following links, so a link to a folder fences its target); a missing one is
skipped. The string-based `inside` and `fenced` go: identity replaces them.

### Windows known folders (gap 1)

Read `AppData` and `Local AppData` from `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`
(and `...\Shell Folders`, which holds them already expanded) with `reg.exe query`, once per process, cached, only
when an upload is checked on Windows. Both queries run in one `cmd.exe /d /s /c` started by its full path in System32,
which first sets its console to UTF-8 (`chcp.com 65001`, as `cli/src/lib/uninstall/removal.ts` does), so a folder with
any letter is read as written; `chcp.com` and `reg.exe` run by their full paths too. `%USERPROFILE%` in a value is expanded with the account's home from `userInfo`
(the token's profile, not the environment); a value with any other unexpanded variable is skipped in favour of the
`Shell Folders` value. These tools run from the system folder found without the environment (for instance the
resolved `\\?\GLOBALROOT\SystemRoot`, else the fixed `C:\Windows\System32`), never through `PATH` or an environment
variable; how is the builder's, verified on Windows CI. The run has a timeout. If the run cannot start, times out or
fails a key query, the fence does not refuse every upload (UX first, orchestrator 2026-11-18): it falls back to the
deny list without the registry (`AppData` under each home, which covers Roaming, Local and LocalLow, plus `APPDATA`
and `LOCALAPPDATA`) and writes one line to stderr naming the failure, with no path.

Cost: one short `cmd.exe` run (it runs `chcp.com` and two `reg.exe`) on Windows per `harness connections call` with
an `@path` upload; none otherwise. The
number before and after goes in the PR.

### Platforms

Windows, macOS, Linux. Windows tests run in `windows.yml` (`call.spec.ts` is listed there); posix in PR CI.

## Tests (red first)

- Gap 3: on a case-insensitive file system (macOS), with `realpathSync.native` stubbed to keep the spelling given (as
  Linux does in a case-folded folder), `~/.SSH/note.txt` is refused. A unit test of the walk with injected identities
  runs everywhere.
- Gap 2: the file is swapped for a link into `.ssh` between the check and the read (an `fs` hook on open/read): the
  upload is refused or sends the checked file's bytes, never the swapped one's.
- Gap 1 (Windows CI): the registry's AppData folder is fenced with `APPDATA`/`LOCALAPPDATA` unset; a temporary HKCU
  key holding a value with `ö` is read back exactly through the reader, and deleted in `finally`; a unit test with
  an injected registry reader runs everywhere (redirected to `D:\Redirect\Roaming`, `%USERPROFILE%` expansion, a
  value with another variable).
- Gap 4: a forbidden folder from the environment set to a share is never opened (stubbed `stat`/`realpath` record no
  share path); a relative path from a working folder on a share is refused before it is opened; on Windows CI a
  `subst` drive onto `home` reaching `.ssh` is refused.
- Every #4442 test keeps passing (temp folder rule, hard link, junction, `\\?\`, 8.3, share spellings).

## Data

N/A: nothing is stored, synced or exposed; the change narrows what an existing command reads.

## Approaches

1. **Identity walk + open-once + registry (chosen).** One rule for case, 8.3, prefixes, drives and links; closes the
   swap by reading the checked descriptor. Costs a few `stat`s per upload and one `reg.exe` on Windows.
2. **Keep string compare, add normalisation** (case-fold names on Linux, expand drive maps). Every alias needs its own
   rule; casefold is per folder, unknowable from a string. Rejected.
3. **Native addon for `SHGetKnownFolderPath`/`GetDriveType`.** Exact, but a native module for one check, against the
   architecture rule (no new language or build). Rejected.

## Calls made after the builder check

- **Links and mapped drives to a share.** The share check is on strings (`unc` on the absolute path) and that is
  enough: the caller shapes arguments and the environment, not the file system. A local link to a share, or a mapped
  drive, exists only if someone made it, and a mapped drive's connection is already open. A file reached that way is
  refused at step 4 (its resolved path is a share); a forbidden folder reached that way is `stat`ed like any other.
- **Identity where `ino` is unreliable.** `dev`+`ino` is trusted as Windows, git and Node trust it. An `ino` of `0`
  on the file or on any ancestor below the root (some FUSE and network file systems) refuses the upload ("cannot check
  upload"): no string fallback. The root is the exception: Windows' FAT driver gives a drive's root (a USB stick's, an
  SD card's) file ID `0`, so the root is still compared by `dev`+`ino` but not refused for it. The file is checked
  first, so a file system that gives every file `0` is still refused.
- **Temporary folder.** The temporary folders are `<account home>\AppData\Local\Temp` (as today) and, when it exists,
  `Temp` under every registry `Local AppData` that is fenced (both keys'); the walk stops allowed at the first of
  them.
- **Registry values.** Both keys' values are fenced (union): a stale `Shell Folders` value only fences an old AppData
  location. A missing value, or one with an unexpandable variable, is skipped (`home\AppData` stays fenced). A failed
  `reg.exe` falls back as the known folders section says; it never refuses the upload.
- **Reading the registry in UTF-8** (orchestrator, 2026-11-18). One `cmd.exe` run as the known folders section says.
  If the `ö` read-back is red on the real Windows runner, the fallback is two direct `reg.exe` runs, one per key: a
  value not in UTF-8 is then skipped, and the stderr line says a folder could not be read.
- **`resolve()` for the share check only** (orchestrator, 2026-11-18), on Windows; the file is opened, and
  `realpathSync.native` asked, with the path as given after `~` expansion.

## Left to the builder

- How the system folder for `reg.exe` is found without the environment, and the parsing of `reg.exe` output.
- Exact test hooks (module mocks as the spec already uses for `node:os` and `node:path`).
