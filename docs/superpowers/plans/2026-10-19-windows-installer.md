# Windows Native: `harness-install.exe` and Windows in the Desktop Release (sub-project F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on a Windows 10/11 PC presses **Download for Windows** on the website, opens the file, and gets the Harness desktop app installed and open; every `make release-desktop` ships Windows with macOS and Linux.

**Architecture:**
- `harness-install.exe` is a small Rust program (its own crate, `installer/`, GUI subsystem). It carries no app: it reads the desktop manifest, picks this PC's zip exactly as `install.ps1 -App` does, downloads it with WinINet, checks size and SHA-256, unpacks it with Windows' `tar.exe` and runs the zip's own `Harness.exe --install` (C), which does every install step.
- `release-desktop.yml` gains `build-windows` (x64 and arm64 runners) and `upload-windows` (ubuntu). The publisher, the public-download verification and the release candidates go from six artifacts to nine.
- The website's `/desktop` offers **Download for Windows** through a manifest-backed redirect, like the other platforms.

**Tech Stack:**
- Rust 2024, `windows-sys` 0.59, `serde_json`, `sha2`, `embed-resource` 3 (build only).
- Python 3 (release scripts, `unittest`), Bash, GitHub Actions.
- TypeScript: vitest in `cli/` (workflow and script specs) and `website/` (Next.js routes and React).
- Windows PowerShell 5.1 (one read-only E2E tool).

**Spec:** `docs/superpowers/specs/2026-10-19-windows-installer-design.md`. It builds on C (`docs/superpowers/specs/2026-10-18-windows-desktop-design.md`: `Harness.exe --install`, the zip, `install.ps1 -App`) and E (`docs/superpowers/plans/2026-10-19-windows-dial.md`: the x64 test PC's kit access).

**Where and when.** On `feat/windows-installer`, cut from `feat/windows-desktop`, and merged back into it after C5.3, with the owner's OK. It ships in the Windows PR with A, B and C. E (the dial) is built in parallel on `feat/windows-dial` and ships later, in its own PR (owner's decision, 2026-10-20). Branch commits and pushes of `feat/windows-installer` are authorized; never `main`, never force-push.

**How this plan was checked.** Every code block below was built and run before the plan was written, in a scratch worktree of this branch's head (`abb17043d`):
- `installer/`: `cargo test` on macOS (26 tests); `cargo clippy --all-targets` clean for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`; on the Windows 11 ARM64 VM (native `aarch64` build) 31 unit tests and the 6 integration tests in `tests/windows.rs` pass, and a release build is 538,624 bytes with no VCRUNTIME import and the version resource read back.
- `cli/src/scripts/installPs1App.spec.ts` with this plan's changes, on the same VM with the real `Harness.exe` and the real `harness-install.exe`: 9 of 9 pass, the two new installer cases included.
- `python3 -m unittest discover -s scripts/tests -p 'test_desktop_*.py'`: 79 pass. `publishDesktopWindowsStaging.spec.ts` 14, `uploadDesktopWindows.spec.ts` 5, `windowsWorkflows.spec.ts` 6, the website's `src/app/desktop src/app/download src/lib` 98; `actionlint` reports nothing new; `install-state.ps1` parses and runs on Windows PowerShell 5.1.
- Not run before this plan: the window (it needs a person at a signed-in desktop; F4.3 does it), the x64 runner, and every GCS-writing workflow (F4.2 and F4.3, each with the owner's OK).

**Implementation status (2026-10-19).** F1.1–F3.1 and F4.1 are implemented, uncommitted, in the worktree
`windows-installer` on branch `feat/windows-installer` (from `feat/windows-desktop` at `f2d1227e6`); its ledger is
`.superpowers/sdd/2026-10-19-windows-installer/progress.md`. The final review's fixes go beyond this plan's text, and
the code there is the reference:
- `build-windows` sets `name: build-windows (${{ matrix.runner }}, ${{ matrix.arch }})`: GitHub otherwise names a
  matrix job with every matrix value, `check_jobs` refuses the candidate, and every release rebuilds
  (`test_required_matrix_jobs_are_named_as_github_names_them`);
- a body that ends short of its size is tried again while tries remain (`flow.rs`);
- the mutex is taken before the log, and a second copy appends to it instead of cutting it short;
- the failure box scrolls (`WS_VSCROLL`);
- the website shows the PowerShell line in its own code block, so a copy does not take a period.
- then the review's minors: the calls newer than Windows 10 1507 are found with `GetProcAddress`, so an older
  Windows 10 loads the program and is told it needs 1809; WinINet does not follow redirects; a Cancel that lands as
  the install starts reports how it ended; an empty HTTP answer says Windows' reason; the window takes its own DPI;
  `installer/` is a PR CI component (`pty-checks`); the arm64 runner also runs the x64 build emulated;
  `install-state.ps1` reads the log as UTF-8.
F4.2–F4.4 remain, after C.

## Global Constraints

**Platform and permissions**
- Windows 10 1809 (build 17763) or later, x64 and arm64. Per user, with no administrator rights and no UAC prompt: the executable's manifest says `requestedExecutionLevel level="asInvoker"`.
- macOS and Linux behaviour is unchanged, apart from the release workflow's three new artifacts and the website's Windows link.
- Nothing is code-signed. There is no signing service; do not add one, and do not add a self-signed certificate.

**`harness-install.exe` (spec §1)**
- Crate `installer/`, bin `harness-install`, release built only for `x86_64-pc-windows-msvc` with `+crt-static`. Not part of `pty/`, and it does not link `harness-pty`.
- No PowerShell, no shell: WinINet for downloads (`INTERNET_OPEN_TYPE_PRECONFIG`), `%SystemRoot%\System32\tar.exe` for the zip, `Harness.exe --install` started with an argument list.
- Manifest base, compiled in from `HARNESS_INSTALL_BASE`: exactly `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/` (production, the default) or the same with `staging/` appended. `HARNESS_INSTALL_MANIFEST` (a file or an `https://` URL) replaces the manifest, for tests.
- Entry choice is `install.ps1`'s `Select-HarnessAppEntry`, held to it by `installer/tests/entry-vectors.json`. Every step name and every check message is `install.ps1`'s, word for word.
- A download must be under `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/` or `https://cdn.autonomous.ai/harness/desktop/`; a staging build also accepts `…/harness/staging/desktop/`.
- The temp folder is `%TEMP%\.harness-desktop-staging-<pid>-<time>`, removed whatever happens. The log is `%TEMP%\harness-install.log`, rewritten by each run.
- Exit codes: 0 installed (and opened), 1 failed, 2 cancelled. `--quiet` is the only argument.
- The window title is **Install Harness**; the copy follows `docs/naming-system.md` (Harness, Autonomous).

**Release (spec §2)**
- Keys and files: `desktop-windows-x64` → `Harness-windows-x64.zip`, `desktop-windows-arm64` → `Harness-windows-arm64.zip`, `desktop-windows-installer` → `harness-install.exe`, all under `harness/desktop/<version>/`.
- Parts: `windows-x64.json` holds `desktop-windows-x64` and `desktop-windows-installer`; `windows-arm64.json` holds `desktop-windows-arm64`.
- Windows runners never run gcloud. Release builds run no test suite.
- A failed Windows build stops the release (owner's decision, 2026-10-19).

**Testing and safety**
- Never test against the developer's own machine: the real `~/.harness`, the daemon on 18473, engine homes, tmux. Never `harness service install` or launchd on the Mac.
- The x64 test PC's address, account and password are the owner's and are **never written into the repo**; take them from the owner. On the ARM64 VM never touch `C:\work\e2e` or the admin profile's engine settings.
- No production publish. A staging publish, a release candidate and the publication check each need the owner's OK first.
- The repo is public: no addresses, account names, ids or passwords in committed evidence.
- Docs, comments and commit messages in English. Comments say why, naming the measurement or incident.
- Never bare `git stash`; never `git clean -fdx`.
- One task is one commit, or a few, conventional (`feat(windows): …`, `test(windows): …`, `ci(windows): …`), each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

The inputs and conditions the spec implies but its own test list does not pin, most likely first. Each names the task whose test pins it.

1. **A profile path with spaces, an apostrophe, `&`, `%` and non-ASCII letters** (`C:\Users\Nguyễn Văn A' & 100%\…`), which is also `%TEMP%`. The download, the unpack (`tar.exe` reads arguments in the ANSI code page) and the window's text must all work. Pinned by F1.3 (`tests/windows.rs` runs under such a TEMP and must reach the unpack step) and F1.4 (the full install, in `installPs1App.spec.ts`'s world, whose profile has that name); the window uses `SS_NOPREFIX`.
2. **Wi-Fi that drops in the middle of the 40 MB zip.** The installer tries again from the start, three times in all, and a body that grows past its size is never tried again. Pinned by F1.2 (`a_dropped_download_is_tried_again_from_the_start`, `a_body_past_its_size_stops_at_once_and_is_not_tried_again`).
3. **A manifest that names somewhere else** (a proxy that rewrites it, a compromised bucket object): an `http://` URL, another host, a `..`, a query. Nothing outside Harness's folders is fetched. Pinned by F1.1 (`a_download_must_be_in_harnesss_release_folders`) and F1.2 (`a_download_outside_harnesss_folders_is_never_fetched`).
4. **An arm64 PC running the x64 installer emulated** must get the arm64 app, not the emulated x64 one. Pinned by F1.3 (`the_machine_is_the_pcs_own_even_when_this_program_runs_emulated`, on the arm64 runner) and F4.3 Step 9 (the installed `harness-desktop.exe` is an ARM64 image).
5. **The installer opened twice** (a double double-click, or opened again while it runs). One install runs; the second copy shows the first. Pinned by F1.3 (`a_second_copy_finds_the_first`, `a_second_copy_does_not_start_a_second_install`).

## File map

| File | Task | Responsibility |
|---|---|---|
| `installer/Cargo.toml`, `Cargo.lock`, `.gitignore`, `.cargo/config.toml` | F1.1 | The crate, static CRT, small release profile |
| `installer/src/model.rs`, `installer/tests/entry-vectors.json` | F1.1 | Pure decisions: arguments, steps, machine, version order, entry choice, URL rule, checks, messages |
| `installer/src/flow.rs` | F1.2 | The install's steps over a `Host` and a `Report`, retries, cancel, clean-up, closing lines |
| `installer/src/windows.rs`, `installer/src/ui.rs`, `installer/src/main.rs` | F1.3 | WinINet, `tar.exe`, `--install`, log, mutex, quiet mode; the window |
| `installer/build.rs`, `installer/harness-install.manifest` | F1.3 | The application manifest, icon and version resource |
| `installer/tests/windows.rs` | F1.3 | The built binary in quiet mode, and its resources, on Windows |
| `.github/workflows/windows-desktop.yml` | F1.3, F1.4, F2.3 | The installer's tests; the full install; the staging installer |
| `cli/src/scripts/installPs1App.spec.ts` | F1.4 | Both installers against the shared vectors and the real launcher |
| `scripts/verify-desktop-release.py`, `publish-desktop-manifest.py`, `desktop-release-candidate.py`, `check-desktop-*-gcs.py`, `scripts/tests/*` | F2.1 | Six artifacts become nine |
| `desktop/scripts/check-windows-zip.py`, `upload-desktop-windows.sh`, `cli/src/scripts/uploadDesktopWindows.spec.ts` | F2.2 | The zip-shape check, shared; the release upload |
| `.github/workflows/release-desktop.yml`, `cli/src/scripts/windowsWorkflows.spec.ts` | F2.2, F2.3 | `build-windows`, `upload-windows`; their pins |
| `desktop/scripts/publish-desktop-windows-staging.sh`, `cli/src/scripts/publishDesktopWindowsStaging.spec.ts` | F2.2, F2.3 | The zip check moved out; the staging installer |
| `desktop/RELEASE.md`, `docs/validation-and-release.md`, `AGENTS.md`, `desktop/scripts/release-desktop.sh`, `desktop/scripts/build-macos-variants.py` | F2.3 | Nine artifacts; Windows in every release |
| `website/src/lib/installCommand.ts`, `desktopPlatform.ts`, `website/src/app/desktop/…`, `website/src/app/download/page.spec.tsx` | F3.1 | **Download for Windows** |
| `desktop/scripts/windows-e2e/install-state.ps1`, `desktop-e2e.sh`, `README.md` | F4.1 | What an install left, read-only |
| `docs/testing/windows-installer-e2e.md`, `desktop/scripts/windows-e2e/evidence/installer-*` | F4.3 | The run on the test PCs |
| the spec, `desktop/RELEASE.md` | F4.4 | Status; the production order after the merge |

## Phases

| Phase | Tasks | Delivers |
|---|---|---|
| F1 `harness-install.exe` | F1.1–F1.4 | The program, tested on macOS and on both Windows runners, held to `install.ps1 -App` |
| F2 Release | F2.1–F2.3 | Windows in every desktop release; a staging installer for the E2E |
| F3 Website | F3.1 | The Windows download |
| F4 End to end | F4.1–F4.4 | A release candidate, the publication check, seven scenarios on the x64 PC and one on the ARM64 VM, docs |

---

## Phase F1: `harness-install.exe`

### Task F1.1: The crate and its pure model

**Files:**
- Create: `installer/Cargo.toml`, `installer/Cargo.lock` (generated), `installer/.gitignore`, `installer/.cargo/config.toml`, `installer/src/main.rs`, `installer/src/model.rs`, `installer/tests/entry-vectors.json`

**Interfaces:**
- Produces (used by F1.2–F1.4):
  - `model::{EXIT_OK = 0, EXIT_FAILED = 1, EXIT_CANCELLED = 2}`, `PRODUCTION_BASE`, `STAGING_BASE`, `BASE`, `VERSION`, `MANIFEST_ENV`, `X64_KEY`, `ARM64_KEY`, `MIN_BUILD = 17763`, `MANIFEST_LIMIT`, `ATTEMPTS = 3`, `USAGE`;
  - `model::Mode { Window, Quiet }`, `model::parse(&[String]) -> Result<Mode, String>`, `model::is_staging(&str) -> bool`;
  - `model::Step { Check, Manifest, Download, Unpack, Install }` with `name()` (install.ps1's `$step`) and `status()` (the window's line);
  - `model::Machine { X64, Arm64 }`, `Machine::from_native(u16)`, `Machine::platform() -> &'static str`;
  - `model::check_build(u32)`, `tar_path(&Path) -> PathBuf`, `missing_tar(&Path) -> String`;
  - `model::version_key(&str) -> Option<(u32, u32, u32)>`, `model::Entry { key, version, url, sha256, size: i64 }`, `model::select_entry(&Value, Machine) -> Result<Entry, String>`;
  - `model::Source { Https(String), File(PathBuf) }` with `display()`, `manifest_source(Option<&str>, &str)`, `allowed_url(&str, bool)`, `resolve_ref(&str, &Source, bool)`;
  - `model::check_sha256`, `size_limit(i64) -> u64`, `check_download`, `no_launcher()`, `install_stopped(i32, &str)`, `staging_name(u32, u128)`.

- [ ] **Step 1: The crate**

`installer/Cargo.toml`:

```toml
[package]
name = "harness-install"
version = "0.1.0"
edition = "2024"

[[bin]]
name = "harness-install"
path = "src/main.rs"

[dependencies]
serde_json = "1"
sha2 = "0.10"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Wdk_System_SystemServices", "Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Networking_WinInet", "Win32_Security", "Win32_Storage_FileSystem", "Win32_System_Diagnostics_Debug", "Win32_System_LibraryLoader", "Win32_System_SystemInformation", "Win32_System_Threading", "Win32_UI_Controls", "Win32_UI_HiDpi", "Win32_UI_Input_KeyboardAndMouse", "Win32_UI_WindowsAndMessaging"] }

[build-dependencies]
embed-resource = "3"

# Small and self-contained: the website serves it to every Windows visitor.
[profile.release]
lto = true
codegen-units = 1
strip = true
```

`installer/.cargo/config.toml`:

```toml
# The static C runtime, so harness-install.exe runs on a PC with no Visual C++ runtime installed (spec §1.4).
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]

[target.aarch64-pc-windows-msvc]
rustflags = ["-C", "target-feature=+crt-static"]
```

`installer/.gitignore`, as `pty/` and `term/` have it:

```
/target
```

`installer/src/main.rs`, for now (F1.3 replaces it):

```rust
//! harness-install.exe (docs/superpowers/specs/2026-10-19-windows-installer-design.md). The Windows half arrives in
//! F1.3; until then this builds and tests the pure model on any OS.
#![cfg_attr(not(windows), allow(dead_code))]

mod model;

fn main() {
    eprintln!("harness-install runs on Windows only");
    std::process::exit(model::EXIT_FAILED);
}
```

- [ ] **Step 2: The shared vectors, and the model's failing tests**

`installer/tests/entry-vectors.json`: the answers `install.ps1`'s `Select-HarnessAppEntry` gives today (its cases in `cli/src/scripts/installPs1App.spec.ts`, one vector each). F1.4 runs `install.ps1` against the same file.

```json
[
  {
    "name": "x64 takes the x64 entry, never arm64",
    "platform": "win32-x64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.3.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "x64 with only an arm64 entry has none",
    "platform": "win32-x64",
    "document": {
      "desktop-windows-arm64": {
        "version": "1.3.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "The desktop manifest has no Harness desktop app for this computer (win32-x64) yet."
  },
  {
    "name": "arm64 takes a newer arm64",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.3.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.3.0 https://cdn.example/arm64.zip"
  },
  {
    "name": "arm64 orders by number, not text",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.10.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.9.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.10.0 https://cdn.example/x64.zip"
  },
  {
    "name": "arm64 wins a tie",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.3.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.3.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.3.0 https://cdn.example/arm64.zip"
  },
  {
    "name": "a prerelease ties on its numbers, and arm64 wins it",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.3.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.3.0-rc.1",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.3.0-rc.1 https://cdn.example/arm64.zip"
  },
  {
    "name": "arm64 alone",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-arm64": {
        "version": "1.3.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.3.0 https://cdn.example/arm64.zip"
  },
  {
    "name": "x64 alone, emulated on arm64",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "a newer arm64 entry with no url is skipped",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.9.0",
        "url": null,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "a newer arm64 entry with no sha256 is skipped",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.9.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": null,
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "a newer arm64 entry with a text size is skipped",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.9.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": "one"
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "a newer arm64 entry with a junk version is skipped",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "1.9.0junk",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "a newer arm64 entry with a version past Int32 is skipped",
    "platform": "win32-arm64",
    "document": {
      "desktop-windows-x64": {
        "version": "1.2.0",
        "url": "https://cdn.example/x64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      },
      "desktop-windows-arm64": {
        "version": "9999999999.0.0",
        "url": "https://cdn.example/arm64.zip",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "size": 1
      }
    },
    "expect": "1.2.0 https://cdn.example/x64.zip"
  },
  {
    "name": "an empty manifest has none",
    "platform": "win32-arm64",
    "document": {},
    "expect": "The desktop manifest has no Harness desktop app for this computer (win32-arm64) yet."
  }
]
```

`installer/src/model.rs`, the test module first (the code above it comes in Step 4):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn takes_no_argument_or_quiet_and_nothing_else() {
        assert_eq!(parse(&args(&[])), Ok(Mode::Window));
        assert_eq!(parse(&args(&["--quiet"])), Ok(Mode::Quiet));
        for bad in [&["--Quiet"][..], &["--quiet", "x"][..], &["/S"][..], &["--manifest"][..]] {
            assert_eq!(parse(&args(bad)), Err(USAGE.to_owned()), "{bad:?}");
        }
    }

    #[test]
    fn the_build_is_production_unless_the_release_built_it_for_staging() {
        assert!(!is_staging(PRODUCTION_BASE));
        assert!(is_staging(STAGING_BASE));
        assert!(BASE == PRODUCTION_BASE || BASE == STAGING_BASE);
    }

    #[test]
    fn the_steps_are_named_as_install_ps1_names_them() {
        let names: Vec<_> = [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install]
            .iter()
            .map(|step| step.name())
            .collect();
        assert_eq!(
            names,
            ["Checking this computer", "Reading the release manifest", "Downloading Harness", "Unpacking Harness", "Installing Harness"]
        );
    }

    #[test]
    fn an_arm_pc_is_told_apart_from_an_x64_one_by_its_native_machine() {
        assert_eq!(Machine::from_native(0xAA64), Machine::Arm64);
        assert_eq!(Machine::from_native(0x8664), Machine::X64);
        assert_eq!(Machine::from_native(0), Machine::X64);
    }

    #[test]
    fn windows_10_1809_is_the_oldest_it_installs_on() {
        assert!(check_build(17763).is_ok());
        assert!(check_build(26200).is_ok());
        assert_eq!(
            check_build(17134).unwrap_err(),
            "Harness needs Windows 10 version 1809 or later, and this computer runs build 17134. Update Windows, then run the installer again."
        );
    }

    #[test]
    fn versions_order_by_their_three_numbers() {
        assert_eq!(version_key("1.2.3"), Some((1, 2, 3)));
        assert_eq!(version_key("1.10.0-rc.1"), Some((1, 10, 0)));
        assert_eq!(version_key("01.2.3"), Some((1, 2, 3)));
        assert_eq!(version_key("2147483647.0.0"), Some((2147483647, 0, 0)));
        for bad in ["", "1.2", "1.2.3.4", "1.2.3-", "1.2.3-rc..1", "1.2.3+build", "1.9.0junk", "v1.2.3", "2147483648.0.0", "9999999999.0.0", "1.2.-3", "１.2.3"] {
            assert_eq!(version_key(bad), None, "{bad}");
        }
    }

    // The vectors install.ps1's own spec runs against Select-HarnessAppEntry (cli/src/scripts/installPs1App.spec.ts).
    #[test]
    fn chooses_the_entry_install_ps1_chooses() {
        let vectors: Value = serde_json::from_str(include_str!("../tests/entry-vectors.json")).unwrap();
        let vectors = vectors.as_array().unwrap();
        assert!(vectors.len() >= 10);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let machine = match vector["platform"].as_str().unwrap() {
                "win32-x64" => Machine::X64,
                "win32-arm64" => Machine::Arm64,
                other => panic!("{name}: platform {other}"),
            };
            let got = match select_entry(&vector["document"], machine) {
                Ok(entry) => format!("{} {}", entry.version, entry.url),
                Err(message) => message,
            };
            assert_eq!(got, vector["expect"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn an_entry_needs_text_fields_and_a_whole_number_size() {
        let doc = |size: Value| json!({ X64_KEY: { "version": "1.2.0", "url": "https://x/a.zip", "sha256": "0", "size": size } });
        assert_eq!(select_entry(&doc(json!(5)), Machine::X64).unwrap().size, 5);
        for size in [json!(1.5), json!(1e3), json!("5"), json!(null), json!(18446744073709551615u64)] {
            assert!(select_entry(&doc(size.clone()), Machine::X64).is_err(), "{size}");
        }
        assert!(select_entry(&json!([1, 2]), Machine::X64).is_err());
    }

    #[test]
    fn the_manifest_is_the_builds_unless_a_test_names_another() {
        assert_eq!(
            manifest_source(None, PRODUCTION_BASE),
            Ok(Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json")))
        );
        assert_eq!(manifest_source(Some(""), STAGING_BASE), Ok(Source::Https(format!("{STAGING_BASE}desktop/metadata.json"))));
        assert_eq!(manifest_source(Some("HTTPS://h/m.json"), PRODUCTION_BASE), Ok(Source::Https("HTTPS://h/m.json".into())));
        assert_eq!(manifest_source(Some(r"C:\build\metadata.json"), PRODUCTION_BASE), Ok(Source::File(r"C:\build\metadata.json".into())));
        assert_eq!(
            manifest_source(Some("http://h/m.json"), PRODUCTION_BASE),
            Err("Only https:// addresses are trusted, and http://h/m.json is not one.".into())
        );
    }

    #[test]
    fn a_download_must_be_in_harnesss_release_folders() {
        for good in [
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-windows-x64.zip",
            "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.2.3/Harness-windows-arm64.zip",
        ] {
            assert!(allowed_url(good, false), "{good}");
            assert!(allowed_url(good, true), "{good}");
        }
        let staged = "https://cdn.autonomous.ai/harness/staging/desktop/1.2.3-rc1/harness-desktop-1.2.3-rc1-windows-x64.zip";
        assert!(allowed_url(staged, true));
        assert!(!allowed_url(staged, false));
        for bad in [
            "https://cdn.autonomous.ai/harness/desktop/",
            "https://cdn.autonomous.ai/harness/desktop/../cli/x.zip",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3//x.zip",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/x.zip?x=1",
            "https://cdn.autonomous.ai/harness/desktop/1.2.3/x%2e.zip",
            "https://cdn.autonomous.ai.evil.example/harness/desktop/1.2.3/x.zip",
            "https://storage.googleapis.com/another-bucket/harness/desktop/1.2.3/x.zip",
            "https://cdn.autonomous.ai/harness/cli/1.2.3/x.zip",
            "https://CDN.autonomous.ai/harness/desktop/1.2.3/x.zip",
        ] {
            assert!(!allowed_url(bad, true), "{bad}");
        }
    }

    #[test]
    fn an_entrys_file_is_an_allowed_address_or_beside_a_local_manifest() {
        let published = Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json"));
        let local = Source::File(PathBuf::from("build").join("metadata.json"));
        let url = "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-windows-x64.zip";
        assert_eq!(resolve_ref(url, &published, false), Ok(Source::Https(url.into())));
        assert_eq!(resolve_ref(url, &local, false), Ok(Source::Https(url.into())));
        assert_eq!(
            resolve_ref("https://example.com/x.zip", &published, false),
            Err("The manifest names https://example.com/x.zip, which is not one of Harness's downloads.".into())
        );
        assert_eq!(
            resolve_ref("file:///C:/x.zip", &local, false),
            Err("Only https:// addresses are trusted, and file:///C:/x.zip is not one.".into())
        );
        assert_eq!(
            resolve_ref("x.zip", &published, false),
            Err(format!("The manifest {PRODUCTION_BASE}desktop/metadata.json names x.zip, which is not an https:// address."))
        );
        assert_eq!(resolve_ref("x.zip", &local, false), Ok(Source::File(PathBuf::from("build").join("x.zip"))));
    }

    #[test]
    fn a_download_is_kept_only_when_its_size_and_hash_are_the_manifests() {
        let hash = "a".repeat(64);
        assert!(check_sha256(&hash, "s").is_ok());
        assert!(check_sha256(&"A".repeat(64), "s").is_ok());
        assert_eq!(check_sha256("abc", "s"), Err("The manifest gives no valid SHA-256 for s.".into()));
        assert!(check_download("s", 10, 10, &hash, &hash.to_uppercase()).is_ok());
        assert_eq!(
            check_download("s", 9, 10, &hash, &hash),
            Err("s is 9 bytes, but the manifest says 10: the download is incomplete, or is not the published file.".into())
        );
        let other = "b".repeat(64);
        assert_eq!(
            check_download("s", 10, 10, &other, &hash),
            Err(format!("s failed its checksum (expected {hash}, got {other}): it is not the published file."))
        );
        assert_eq!(size_limit(-1), 0);
        assert_eq!(size_limit(7), 7);
    }

    #[test]
    fn the_temp_folder_is_named_as_install_ps1_names_its_own() {
        assert_eq!(staging_name(42, 7), ".harness-desktop-staging-42-7");
    }
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd installer && cargo test`
Expected: FAIL to compile: `parse`, `Mode`, `select_entry`, `allowed_url` and the rest are not defined.

- [ ] **Step 4: The model**

Above the test module in `installer/src/model.rs`:

```rust
//! What harness-install decides, with no Windows call in it, so `cargo test` checks it on every OS
//! (docs/superpowers/specs/2026-10-19-windows-installer-design.md §1.1). Each rule is install.ps1's `-App` mode, the
//! one-command install C ships: the same manifest, the same entry choice, the same checks and the same messages.
//! tests/entry-vectors.json holds both installers to one answer for the choice.

use std::path::{Path, PathBuf};

use serde_json::Value;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_CANCELLED: i32 = 2;

/// install.ps1's `$HarnessManifestBase`, and its staging copy's (upload-install-ps1.sh).
pub const PRODUCTION_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/";
pub const STAGING_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/";
/// The build's base. The release sets `HARNESS_INSTALL_BASE`; build.rs refuses anything but the two above.
pub const BASE: &str = match option_env!("HARNESS_INSTALL_BASE") {
    Some(base) => base,
    None => PRODUCTION_BASE,
};
/// The desktop version this copy was released with (the version resource says the same).
pub const VERSION: &str = match option_env!("HARNESS_INSTALL_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
/// A manifest to use instead of the build's, for tests: the name install.ps1 already reads.
pub const MANIFEST_ENV: &str = "HARNESS_INSTALL_MANIFEST";
pub const X64_KEY: &str = "desktop-windows-x64";
pub const ARM64_KEY: &str = "desktop-windows-arm64";
/// ConPTY, which the terminal host needs, arrived in Windows 10 1809 (install.ps1's Test-HarnessHost).
pub const MIN_BUILD: u32 = 17763;
/// A manifest is a few kilobytes; anything near this is not one.
pub const MANIFEST_LIMIT: u64 = 1 << 20;
/// Tries for a network read, as install.ps1's Invoke-HarnessRetry makes: a drop in the middle of a download is
/// common on Wi-Fi.
pub const ATTEMPTS: u32 = 3;
pub const USAGE: &str = "usage: harness-install [--quiet]";

/// Where the zips are published: the bucket, and the CDN in front of it at the same paths. The website's
/// `resolveDesktopDownload` accepts the same two.
const ORIGINS: [&str; 2] = [
    "https://storage.googleapis.com/s3-autonomous-upgrade-3/",
    "https://cdn.autonomous.ai/",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Window,
    Quiet,
}

pub fn parse(args: &[String]) -> Result<Mode, String> {
    match args {
        [] => Ok(Mode::Window),
        [flag] if flag == "--quiet" => Ok(Mode::Quiet),
        _ => Err(USAGE.to_owned()),
    }
}

/// A staging build reads the staging manifest and may follow it into the staging folders.
pub fn is_staging(base: &str) -> bool {
    base == STAGING_BASE
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Check,
    Manifest,
    Download,
    Unpack,
    Install,
}

impl Step {
    /// install.ps1's `$step` names: its failure line and this program's say the same.
    pub fn name(self) -> &'static str {
        match self {
            Step::Check => "Checking this computer",
            Step::Manifest => "Reading the release manifest",
            Step::Download => "Downloading Harness",
            Step::Unpack => "Unpacking Harness",
            Step::Install => "Installing Harness",
        }
    }

    /// The window's status line while the step runs.
    pub fn status(self) -> &'static str {
        match self {
            Step::Check => "Checking this computer…",
            Step::Manifest => "Checking for the latest Harness…",
            Step::Download => "Downloading Harness…",
            Step::Unpack => "Unpacking Harness…",
            Step::Install => "Installing Harness…",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Machine {
    X64,
    Arm64,
}

impl Machine {
    /// `IsWow64Process2`'s native machine. This program is x64, so on an Arm PC it runs emulated and only the
    /// native answer names the app the PC should get.
    pub fn from_native(image: u16) -> Machine {
        const IMAGE_FILE_MACHINE_ARM64: u16 = 0xAA64;
        if image == IMAGE_FILE_MACHINE_ARM64 { Machine::Arm64 } else { Machine::X64 }
    }

    pub fn platform(self) -> &'static str {
        match self {
            Machine::X64 => "win32-x64",
            Machine::Arm64 => "win32-arm64",
        }
    }
}

pub fn check_build(build: u32) -> Result<(), String> {
    if build < MIN_BUILD {
        return Err(format!(
            "Harness needs Windows 10 version 1809 or later, and this computer runs build {build}. Update Windows, then run the installer again."
        ));
    }
    Ok(())
}

pub fn tar_path(system_root: &Path) -> PathBuf {
    // The fixed path, so a GNU tar on PATH is never used: it cannot read a zip.
    system_root.join("System32").join("tar.exe")
}

pub fn missing_tar(tar: &Path) -> String {
    format!(
        "Windows' own tar.exe is missing ({}). It is part of Windows 10 1803 and later.",
        tar.display()
    )
}

/// install.ps1's ConvertTo-HarnessVersionKey: `X.Y.Z` or `X.Y.Z-prerelease`, ordered by the three numbers only, each
/// within PowerShell's `[version]` (an Int32). Anything else has no key, and its entry is skipped.
pub fn version_key(value: &str) -> Option<(u32, u32, u32)> {
    let (core, prerelease) = match value.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (value, None),
    };
    if let Some(prerelease) = prerelease {
        let valid = prerelease
            .split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric()));
        if !valid {
            return None;
        }
    }
    let number = |part: &str| -> Option<u32> {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<u32>().ok().filter(|n| *n <= i32::MAX as u32)
    };
    let mut parts = core.split('.');
    let key = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
    parts.next().is_none().then_some(key)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub key: &'static str,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: i64,
}

fn entry(document: &serde_json::Map<String, Value>, key: &'static str) -> Option<Entry> {
    let fields = document.get(key)?.as_object()?;
    let text = |name: &str| fields.get(name).and_then(Value::as_str).map(str::to_owned);
    // PowerShell's ConvertFrom-Json makes a whole number an [int] or [long], which is all install.ps1 takes; 1.5,
    // 1e3, a string or a number past Int64 become another type, and the entry is skipped.
    let size = fields.get("size").filter(|v| v.is_i64() || v.is_u64()).and_then(Value::as_i64)?;
    Some(Entry { key, version: text("version")?, url: text("url")?, sha256: text("sha256")?, size })
}

/// install.ps1's Select-HarnessAppEntry. x64 takes `desktop-windows-x64`. Arm64 takes the newer of the arm64 and x64
/// entries, and arm64 wins a tie: the x64 app runs emulated until an arm64 build of that version is out.
pub fn select_entry(document: &Value, machine: Machine) -> Result<Entry, String> {
    let none = || {
        format!(
            "The desktop manifest has no Harness desktop app for this computer ({}) yet.",
            machine.platform()
        )
    };
    let document = document.as_object().ok_or_else(none)?;
    let keys: &[&'static str] = match machine {
        Machine::X64 => &[X64_KEY],
        Machine::Arm64 => &[ARM64_KEY, X64_KEY],
    };
    let mut best: Option<((u32, u32, u32), Entry)> = None;
    for &key in keys {
        let Some(candidate) = entry(document, key) else { continue };
        let Some(order) = version_key(&candidate.version) else { continue };
        if best.as_ref().is_none_or(|(current, _)| order > *current) {
            best = Some((order, candidate));
        }
    }
    best.map(|(_, entry)| entry).ok_or_else(none)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Https(String),
    File(PathBuf),
}

impl Source {
    pub fn display(&self) -> String {
        match self {
            Source::Https(url) => url.clone(),
            Source::File(path) => path.display().to_string(),
        }
    }
}

/// install.ps1's `-match '^https://'`, which ignores case.
fn is_https(value: &str) -> bool {
    value.len() >= 8 && value.as_bytes()[..8].eq_ignore_ascii_case(b"https://")
}

/// Any other `scheme://`. A drive path (`C:\…`) has no `//` and is a file.
fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else { return false };
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
}

fn untrusted(value: &str) -> String {
    format!("Only https:// addresses are trusted, and {value} is not one.")
}

/// The manifest: `HARNESS_INSTALL_MANIFEST` (a file, or an https:// address) when it is set, else the build's.
pub fn manifest_source(override_value: Option<&str>, base: &str) -> Result<Source, String> {
    match override_value.filter(|value| !value.is_empty()) {
        None => Ok(Source::Https(format!("{base}desktop/metadata.json"))),
        Some(value) if is_https(value) => Ok(Source::Https(value.to_owned())),
        Some(value) if has_scheme(value) => Err(untrusted(value)),
        Some(value) => Ok(Source::File(PathBuf::from(value))),
    }
}

/// Only Harness's own release folders, at either origin: the rule the website's download routes apply to the same
/// field. A staging build also follows the staging folders. Only plain path characters, so nothing in the address
/// can step out of the folder.
pub fn allowed_url(url: &str, staging: bool) -> bool {
    let folders: &[&str] = if staging {
        &["harness/desktop/", "harness/staging/desktop/"]
    } else {
        &["harness/desktop/"]
    };
    let plain = |rest: &str| {
        !rest.is_empty()
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
            && rest.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
    };
    ORIGINS.iter().any(|origin| {
        folders.iter().any(|folder| {
            url.strip_prefix(origin).and_then(|rest| rest.strip_prefix(folder)).is_some_and(plain)
        })
    })
}

/// install.ps1's Resolve-HarnessRef, plus the release-folder rule: where an entry's file is. A published manifest
/// names https:// addresses only; a local one (a test, a build of this tree) may name a file, beside it or rooted.
pub fn resolve_ref(reference: &str, manifest: &Source, staging: bool) -> Result<Source, String> {
    if is_https(reference) {
        if !allowed_url(reference, staging) {
            return Err(format!(
                "The manifest names {reference}, which is not one of Harness's downloads."
            ));
        }
        return Ok(Source::Https(reference.to_owned()));
    }
    if has_scheme(reference) {
        return Err(untrusted(reference));
    }
    match manifest {
        Source::Https(url) => Err(format!(
            "The manifest {url} names {reference}, which is not an https:// address."
        )),
        Source::File(path) => {
            let named = Path::new(reference);
            Ok(Source::File(if named.is_absolute() {
                named.to_path_buf()
            } else {
                path.parent().unwrap_or(Path::new("")).join(named)
            }))
        }
    }
}

pub fn check_sha256(sha256: &str, source: &str) -> Result<(), String> {
    if sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(format!("The manifest gives no valid SHA-256 for {source}."))
}

/// The size the download may reach before it is already wrong.
pub fn size_limit(size: i64) -> u64 {
    u64::try_from(size).unwrap_or(0)
}

/// install.ps1's Save-HarnessVerified: the manifest is the trust, and the bytes are not until they match it.
pub fn check_download(source: &str, length: u64, size: i64, got: &str, expected: &str) -> Result<(), String> {
    if i64::try_from(length).ok() != Some(size) {
        return Err(format!(
            "{source} is {length} bytes, but the manifest says {size}: the download is incomplete, or is not the published file."
        ));
    }
    if got != expected.to_ascii_lowercase() {
        return Err(format!(
            "{source} failed its checksum (expected {expected}, got {got}): it is not the published file."
        ));
    }
    Ok(())
}

pub fn no_launcher() -> String {
    "The download has no Harness.exe, so it is not a Harness desktop app.".to_owned()
}

pub fn install_stopped(code: i32, local_app_data: &str) -> String {
    format!(
        "Harness's installer stopped (exit code {code}). Its log is launch.log, in Programs\\Harness under {local_app_data}."
    )
}

/// The temp folder's name: install.ps1's New-HarnessStaging pattern (`.<name>-staging-<pid>-<time>`).
pub fn staging_name(pid: u32, time: u128) -> String {
    format!(".harness-desktop-staging-{pid}-{time}")
}
```

- [ ] **Step 5: Run the tests**

Run: `cd installer && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, 13 tests; clippy clean. `Cargo.lock` is written: it is committed, as the release builds with `--locked`.

- [ ] **Step 6: Commit**

```bash
git add installer/Cargo.toml installer/Cargo.lock installer/.gitignore installer/.cargo/config.toml installer/src/main.rs installer/src/model.rs installer/tests/entry-vectors.json
git commit -m "feat(windows): harness-install's model, which chooses and checks as install.ps1 -App does" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task F1.2: The install's steps

**Files:**
- Create: `installer/src/flow.rs`
- Modify: `installer/src/main.rs` (`mod flow;`)

**Interfaces:**
- Consumes: F1.1's model.
- Produces (used by F1.3):
  - `flow::Host` (trait): `windows_build`, `system_root`, `machine`, `local_app_data`, `is_file`, `read(&Source) -> Result<Vec<u8>, String>`, `staging() -> Result<PathBuf, String>`, `download(&Source, &Path, &mut dyn FnMut(u64) -> bool) -> Result<(), String>`, `unpack(tar, archive, into)`, `install(&Path) -> Result<i32, String>`, `remove(&Path)`, `pause(Duration)`;
  - `flow::Report` (trait): `step(Step)`, `progress(received, total)`, `cancelled() -> bool`, `log(&str)`;
  - `flow::Outcome { Installed { version }, Failed { step, message }, Cancelled }`, `flow::Finished { outcome, left: Option<(PathBuf, String)> }` with `exit_code()` and `lines()`;
  - `flow::run(&mut impl Host, &mut impl Report, &Source, staging_build: bool) -> Finished`.

- [ ] **Step 1: Write the failing tests**

`installer/src/flow.rs`, the test module first. The stand-in host writes real files under the system temp folder, so the hash check and the clean-up are the real ones:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Machine, PRODUCTION_BASE};
    use std::cell::Cell;
    use std::collections::VecDeque;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    const URL: &str = "https://cdn.autonomous.ai/harness/desktop/1.4.0/Harness-windows-x64.zip";
    const BODY: &[u8] = b"a zip, as far as this test cares";

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn manifest_for(url: &str, size: usize, sha256: &str) -> Vec<u8> {
        serde_json::json!({ "desktop-windows-x64": { "version": "1.4.0", "url": url, "sha256": sha256, "size": size } })
            .to_string()
            .into_bytes()
    }

    fn scratch() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "harness-install-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Fake {
        root: PathBuf,
        build: u32,
        tar: bool,
        manifest: VecDeque<Result<Vec<u8>, String>>,
        downloads: VecDeque<Result<Vec<u8>, String>>,
        download_calls: u32,
        launcher: bool,
        unpack: Result<(), String>,
        exit: Result<i32, String>,
        installed: Vec<PathBuf>,
        remove_fails: bool,
        made: Vec<PathBuf>,
        pauses: u32,
    }

    impl Fake {
        fn new() -> Fake {
            Fake {
                root: scratch(),
                build: 26200,
                tar: true,
                manifest: VecDeque::from([Ok(manifest_for(URL, BODY.len(), &sha(BODY)))]),
                downloads: VecDeque::from([Ok(BODY.to_vec())]),
                download_calls: 0,
                launcher: true,
                unpack: Ok(()),
                exit: Ok(0),
                installed: Vec::new(),
                remove_fails: false,
                made: Vec::new(),
                pauses: 0,
            }
        }
    }

    impl Host for Fake {
        fn windows_build(&self) -> u32 {
            self.build
        }
        fn system_root(&self) -> PathBuf {
            PathBuf::from("W")
        }
        fn machine(&self) -> Machine {
            Machine::X64
        }
        fn local_app_data(&self) -> String {
            "L".into()
        }
        fn is_file(&self, path: &Path) -> bool {
            if path.ends_with("tar.exe") { self.tar } else { path.is_file() }
        }
        fn read(&mut self, _: &Source) -> Result<Vec<u8>, String> {
            self.manifest.pop_front().expect("no more manifest answers")
        }
        fn staging(&mut self) -> Result<PathBuf, String> {
            let dir = self.root.join(format!("staging-{}", self.made.len()));
            fs::create_dir_all(&dir).unwrap();
            self.made.push(dir.clone());
            Ok(dir)
        }
        fn download(&mut self, _: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String> {
            self.download_calls += 1;
            let body = self.downloads.pop_front().expect("no more download answers")?;
            let mut written = Vec::new();
            for chunk in body.chunks(4) {
                written.extend_from_slice(chunk);
                if !received(written.len() as u64) {
                    fs::write(to, &written).unwrap();
                    return Err("stopped".into());
                }
            }
            fs::write(to, &written).unwrap();
            Ok(())
        }
        fn unpack(&mut self, _: &Path, archive: &Path, into: &Path) -> Result<(), String> {
            self.unpack.clone()?;
            fs::create_dir_all(into).unwrap();
            fs::remove_file(archive).unwrap();
            if self.launcher {
                fs::write(into.join("Harness.exe"), b"MZ").unwrap();
            }
            Ok(())
        }
        fn install(&mut self, launcher: &Path) -> Result<i32, String> {
            self.installed.push(launcher.to_path_buf());
            self.exit.clone()
        }
        fn remove(&mut self, dir: &Path) -> Result<(), String> {
            if self.remove_fails {
                return Err("held by another program".into());
            }
            fs::remove_dir_all(dir).map_err(|err| err.to_string())
        }
        fn pause(&mut self, _: Duration) {
            self.pauses += 1;
        }
    }

    #[derive(Default)]
    struct Seen {
        steps: Vec<Step>,
        log: Vec<String>,
        progress: Vec<(u64, u64)>,
        cancel: Cell<bool>,
        cancel_at_byte: Option<u64>,
        cancel_at_step: Option<Step>,
    }

    impl Report for Seen {
        fn step(&mut self, step: Step) {
            self.steps.push(step);
            if self.cancel_at_step == Some(step) {
                self.cancel.set(true);
            }
        }
        fn progress(&mut self, received: u64, total: u64) {
            self.progress.push((received, total));
            if self.cancel_at_byte.is_some_and(|at| received >= at) {
                self.cancel.set(true);
            }
        }
        fn cancelled(&self) -> bool {
            self.cancel.get()
        }
        fn log(&mut self, line: &str) {
            self.log.push(line.to_owned());
        }
    }

    fn published() -> Source {
        Source::Https(format!("{PRODUCTION_BASE}desktop/metadata.json"))
    }

    fn go(fake: &mut Fake, seen: &mut Seen) -> Finished {
        run(fake, seen, &published(), false)
    }

    fn failed(finished: &Finished) -> (Step, &str) {
        match &finished.outcome {
            Outcome::Failed { step, message } => (*step, message.as_str()),
            other => panic!("not a failure: {other:?}"),
        }
    }

    #[test]
    fn installs_in_order_and_removes_its_temp_folder() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!(finished.exit_code(), model::EXIT_OK);
        assert_eq!(seen.steps, [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install]);
        assert_eq!(fake.installed.len(), 1);
        assert!(fake.installed[0].ends_with(Path::new("zip").join("Harness.exe")));
        assert!(fake.made.iter().all(|dir| !dir.exists()));
        assert_eq!(seen.progress.last(), Some(&(BODY.len() as u64, BODY.len() as u64)));
        assert!(seen.log.contains(&"Installing the Harness desktop app 1.4.0 for win32-x64 (desktop-windows-x64)".to_owned()));
        assert_eq!(seen.log.last().unwrap(), "Harness 1.4.0 is installed, and it is opening now.");
    }

    #[test]
    fn an_old_windows_or_a_missing_tar_stops_before_anything_is_downloaded() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.build = 17134;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Check);
        assert!(failed(&finished).1.contains("build 17134"));
        assert!(fake.made.is_empty());

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.tar = false;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Check, model::missing_tar(&model::tar_path(Path::new("W"))).as_str()));
        assert_eq!(fake.download_calls, 0);
    }

    #[test]
    fn a_manifest_read_gets_three_tries_over_the_network_and_one_from_a_file() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Err("timed out".into()), Err("reset".into()), Err("refused".into())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Manifest, "refused"));
        assert_eq!(fake.pauses, 2);
        assert!(seen.log.contains(&"Connection interrupted; retrying (3/3)...".to_owned()));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Err("The manifest m.json does not exist.".into())]);
        let finished = run(&mut fake, &mut seen, &Source::File("m.json".into()), false);
        assert_eq!(failed(&finished), (Step::Manifest, "The manifest m.json does not exist."));
        assert_eq!(fake.pauses, 0);
    }

    #[test]
    fn a_manifest_that_is_not_json_or_has_no_app_for_this_pc_fails_its_step() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(b"<html>".to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Manifest);
        assert!(failed(&finished).1.starts_with("The manifest https://storage.googleapis.com/"));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(b"{}".to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(
            failed(&finished),
            (Step::Manifest, "The desktop manifest has no Harness desktop app for this computer (win32-x64) yet.")
        );
    }

    #[test]
    fn a_download_outside_harnesss_folders_is_never_fetched() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.manifest = VecDeque::from([Ok(manifest_for("https://example.com/x.zip", 1, &sha(b"x")))]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished).0, Step::Download);
        assert_eq!(fake.download_calls, 0);
        assert!(fake.made.is_empty());
    }

    #[test]
    fn a_dropped_download_is_tried_again_from_the_start() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Err("reset".into()), Err("reset".into()), Ok(BODY.to_vec())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!((fake.download_calls, fake.pauses), (3, 2));
    }

    #[test]
    fn a_download_whose_hash_differs_is_not_installed() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok(b"another body, same length!!!!!!!".to_vec())]);
        assert_eq!(BODY.len(), 32);
        let finished = go(&mut fake, &mut seen);
        let (step, message) = failed(&finished);
        assert_eq!(step, Step::Download);
        assert!(message.starts_with(&format!("{URL} failed its checksum (expected {}", sha(BODY))), "{message}");
        assert!(fake.installed.is_empty());
        assert!(fake.made.iter().all(|dir| !dir.exists()));
    }

    #[test]
    fn a_body_past_its_size_stops_at_once_and_is_not_tried_again() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.downloads = VecDeque::from([Ok([BODY, b"more"].concat())]);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(
            failed(&finished),
            (Step::Download, format!("{URL} is 36 bytes, but the manifest says 32: the download is incomplete, or is not the published file.").as_str())
        );
        assert_eq!(fake.download_calls, 1);
        assert!(seen.progress.iter().all(|(received, total)| received <= total));
    }

    #[test]
    fn cancel_during_the_download_installs_nothing_and_removes_the_temp_folder() {
        let (mut fake, mut seen) = (Fake::new(), Seen { cancel_at_byte: Some(8), ..Seen::default() });
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Cancelled);
        assert_eq!(finished.exit_code(), model::EXIT_CANCELLED);
        assert_eq!(fake.download_calls, 1);
        assert!(!seen.steps.contains(&Step::Unpack));
        assert!(fake.installed.is_empty());
        assert!(fake.made.iter().all(|dir| !dir.exists()));
    }

    #[test]
    fn a_cancel_once_the_install_has_started_does_not_stop_it() {
        let (mut fake, mut seen) = (Fake::new(), Seen { cancel_at_step: Some(Step::Install), ..Seen::default() });
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.outcome, Outcome::Installed { version: "1.4.0".into() });
        assert_eq!(fake.installed.len(), 1);
    }

    #[test]
    fn an_archive_that_does_not_unpack_or_has_no_launcher_fails_unpacking() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.unpack = Err("Could not unpack x (tar.exe exit code 1).".into());
        assert_eq!(failed(&go(&mut fake, &mut seen)), (Step::Unpack, "Could not unpack x (tar.exe exit code 1)."));

        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.launcher = false;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Unpack, model::no_launcher().as_str()));
        assert!(fake.installed.is_empty());
    }

    #[test]
    fn a_failed_install_points_at_the_launchers_log() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.exit = Ok(1);
        let finished = go(&mut fake, &mut seen);
        assert_eq!(failed(&finished), (Step::Install, model::install_stopped(1, "L").as_str()));
        assert_eq!(
            finished.lines()[..1],
            ["Harness could not be installed. The step that failed: Installing Harness.".to_owned()]
        );
    }

    #[test]
    fn a_temp_folder_it_could_not_remove_is_said_without_changing_the_result() {
        let (mut fake, mut seen) = (Fake::new(), Seen::default());
        fake.remove_fails = true;
        let finished = go(&mut fake, &mut seen);
        assert_eq!(finished.exit_code(), model::EXIT_OK);
        let (dir, why) = finished.left.clone().unwrap();
        assert_eq!(dir, fake.made[0]);
        assert_eq!(why, "held by another program");
        let lines = finished.lines();
        assert_eq!(lines[1], format!("Temporary files remain at {}.", fake.made[0].display()));
        assert_eq!(lines[2], "Harness was installed and can be used.");
        fs::remove_dir_all(&fake.root).unwrap();
    }
}
```

and in `installer/src/main.rs`, under `mod model;`: `mod flow;`

- [ ] **Step 2: Run them to see them fail**

Run: `cd installer && cargo test flow`
Expected: FAIL to compile: `Host`, `Report`, `run`, `Outcome` and `Finished` are not defined.

- [ ] **Step 3: The steps**

Above the test module in `installer/src/flow.rs`:

```rust
//! The install, step by step (spec §1.1 and §1.2), over a [Host] that does the Windows work and a [Report] that
//! shows it. Every decision is here, so the tests run it on any OS with a stand-in host; windows.rs only talks to
//! Windows.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::model::{self, Source, Step};

pub trait Host {
    fn windows_build(&self) -> u32;
    fn system_root(&self) -> PathBuf;
    fn machine(&self) -> model::Machine;
    fn local_app_data(&self) -> String;
    fn is_file(&self, path: &Path) -> bool;
    /// The manifest's bytes, at most [model::MANIFEST_LIMIT].
    fn read(&mut self, source: &Source) -> Result<Vec<u8>, String>;
    /// A new, empty temp folder.
    fn staging(&mut self) -> Result<PathBuf, String>;
    /// Writes [source] to [to], calling [received] with the running byte count; stops (with an error) as soon as
    /// it returns false.
    fn download(&mut self, source: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String>;
    /// Unpacks [archive] into [into] with [tar]; the archive is gone afterwards.
    fn unpack(&mut self, tar: &Path, archive: &Path, into: &Path) -> Result<(), String>;
    /// Runs `<launcher> --install` and waits for it: its exit code.
    fn install(&mut self, launcher: &Path) -> Result<i32, String>;
    fn remove(&mut self, dir: &Path) -> Result<(), String>;
    fn pause(&mut self, time: Duration);
}

pub trait Report {
    fn step(&mut self, step: Step);
    fn progress(&mut self, received: u64, total: u64);
    fn cancelled(&self) -> bool;
    fn log(&mut self, line: &str);
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed { version: String },
    Failed { step: Step, message: String },
    Cancelled,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Finished {
    pub outcome: Outcome,
    /// The temp folder, when it could not be removed, and why.
    pub left: Option<(PathBuf, String)>,
}

impl Finished {
    pub fn exit_code(&self) -> i32 {
        match self.outcome {
            Outcome::Installed { .. } => model::EXIT_OK,
            Outcome::Failed { .. } => model::EXIT_FAILED,
            Outcome::Cancelled => model::EXIT_CANCELLED,
        }
    }

    /// What the person reads at the end: install.ps1's closing lines, in the same words.
    pub fn lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        match &self.outcome {
            Outcome::Installed { version } => lines.push(format!("Harness {version} is installed, and it is opening now.")),
            Outcome::Failed { step, message } => {
                lines.push(format!("Harness could not be installed. The step that failed: {}.", step.name()));
                lines.push(message.clone());
            }
            Outcome::Cancelled => lines.push("The install was cancelled. Nothing was installed.".to_owned()),
        }
        if let Some((dir, why)) = &self.left {
            lines.push(format!("Temporary files remain at {}.", dir.display()));
            lines.push(match self.outcome {
                Outcome::Installed { .. } => "Harness was installed and can be used.".to_owned(),
                _ => "The install failed for the reason above.".to_owned(),
            });
            lines.push(format!("Close anything using that folder, then remove it. {why}"));
        }
        lines
    }
}

fn sha256_of(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buffer).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        length += read as u64;
    }
    let hex = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    Ok((length, hex))
}

/// Runs the install once. The temp folder is removed whatever happened, and said when it could not be.
pub fn run(host: &mut impl Host, report: &mut impl Report, manifest: &Source, staging_build: bool) -> Finished {
    let mut staging = None;
    let outcome = attempt(host, report, manifest, staging_build, &mut staging);
    let left = staging.and_then(|dir| host.remove(&dir).err().map(|why| (dir, why)));
    let finished = Finished { outcome, left };
    for line in finished.lines() {
        report.log(&line);
    }
    finished
}

/// Why a step stopped.
#[derive(Debug)]
enum Stop {
    Failed(String),
    Cancelled,
}

/// A network read gets [model::ATTEMPTS] tries, as install.ps1's Invoke-HarnessRetry gives it; a file gets one.
fn attempts(source: &Source) -> u32 {
    if matches!(source, Source::Https(_)) { model::ATTEMPTS } else { 1 }
}

fn retrying(host: &mut impl Host, report: &mut impl Report, why: &str, next: u32, total: u32) {
    report.log(why);
    report.log(&format!("Connection interrupted; retrying ({next}/{total})..."));
    host.pause(Duration::from_secs(2));
}

fn enter(report: &mut impl Report, step: &mut Step, next: Step) -> Result<(), Stop> {
    if report.cancelled() {
        return Err(Stop::Cancelled);
    }
    *step = next;
    report.step(next);
    report.log(&format!("{}…", next.name()));
    Ok(())
}

fn attempt(
    host: &mut impl Host,
    report: &mut impl Report,
    manifest: &Source,
    staging_build: bool,
    staging: &mut Option<PathBuf>,
) -> Outcome {
    let mut step = Step::Check;
    match steps(host, report, manifest, staging_build, staging, &mut step) {
        Ok(version) => Outcome::Installed { version },
        Err(Stop::Cancelled) => Outcome::Cancelled,
        Err(Stop::Failed(_)) if report.cancelled() && step != Step::Install => Outcome::Cancelled,
        Err(Stop::Failed(message)) => Outcome::Failed { step, message },
    }
}

fn steps(
    host: &mut impl Host,
    report: &mut impl Report,
    manifest: &Source,
    staging_build: bool,
    staging: &mut Option<PathBuf>,
    step: &mut Step,
) -> Result<String, Stop> {
    enter(report, step, Step::Check)?;
    model::check_build(host.windows_build()).map_err(Stop::Failed)?;
    let tar = model::tar_path(&host.system_root());
    if !host.is_file(&tar) {
        return Err(Stop::Failed(model::missing_tar(&tar)));
    }
    let machine = host.machine();

    enter(report, step, Step::Manifest)?;
    report.log(&format!("Manifest: {}", manifest.display()));
    let (total, mut tried) = (attempts(manifest), 1);
    let bytes = loop {
        match host.read(manifest) {
            Ok(bytes) => break bytes,
            Err(why) if tried < total && !report.cancelled() => {
                tried += 1;
                retrying(host, report, &why, tried, total);
            }
            Err(why) => return Err(Stop::Failed(why)),
        }
    };
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|err| Stop::Failed(format!("The manifest {} is not valid JSON: {err}", manifest.display())))?;
    let entry = model::select_entry(&document, machine).map_err(Stop::Failed)?;
    report.log(&format!(
        "Installing the Harness desktop app {} for {} ({})",
        entry.version,
        machine.platform(),
        entry.key
    ));

    enter(report, step, Step::Download)?;
    let source = model::resolve_ref(&entry.url, manifest, staging_build).map_err(Stop::Failed)?;
    let shown = source.display();
    model::check_sha256(&entry.sha256, &shown).map_err(Stop::Failed)?;
    let dir = host.staging().map_err(Stop::Failed)?;
    *staging = Some(dir.clone());
    let zip = dir.join("harness-desktop.zip");
    let limit = model::size_limit(entry.size);
    let (total, mut tried) = (attempts(&source), 1);
    let too_big = loop {
        let mut too_big = None;
        let result = {
            let mut received = |count: u64| {
                report.progress(count.min(limit), limit);
                if count > limit {
                    too_big = Some(count);
                    return false;
                }
                !report.cancelled()
            };
            host.download(&source, &zip, &mut received)
        };
        match result {
            Ok(()) => break None,
            // A body already past its size is wrong: the size check says so, with no other try.
            Err(_) if too_big.is_some() => break too_big,
            Err(_) if report.cancelled() => return Err(Stop::Cancelled),
            Err(why) if tried < total => {
                tried += 1;
                retrying(host, report, &why, tried, total);
            }
            Err(why) => return Err(Stop::Failed(why)),
        }
    };
    let (length, got) = match too_big {
        Some(count) => (count, String::new()),
        None => sha256_of(&zip).map_err(Stop::Failed)?,
    };
    model::check_download(&shown, length, entry.size, &got, &entry.sha256).map_err(Stop::Failed)?;

    enter(report, step, Step::Unpack)?;
    let folder = dir.join("zip");
    host.unpack(&tar, &zip, &folder).map_err(Stop::Failed)?;
    let launcher = folder.join("Harness.exe");
    if !host.is_file(&launcher) {
        return Err(Stop::Failed(model::no_launcher()));
    }

    // The last point a cancel is taken: Harness.exe --install stages and renames, and is not stopped halfway.
    enter(report, step, Step::Install)?;
    let code = host.install(&launcher).map_err(Stop::Failed)?;
    if code != 0 {
        return Err(Stop::Failed(model::install_stopped(code, &host.local_app_data())));
    }
    Ok(entry.version)
}
```

- [ ] **Step 4: Run the tests**

Run: `cd installer && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: PASS, 26 tests; clippy clean.

- [ ] **Step 5: Commit**

```bash
git add installer/src/flow.rs installer/src/main.rs
git commit -m "feat(windows): harness-install's steps, with install.ps1's retries, checks and closing lines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task F1.3: The Windows half, the window, and the executable's resources

**Files:**
- Create: `installer/src/windows.rs`, `installer/src/ui.rs`, `installer/build.rs`, `installer/harness-install.manifest`, `installer/tests/windows.rs`
- Modify: `installer/src/main.rs` (its final form), `.github/workflows/windows-desktop.yml` (one step in `build-test`)

**Interfaces:**
- Consumes: F1.1, F1.2. `HARNESS_DESKTOP_NO_DIALOG` (C, `pty/src/desktop/system.rs` `NO_DIALOG_ENV`). The icon `desktop/windows/runner/resources/app_icon.ico`.
- Produces: the binary `harness-install.exe` (`target/<profile>/harness-install.exe`, or `target/<target>/release/` with `--target`); `HARNESS_INSTALL_BASE` and `HARNESS_INSTALL_VERSION` read at build time; the session mutex `Local\HarnessInstall`; the log `%TEMP%\harness-install.log`; the window class `HarnessInstallWindow`.

- [ ] **Step 1: Write the failing integration tests**

`installer/tests/windows.rs`:

```rust
//! The built harness-install.exe in quiet mode, on real Windows (windows-desktop.yml, x64 and arm64). Each run gets
//! its own TEMP, which holds its log and its temp folder. The full install with the real launcher is
//! cli/src/scripts/installPs1App.spec.ts, held to the same expectations as install.ps1 -App.
#![cfg(windows)]

use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr::null;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use sha2::{Digest, Sha256};

const EXE: &str = env!("CARGO_BIN_EXE_harness-install");

/// One run at a time: the program takes a session-wide mutex, and a_second_copy_does_not_start_a_second_install
/// holds it on purpose.
fn one_at_a_time() -> MutexGuard<'static, ()> {
    static ONE: Mutex<()> = Mutex::new(());
    ONE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

/// A scratch folder whose name a shell or an ANSI code page would mangle (Review Focus 1).
fn scratch() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir()
        .join(format!("harness-install-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)))
        .join("Nguyễn Văn A' & 100% !x");
    fs::create_dir_all(dir.join("temp")).unwrap();
    dir
}

fn quiet(dir: &Path, manifest: Option<&Path>, args: &[&str]) -> (i32, String) {
    let temp = dir.join("temp");
    let mut command = Command::new(EXE);
    command.args(args).env("TEMP", &temp).env("TMP", &temp).env_remove("HARNESS_INSTALL_MANIFEST");
    if let Some(manifest) = manifest {
        command.env("HARNESS_INSTALL_MANIFEST", manifest);
    }
    let status = command.status().unwrap();
    let log = fs::read_to_string(temp.join("harness-install.log")).unwrap_or_default();
    (status.code().unwrap(), log)
}

fn staging_left(dir: &Path) -> Vec<String> {
    fs::read_dir(dir.join("temp"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".harness-desktop-staging-"))
        .collect()
}

/// A local manifest for [file], with its real size and hash unless [sha256] says otherwise.
fn manifest_for(dir: &Path, file: &str, sha256: Option<&str>) -> PathBuf {
    let bytes = fs::read(dir.join(file)).unwrap();
    let hash = sha256.map(str::to_owned).unwrap_or_else(|| Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect());
    let entry = serde_json::json!({ "version": "9.8.7", "url": file, "sha256": hash, "size": bytes.len() });
    let path = dir.join("metadata.json");
    fs::write(&path, serde_json::json!({ "desktop-windows-x64": entry, "desktop-windows-arm64": entry }).to_string()).unwrap();
    path
}

/// A zip with one file that is not Harness.exe, made by Windows' own tar.
fn zip_without_launcher(dir: &Path) {
    let content = dir.join("content");
    fs::create_dir_all(&content).unwrap();
    fs::write(content.join("readme.txt"), "not a Harness app").unwrap();
    let tar = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32").join("tar.exe");
    let made = Command::new(tar).args(["-a", "-cf", "..\\other.zip", "readme.txt"]).current_dir(&content).status().unwrap();
    assert!(made.success());
}

#[test]
fn an_unknown_argument_is_a_usage_error() {
    let _one = one_at_a_time();
    let dir = scratch();
    let (code, log) = quiet(&dir, None, &["--quiet", "--manifest"]);
    assert_eq!(code, 1);
    assert!(log.contains("usage: harness-install [--quiet]"), "{log}");
}

#[test]
fn a_manifest_that_does_not_exist_fails_reading_it() {
    let _one = one_at_a_time();
    let dir = scratch();
    let (code, log) = quiet(&dir, Some(&dir.join("missing.json")), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("Harness could not be installed. The step that failed: Reading the release manifest."), "{log}");
    assert!(log.contains("does not exist."), "{log}");
}

#[test]
fn a_download_whose_hash_differs_installs_nothing_and_leaves_no_temp_folder() {
    let _one = one_at_a_time();
    let dir = scratch();
    fs::write(dir.join("app.zip"), b"some bytes").unwrap();
    let manifest = manifest_for(&dir, "app.zip", Some(&"f".repeat(64)));
    let (code, log) = quiet(&dir, Some(&manifest), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("The step that failed: Downloading Harness."), "{log}");
    assert!(log.contains("failed its checksum"), "{log}");
    assert_eq!(staging_left(&dir), Vec::<String>::new());
}

// tar.exe runs inside the temp folder on an ASCII name: a profile path outside the ANSI code page reached it as '?'.
#[test]
fn unpacks_under_a_unicode_profile_and_refuses_a_zip_with_no_launcher() {
    let _one = one_at_a_time();
    let dir = scratch();
    zip_without_launcher(&dir);
    let manifest = manifest_for(&dir, "other.zip", None);
    let (code, log) = quiet(&dir, Some(&manifest), &["--quiet"]);
    assert_eq!(code, 1);
    assert!(log.contains("The step that failed: Unpacking Harness."), "{log}");
    assert!(log.contains("The download has no Harness.exe, so it is not a Harness desktop app."), "{log}");
    assert_eq!(staging_left(&dir), Vec::<String>::new());
}

#[test]
fn a_second_copy_does_not_start_a_second_install() {
    let _one = one_at_a_time();
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let held = unsafe { CreateMutexW(null(), 0, wide(std::ffi::OsStr::new("Local\\HarnessInstall")).as_ptr()) };
    assert!(!held.is_null());
    let dir = scratch();
    let (code, log) = quiet(&dir, Some(&dir.join("missing.json")), &["--quiet"]);
    unsafe { CloseHandle(held) };
    assert_eq!(code, 1);
    assert!(log.contains("Another Harness installer is already running."), "{log}");
    assert!(!log.contains("Reading the release manifest"), "{log}");
}

/// The resource Windows reads before it runs the program: never elevation, the themed controls, and the names
/// Explorer and SmartScreen show.
#[test]
fn the_executable_asks_for_no_elevation_and_names_harness() {
    let _one = one_at_a_time();
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows_sys::Win32::System::LibraryLoader::{
        FindResourceW, LOAD_LIBRARY_AS_DATAFILE, LoadLibraryExW, LoadResource, LockResource, SizeofResource,
    };
    let path = wide(std::ffi::OsStr::new(EXE));
    let module = unsafe { LoadLibraryExW(path.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_AS_DATAFILE) };
    assert!(!module.is_null());
    let found = unsafe { FindResourceW(module, 1 as _, 24 as _) };
    assert!(!found.is_null(), "no application manifest");
    let manifest = unsafe {
        let data = LockResource(LoadResource(module, found)) as *const u8;
        String::from_utf8_lossy(std::slice::from_raw_parts(data, SizeofResource(module, found) as usize)).into_owned()
    };
    assert!(manifest.contains(r#"level="asInvoker""#), "{manifest}");
    assert!(manifest.contains("Microsoft.Windows.Common-Controls"), "{manifest}");
    assert!(manifest.contains("PerMonitorV2"), "{manifest}");

    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
    assert!(size > 0, "no version resource");
    let mut block = vec![0u8; size as usize];
    assert_ne!(unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr() as *mut _) }, 0);
    let value = |name: &str| -> String {
        let query = wide(std::ffi::OsStr::new(&format!("\\StringFileInfo\\040904B0\\{name}")));
        let (mut text, mut length) = (std::ptr::null_mut(), 0u32);
        assert_ne!(unsafe { VerQueryValueW(block.as_ptr() as *const _, query.as_ptr(), &mut text, &mut length) }, 0, "{name}");
        let chars = unsafe { std::slice::from_raw_parts(text as *const u16, length as usize) };
        String::from_utf16_lossy(chars).trim_end_matches('\0').to_owned()
    };
    assert_eq!(value("FileDescription"), "Install Harness");
    assert_eq!(value("ProductName"), "Harness");
    assert_eq!(value("CompanyName"), "Autonomous");
    assert_eq!(value("OriginalFilename"), "harness-install.exe");
}
```

- [ ] **Step 2: The resources**

`installer/harness-install.manifest`:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- harness-install.exe's application manifest (spec §1.4). asInvoker: Windows' installer detection would
     otherwise ask for administrator rights for a program named *install*. Common Controls v6 draws the bar and
     buttons in the current style, and per-monitor DPI keeps the text sharp. -->
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Autonomous.Harness.Install" version="1.0.0.0"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 and 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
                        processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
```

`installer/build.rs`. It builds the resources only on a Windows host, whose SDK has `rc.exe`, so `cargo check --target x86_64-pc-windows-msvc` still works on a Mac:

```rust
//! The version and the base come from the release (spec §2.2); the resources are built only by a Windows host, whose
//! SDK has rc.exe. A check from another OS (cargo check --target x86_64-pc-windows-msvc) skips them.
use std::env;
use std::fs;
use std::path::PathBuf;

const PRODUCTION_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/";
const STAGING_BASE: &str = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/";

/// `X.Y.Z` or `X.Y.Z-prerelease`, as the desktop release names its versions: the numbers for the binary version.
fn numbers(version: &str) -> Option<[u16; 3]> {
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let identifier = |id: &str| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric());
    if prerelease.is_some_and(|p| !p.split('.').all(identifier)) {
        return None;
    }
    let parts: Vec<u16> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    <[u16; 3]>::try_from(parts).ok()
}

/// A path inside an .rc string: backslashes doubled.
fn rc_path(path: PathBuf) -> String {
    path.display().to_string().replace('\\', "\\\\")
}

fn main() {
    for name in ["HARNESS_INSTALL_BASE", "HARNESS_INSTALL_VERSION"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=harness-install.manifest");
    println!("cargo:rerun-if-changed=../desktop/windows/runner/resources/app_icon.ico");
    if let Ok(base) = env::var("HARNESS_INSTALL_BASE") {
        assert!(
            base == PRODUCTION_BASE || base == STAGING_BASE,
            "HARNESS_INSTALL_BASE must be {PRODUCTION_BASE} or {STAGING_BASE}, not {base}"
        );
    }
    let version = env::var("HARNESS_INSTALL_VERSION").unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
    let [major, minor, patch] =
        numbers(&version).unwrap_or_else(|| panic!("HARNESS_INSTALL_VERSION must be X.Y.Z or X.Y.Z-prerelease, not {version}"));
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || !cfg!(windows) {
        return;
    }
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let manifest = rc_path(crate_dir.join("harness-install.manifest"));
    let icon = rc_path(crate_dir.join("..").join("desktop").join("windows").join("runner").join("resources").join("app_icon.ico"));
    // Numbers, not <winres.h> names: rc.exe then needs no include path. 24 is RT_MANIFEST, 1 the process manifest.
    let script = format!(
        r#"1 ICON "{icon}"
1 24 "{manifest}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEFLAGSMASK 0x3F
FILEFLAGS 0x0
FILEOS 0x40004
FILETYPE 0x1
FILESUBTYPE 0x0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Autonomous"
      VALUE "FileDescription", "Install Harness"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "harness-install"
      VALUE "OriginalFilename", "harness-install.exe"
      VALUE "ProductName", "Harness"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("harness-install.rc");
    fs::write(&out, script).unwrap();
    embed_resource::compile(&out, embed_resource::NONE).manifest_required().unwrap();
}
```

- [ ] **Step 3: The Windows host, quiet mode and the entry point**

`installer/src/windows.rs`:

```rust
//! The Windows half (spec §1): the real [Host] (WinINet, `tar.exe`, `Harness.exe --install`), the log, the one-copy
//! rule, and the entry point that picks the window or quiet mode.

use std::env;
use std::ffi::{OsStr, c_void};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows_sys::Win32::Networking::WinInet::{
    HTTP_QUERY_FLAG_NUMBER, HTTP_QUERY_STATUS_CODE, HttpQueryInfoW, INTERNET_FLAG_NO_CACHE_WRITE,
    INTERNET_FLAG_NO_COOKIES, INTERNET_FLAG_NO_UI, INTERNET_FLAG_PRAGMA_NOCACHE, INTERNET_FLAG_RELOAD,
    INTERNET_FLAG_SECURE, INTERNET_OPEN_TYPE_PRECONFIG, INTERNET_OPTION_CONNECT_TIMEOUT,
    INTERNET_OPTION_RECEIVE_TIMEOUT, INTERNET_OPTION_SEND_TIMEOUT, InternetCloseHandle, InternetOpenUrlW,
    InternetOpenW, InternetReadFile, InternetSetOptionW,
};
use windows_sys::Win32::System::Diagnostics::Debug::{
    FORMAT_MESSAGE_FROM_HMODULE, FORMAT_MESSAGE_FROM_SYSTEM, FORMAT_MESSAGE_IGNORE_INSERTS, FormatMessageW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, IsWow64Process2};

use crate::flow::{self, Host, Report};
use crate::model::{self, Machine, Source};
use crate::ui;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const LOG_NAME: &str = "harness-install.log";
/// One installer per sign-in session: a double double-click must not run two installs into one folder.
pub const MUTEX_NAME: &str = "Local\\HarnessInstall";
/// Harness.exe says a failure in a message box unless this is set (pty/src/desktop/system.rs, NO_DIALOG_ENV). Quiet
/// mode sets it: nothing answers a dialog there, and the exit code and launch.log say it instead.
pub const NO_DIALOG_ENV: &str = "HARNESS_DESKTOP_NO_DIALOG";
/// A stalled connection fails after this: no byte at all, or none for this long in the middle.
const NETWORK_TIMEOUT_MS: u32 = 30_000;

pub fn wide(text: &str) -> Vec<u16> {
    OsStr::new(text).encode_wide().chain(Some(0)).collect()
}

/// The text Windows has for an error, from WinINet's own table first (its codes are not the system's).
fn error_text(code: u32) -> String {
    let module = unsafe { GetModuleHandleW(wide("wininet.dll").as_ptr()) };
    let mut buffer = [0u16; 512];
    let length = unsafe {
        FormatMessageW(
            FORMAT_MESSAGE_FROM_HMODULE | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            module as *const c_void,
            code,
            0,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            null(),
        )
    };
    let text = String::from_utf16_lossy(&buffer[..length as usize]);
    let text = text.trim();
    if text.is_empty() { format!("Windows error {code}") } else { format!("{text} (Windows error {code})") }
}

struct Internet(*mut c_void);

impl Drop for Internet {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { InternetCloseHandle(self.0) };
        }
    }
}

/// GET [url] over HTTPS with WinINet, handing each piece to [sink] until it says stop.
///
/// WinINet, not WinHTTP: it takes the person's own proxy settings (`INTERNET_OPEN_TYPE_PRECONFIG`), as Edge and
/// PowerShell 5.1 do. The program writes the bytes itself, so the file gets no Zone.Identifier: no file of the app is
/// marked as downloaded, and SmartScreen asks only about this program (spec §1.1, step 5). A redirect from https to
/// http fails: INTERNET_FLAG_SECURE without INTERNET_FLAG_IGNORE_REDIRECT_TO_HTTP.
fn fetch(url: &str, sink: &mut dyn FnMut(&[u8]) -> bool) -> Result<(), String> {
    let agent = wide(&format!("Harness-Install/{}", model::VERSION));
    let session = Internet(unsafe { InternetOpenW(agent.as_ptr(), INTERNET_OPEN_TYPE_PRECONFIG, null(), null(), 0) });
    if session.0.is_null() {
        return Err(format!("Could not start a download: {}", error_text(unsafe { GetLastError() })));
    }
    for option in [INTERNET_OPTION_CONNECT_TIMEOUT, INTERNET_OPTION_RECEIVE_TIMEOUT, INTERNET_OPTION_SEND_TIMEOUT] {
        let timeout = NETWORK_TIMEOUT_MS;
        unsafe { InternetSetOptionW(session.0, option, &timeout as *const u32 as *const c_void, 4) };
    }
    let flags = INTERNET_FLAG_RELOAD
        | INTERNET_FLAG_PRAGMA_NOCACHE
        | INTERNET_FLAG_NO_CACHE_WRITE
        | INTERNET_FLAG_NO_COOKIES
        | INTERNET_FLAG_NO_UI
        | INTERNET_FLAG_SECURE;
    let address = wide(url);
    let request = Internet(unsafe { InternetOpenUrlW(session.0, address.as_ptr(), null(), 0, flags, 0) });
    if request.0.is_null() {
        return Err(format!("Could not download {url}: {}", error_text(unsafe { GetLastError() })));
    }
    let mut status = 0u32;
    let mut length = 4u32;
    let asked = unsafe {
        HttpQueryInfoW(
            request.0,
            HTTP_QUERY_STATUS_CODE | HTTP_QUERY_FLAG_NUMBER,
            &mut status as *mut u32 as *mut c_void,
            &mut length,
            null_mut(),
        )
    };
    if asked == 0 || status != 200 {
        return Err(format!("{url} answered HTTP {status}, not the file."));
    }
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let mut read = 0u32;
        let ok = unsafe { InternetReadFile(request.0, buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32, &mut read) };
        if ok == 0 {
            return Err(format!("The download of {url} stopped: {}", error_text(unsafe { GetLastError() })));
        }
        if read == 0 {
            return Ok(());
        }
        if !sink(&buffer[..read as usize]) {
            return Err("stopped".to_owned());
        }
    }
}

pub struct Real;

impl Host for Real {
    fn windows_build(&self) -> u32 {
        let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        // RtlGetVersion: GetVersionExW answers what the manifest declares support for, not the build that runs.
        if unsafe { RtlGetVersion(&mut info) } == 0 { info.dwBuildNumber } else { 0 }
    }

    fn system_root(&self) -> PathBuf {
        env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
    }

    fn machine(&self) -> Machine {
        let (mut process, mut native) = (0u16, 0u16);
        if unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, &mut native) } == 0 {
            return Machine::X64;
        }
        Machine::from_native(native)
    }

    fn local_app_data(&self) -> String {
        env::var("LOCALAPPDATA").unwrap_or_else(|_| "%LOCALAPPDATA%".to_owned())
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn read(&mut self, source: &Source) -> Result<Vec<u8>, String> {
        let too_big = || format!("The manifest {} is larger than a manifest can be.", source.display());
        match source {
            Source::Https(url) => {
                let mut bytes = Vec::new();
                let mut full = false;
                fetch(url, &mut |piece| {
                    bytes.extend_from_slice(piece);
                    full = bytes.len() as u64 > model::MANIFEST_LIMIT;
                    !full
                })
                .map_err(|why| if full { too_big() } else { why })?;
                Ok(bytes)
            }
            Source::File(path) => match fs::metadata(path) {
                Ok(meta) if meta.is_file() && meta.len() > model::MANIFEST_LIMIT => Err(too_big()),
                Ok(meta) if meta.is_file() => {
                    fs::read(path).map_err(|err| format!("Could not read the manifest {}: {err}", path.display()))
                }
                _ => Err(format!("The manifest {} does not exist.", path.display())),
            },
        }
    }

    fn staging(&mut self) -> Result<PathBuf, String> {
        let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_nanos() / 100).unwrap_or(0);
        let dir = env::temp_dir().join(model::staging_name(std::process::id(), time));
        fs::create_dir_all(&dir).map_err(|err| format!("Could not create {}: {err}", dir.display()))?;
        Ok(dir)
    }

    fn download(&mut self, source: &Source, to: &Path, received: &mut dyn FnMut(u64) -> bool) -> Result<(), String> {
        let mut file = File::create(to).map_err(|err| format!("Could not create {}: {err}", to.display()))?;
        let mut count = 0u64;
        let mut failed_write = None;
        let mut sink = |piece: &[u8]| {
            if let Err(err) = file.write_all(piece) {
                failed_write = Some(format!("Could not write {}: {err}", to.display()));
                return false;
            }
            count += piece.len() as u64;
            received(count)
        };
        let result = match source {
            Source::Https(url) => fetch(url, &mut sink),
            // A local manifest's file (a test, a build of this tree) is copied, not downloaded.
            Source::File(path) => {
                let mut from = File::open(path).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
                let mut buffer = vec![0u8; 1 << 16];
                loop {
                    match from.read(&mut buffer) {
                        Ok(0) => break Ok(()),
                        Ok(read) if sink(&buffer[..read]) => {}
                        Ok(_) => break Err("stopped".to_owned()),
                        Err(err) => break Err(format!("Could not read {}: {err}", path.display())),
                    }
                }
            }
        };
        match failed_write {
            Some(why) => Err(why),
            None => result,
        }
    }

    fn unpack(&mut self, tar: &Path, archive: &Path, into: &Path) -> Result<(), String> {
        fs::create_dir_all(into).map_err(|err| format!("Could not create {}: {err}", into.display()))?;
        // tar.exe reads its arguments in the ANSI code page, so a profile path with a letter outside it reached it as
        // '?' and the archive could not be opened (install.ps1's Expand-HarnessZip, seen on the VM 2026-10-16). It
        // runs inside the folder on an ASCII name instead: the working directory is handed over in Unicode.
        let name = format!(".harness-archive-{}.zip", std::process::id());
        let local = into.join(&name);
        fs::rename(archive, &local).map_err(|err| format!("Could not move {}: {err}", archive.display()))?;
        let status = Command::new(tar)
            .args(["-xf", &name])
            .current_dir(into)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_file(&local);
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!(
                "Could not unpack {} (tar.exe exit code {}).",
                archive.display(),
                status.code().unwrap_or(-1)
            )),
            Err(err) => Err(format!("Could not run {}: {err}", tar.display())),
        }
    }

    fn install(&mut self, launcher: &Path) -> Result<i32, String> {
        Command::new(launcher)
            .arg("--install")
            .current_dir(launcher.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.code().unwrap_or(model::EXIT_FAILED))
            .map_err(|err| format!("Could not start {}: {err}", launcher.display()))
    }

    fn remove(&mut self, dir: &Path) -> Result<(), String> {
        fs::remove_dir_all(dir).map_err(|err| err.to_string())
    }

    fn pause(&mut self, time: Duration) {
        std::thread::sleep(time);
    }
}

/// `%TEMP%\harness-install.log`, rewritten by each run: the steps, the manifest, the chosen entry and any error.
pub struct Log {
    file: Option<File>,
    started: Instant,
}

impl Log {
    pub fn create() -> Log {
        Log { file: File::create(env::temp_dir().join(LOG_NAME)).ok(), started: Instant::now() }
    }

    pub fn line(&mut self, text: &str) {
        if let Some(file) = &mut self.file {
            let _ = writeln!(file, "[{:6.1}s] {text}", self.started.elapsed().as_secs_f64());
            let _ = file.flush();
        }
    }
}

/// Held for the run: the named mutex no second copy can create anew.
pub struct OneCopy(HANDLE);

impl OneCopy {
    /// None when another copy holds it. A mutex Windows will not create at all does not stop the install.
    pub fn take() -> Option<OneCopy> {
        let name = wide(MUTEX_NAME);
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if !handle.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe { CloseHandle(handle) };
            return None;
        }
        Some(OneCopy(handle))
    }
}

impl Drop for OneCopy {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

struct Quiet(Log);

impl Report for Quiet {
    fn step(&mut self, _: model::Step) {}
    fn progress(&mut self, _: u64, _: u64) {}
    fn cancelled(&self) -> bool {
        false
    }
    fn log(&mut self, line: &str) {
        self.0.line(line);
    }
}

pub fn main(args: &[String]) -> i32 {
    let mut log = Log::create();
    let staging = model::is_staging(model::BASE);
    log.line(&format!(
        "harness-install {} ({})",
        model::VERSION,
        if staging { "staging" } else { "production" }
    ));
    let mode = match model::parse(args) {
        Ok(mode) => mode,
        Err(usage) => {
            log.line(&usage);
            return model::EXIT_FAILED;
        }
    };
    let manifest = match model::manifest_source(env::var(model::MANIFEST_ENV).ok().as_deref(), model::BASE) {
        Ok(manifest) => manifest,
        Err(why) => {
            log.line(&why);
            if mode == model::Mode::Window {
                ui::say(&why);
            }
            return model::EXIT_FAILED;
        }
    };
    let Some(_copy) = OneCopy::take() else {
        log.line("Another Harness installer is already running.");
        if mode == model::Mode::Quiet {
            return model::EXIT_FAILED;
        }
        ui::bring_forward();
        return model::EXIT_OK;
    };
    match mode {
        model::Mode::Quiet => {
            // Still one thread: nothing else reads the environment while it changes.
            unsafe { env::set_var(NO_DIALOG_ENV, "1") };
            flow::run(&mut Real, &mut Quiet(log), &manifest, staging).exit_code()
        }
        model::Mode::Window => ui::run(log, manifest, staging),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_machine_is_the_pcs_own_even_when_this_program_runs_emulated() {
        // The registry keeps the native architecture for the whole system (install.ps1's Get-HarnessPlatform).
        let output = Command::new("reg")
            .args(["query", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment", "/v", "PROCESSOR_ARCHITECTURE"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).to_uppercase();
        let expected = if text.contains("ARM64") { Machine::Arm64 } else { Machine::X64 };
        assert_eq!(Real.machine(), expected);
    }

    #[test]
    fn this_windows_is_new_enough_and_has_its_tar() {
        assert!(model::check_build(Real.windows_build()).is_ok());
        assert!(Real.is_file(&model::tar_path(&Real.system_root())));
    }

    // The case that runs WinINet on CI: a local manifest's file is copied, not downloaded.
    #[test]
    fn downloads_over_https_with_no_mark_of_the_web() {
        let dir = env::temp_dir().join(format!("harness-install-wininet-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let to = dir.join("metadata.json");
        let url = format!("{}desktop/metadata.json", model::PRODUCTION_BASE);
        let mut last = 0;
        Real.download(&Source::Https(url.clone()), &to, &mut |count| {
            last = count;
            true
        })
        .unwrap();
        let bytes = fs::read(&to).unwrap();
        assert_eq!(bytes.len() as u64, last);
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap().is_object());
        let mut stream = to.clone().into_os_string();
        stream.push(":Zone.Identifier");
        assert!(File::open(PathBuf::from(stream)).is_err(), "the download is marked as from the internet");
        let manifest = Real.read(&Source::Https(url)).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&manifest).unwrap().is_object());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_address_fails_with_its_status() {
        let url = format!("{}desktop/no-such-file-{}.json", model::PRODUCTION_BASE, std::process::id());
        let why = Real.read(&Source::Https(url.clone())).unwrap_err();
        assert!(why.starts_with(&format!("{url} answered HTTP 404")), "{why}");
    }

    #[test]
    fn a_second_copy_finds_the_first() {
        let first = OneCopy::take().expect("the first copy takes the mutex");
        assert!(OneCopy::take().is_none());
        drop(first);
        assert!(OneCopy::take().is_some());
    }
}
```

- [ ] **Step 4: The window**

`installer/src/ui.rs`. `WM_DESTROY` is answered before the procedure takes the state, because `DestroyWindow` sends it while the procedure that called it still holds the state; any other message sent back while it is held gets Windows' default handling:

```rust
//! The window (spec §1.5): a status line, a progress bar, a detail box and up to two buttons, over a worker thread
//! that runs [flow::run] and posts each step. Plain Win32 with Common Controls v6 (from the manifest), so the
//! program stays one small file with nothing to install.

use std::cell::RefCell;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    COLOR_WINDOW, CreateFontIndirectW, DeleteObject, FW_SEMIBOLD, GetSysColor, GetSysColorBrush, HDC, HFONT,
    SetBkColor,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Controls::{
    ICC_PROGRESS_CLASS, INITCOMMONCONTROLSEX, InitCommonControlsEx, PBM_SETPOS, PBM_SETRANGE32,
};
use windows_sys::Win32::UI::HiDpi::{AdjustWindowRectExForDpi, GetDpiForSystem, SystemParametersInfoForDpi};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BS_DEFPUSHBUTTON, BS_PUSHBUTTON, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW,
    DestroyWindow, DispatchMessageW, ES_AUTOVSCROLL, ES_MULTILINE, ES_READONLY, FindWindowW, GetMessageW, IDCANCEL,
    IsDialogMessageW, LoadCursorW, LoadIconW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MSG, MessageBoxW,
    NONCLIENTMETRICSW, PostMessageW, PostQuitMessage, RegisterClassExW, SPI_GETNONCLIENTMETRICS, SPI_GETWORKAREA,
    SW_HIDE, SW_RESTORE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SendMessageW, SetForegroundWindow,
    SetWindowPos, SetWindowTextW, ShowWindow, SystemParametersInfoW, TranslateMessage, WM_APP, WM_CLOSE,
    WM_COMMAND, WM_CTLCOLORSTATIC, WM_DESTROY, WM_DPICHANGED, WM_SETFONT, WNDCLASSEXW, WS_CAPTION, WS_CHILD,
    WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU, WS_TABSTOP, WS_VISIBLE, IDC_ARROW,
};

use crate::flow::{self, Finished, Outcome, Report};
use crate::model::{self, Source, Step};
use crate::windows::{Log, Real, wide};

const CLASS: &str = "HarnessInstallWindow";
/// A static control's `&` is text, not an accelerator (WinUser.h; windows-sys keeps it in SystemServices).
const SS_NOPREFIX: u32 = 0x80;
const TITLE: &str = "Install Harness";
const WM_STEP: u32 = WM_APP + 1;
const WM_PROGRESS: u32 = WM_APP + 2;
const WM_DONE: u32 = WM_APP + 3;
/// Not 1 or 2: IsDialogMessageW sends IDOK and IDCANCEL for Enter and Esc.
const ID_PRIMARY: usize = 101;
const ID_SECONDARY: usize = 102;
const STEPS: [Step; 5] = [Step::Check, Step::Manifest, Step::Download, Step::Unpack, Step::Install];
/// The client area, in 96-DPI pixels.
const WIDTH: i32 = 460;
const HEIGHT: i32 = 200;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Working,
    /// Cancel was pressed: the window is hidden until the worker has removed its temp folder.
    Cancelling,
    Ended,
}

struct State {
    window: HWND,
    status: HWND,
    bar: HWND,
    detail: HWND,
    primary: HWND,
    secondary: HWND,
    fonts: [HFONT; 2],
    dpi: u32,
    phase: Phase,
    step: Step,
    cancel: Arc<AtomicBool>,
    finished: Arc<Mutex<Option<Finished>>>,
    log: Arc<Mutex<Log>>,
    manifest: Source,
    staging: bool,
    worker: Option<JoinHandle<()>>,
}

/// The exit code WM_DESTROY hands to the message loop. Outside [State]: DestroyWindow sends WM_DESTROY while the
/// procedure that called it still holds the state.
static EXIT: AtomicI32 = AtomicI32::new(model::EXIT_OK);

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// A message box for what goes wrong before the window exists.
pub fn say(text: &str) {
    let (text, title) = (wide(text), wide(TITLE));
    unsafe { MessageBoxW(null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND) };
}

/// A second copy shows the first one's window instead of starting a second install.
pub fn bring_forward() {
    let class = wide(CLASS);
    let window = unsafe { FindWindowW(class.as_ptr(), null()) };
    if !window.is_null() {
        unsafe {
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}

fn set_text(window: HWND, text: &str) {
    let text = wide(text);
    unsafe { SetWindowTextW(window, text.as_ptr()) };
}

fn scale(value: i32, dpi: u32) -> i32 {
    value * dpi as i32 / 96
}

fn fonts(dpi: u32) -> [HFONT; 2] {
    let mut metrics: NONCLIENTMETRICSW = unsafe { std::mem::zeroed() };
    metrics.cbSize = std::mem::size_of::<NONCLIENTMETRICSW>() as u32;
    unsafe {
        SystemParametersInfoForDpi(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            &mut metrics as *mut NONCLIENTMETRICSW as *mut _,
            0,
            dpi,
        )
    };
    let body = metrics.lfMessageFont;
    let mut heading = body;
    heading.lfWeight = FW_SEMIBOLD as i32;
    unsafe { [CreateFontIndirectW(&body), CreateFontIndirectW(&heading)] }
}

fn layout(state: &State) {
    let at = |control: HWND, x: i32, y: i32, w: i32, h: i32| unsafe {
        SetWindowPos(
            control,
            null_mut(),
            scale(x, state.dpi),
            scale(y, state.dpi),
            scale(w, state.dpi),
            scale(h, state.dpi),
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    };
    at(state.status, 20, 18, WIDTH - 40, 24);
    at(state.bar, 20, 50, WIDTH - 40, 16);
    at(state.detail, 20, 50, WIDTH - 40, HEIGHT - 50 - 56);
    at(state.primary, WIDTH - 20 - 100, HEIGHT - 20 - 28, 100, 28);
    at(state.secondary, WIDTH - 20 - 100 - 10 - 100, HEIGHT - 20 - 28, 100, 28);
    for (control, font) in [
        (state.status, state.fonts[1]),
        (state.detail, state.fonts[0]),
        (state.primary, state.fonts[0]),
        (state.secondary, state.fonts[0]),
    ] {
        unsafe { SendMessageW(control, WM_SETFONT, font as WPARAM, 1) };
    }
}

fn show(control: HWND, visible: bool) {
    unsafe { ShowWindow(control, if visible { SW_SHOW } else { SW_HIDE }) };
}

/// The working face: the step, the bar, and Cancel (greyed while Harness.exe --install runs).
fn working(state: &State) {
    set_text(state.status, state.step.status());
    show(state.bar, true);
    show(state.detail, false);
    set_text(state.primary, "Cancel");
    show(state.primary, true);
    unsafe { EnableWindow(state.primary, (state.step != Step::Install) as i32) };
    show(state.secondary, false);
}

/// The end face, when there is something to read: a failure, or files left behind.
fn ended(state: &State, finished: &Finished) {
    let mut detail = Vec::new();
    let heading = match &finished.outcome {
        Outcome::Installed { version } => format!("Harness {version} is installed, and it is opening now."),
        Outcome::Failed { step, message } => {
            detail.push(format!("The step that failed: {}.", step.name()));
            detail.push(message.clone());
            "Harness could not be installed.".to_owned()
        }
        Outcome::Cancelled => "The install was cancelled.".to_owned(),
    };
    detail.extend(finished.lines().into_iter().skip(if matches!(finished.outcome, Outcome::Failed { .. }) { 2 } else { 1 }));
    set_text(state.status, &heading);
    show(state.bar, false);
    set_text(state.detail, &detail.join("\r\n"));
    show(state.detail, true);
    set_text(state.primary, "Close");
    unsafe { EnableWindow(state.primary, 1) };
    let failed = matches!(finished.outcome, Outcome::Failed { .. });
    set_text(state.secondary, "Try again");
    show(state.secondary, failed);
    unsafe { SetFocus(if failed { state.secondary } else { state.primary }) };
}

struct Posting {
    window: usize,
    cancel: Arc<AtomicBool>,
    log: Arc<Mutex<Log>>,
    shown: u32,
}

impl Report for Posting {
    fn step(&mut self, step: Step) {
        let index = STEPS.iter().position(|s| *s == step).unwrap_or(0);
        unsafe { PostMessageW(self.window as HWND, WM_STEP, index, 0) };
    }

    fn progress(&mut self, received: u64, total: u64) {
        let permille = (received.min(total) * 1000).checked_div(total).unwrap_or(0) as u32;
        if permille != self.shown {
            self.shown = permille;
            unsafe { PostMessageW(self.window as HWND, WM_PROGRESS, permille as WPARAM, 0) };
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn log(&mut self, line: &str) {
        if let Ok(mut log) = self.log.lock() {
            log.line(line);
        }
    }
}

fn start(state: &mut State) {
    state.cancel.store(false, Ordering::SeqCst);
    state.phase = Phase::Working;
    state.step = Step::Check;
    unsafe { SendMessageW(state.bar, PBM_SETPOS, 0, 0) };
    working(state);
    let mut report = Posting {
        window: state.window as usize,
        cancel: state.cancel.clone(),
        log: state.log.clone(),
        shown: 0,
    };
    let (finished, manifest, staging, window) =
        (state.finished.clone(), state.manifest.clone(), state.staging, state.window as usize);
    state.worker = Some(std::thread::spawn(move || {
        let done = flow::run(&mut Real, &mut report, &manifest, staging);
        *finished.lock().unwrap() = Some(done);
        unsafe { PostMessageW(window as HWND, WM_DONE, 0, 0) };
    }));
}

fn finish(state: &State, exit: i32) {
    EXIT.store(exit, Ordering::SeqCst);
    unsafe { DestroyWindow(state.window) };
}

/// Cancel, Esc and the close box. During Harness.exe --install they do nothing: it is not stopped halfway.
fn close(state: &mut State) {
    match state.phase {
        Phase::Working if state.step == Step::Install => {}
        Phase::Working => {
            state.phase = Phase::Cancelling;
            state.cancel.store(true, Ordering::SeqCst);
            show(state.window, false);
        }
        Phase::Cancelling => {}
        Phase::Ended => finish(state, EXIT.load(Ordering::SeqCst)),
    }
}

fn done(state: &mut State) {
    if let Some(worker) = state.worker.take() {
        let _ = worker.join();
    }
    let Some(finished) = state.finished.lock().unwrap().take() else { return };
    let exit = finished.exit_code();
    let quiet_end = finished.left.is_none() && !matches!(finished.outcome, Outcome::Failed { .. });
    if state.phase == Phase::Cancelling || quiet_end {
        // Installed (the app is opening) or cancelled: nothing more to read.
        return finish(state, if state.phase == Phase::Cancelling { model::EXIT_CANCELLED } else { exit });
    }
    state.phase = Phase::Ended;
    EXIT.store(exit, Ordering::SeqCst);
    ended(state, &finished);
}

unsafe extern "system" fn procedure(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(EXIT.load(Ordering::SeqCst)) };
        return 0;
    }
    // A message sent while the procedure already holds the state (a ShowWindow or SetWindowPos it called) gets
    // Windows' default handling.
    let handled = STATE.with(|cell| {
        let mut slot = cell.try_borrow_mut().ok()?;
        let state = slot.as_mut()?;
        match message {
            WM_STEP => {
                state.step = STEPS.get(wparam).copied().unwrap_or(Step::Check);
                if state.phase == Phase::Working {
                    working(state);
                }
                if matches!(state.step, Step::Unpack | Step::Install) {
                    unsafe { SendMessageW(state.bar, PBM_SETPOS, 1000, 0) };
                }
                Some(0)
            }
            WM_PROGRESS => {
                unsafe { SendMessageW(state.bar, PBM_SETPOS, wparam, 0) };
                Some(0)
            }
            WM_DONE => {
                done(state);
                Some(0)
            }
            WM_COMMAND => {
                match wparam & 0xffff {
                    ID_PRIMARY => close(state),
                    id if id == IDCANCEL as usize => close(state),
                    ID_SECONDARY if state.phase == Phase::Ended => start(state),
                    _ => {}
                }
                Some(0)
            }
            WM_CLOSE => {
                close(state);
                Some(0)
            }
            WM_CTLCOLORSTATIC => {
                // The read-only detail box and the labels on the window's own background.
                unsafe { SetBkColor(wparam as HDC, GetSysColor(COLOR_WINDOW) as COLORREF) };
                Some(unsafe { GetSysColorBrush(COLOR_WINDOW) } as LRESULT)
            }
            WM_DPICHANGED => {
                state.dpi = ((wparam >> 16) & 0xffff) as u32;
                let suggested = unsafe { &*(lparam as *const RECT) };
                unsafe {
                    SetWindowPos(
                        window,
                        null_mut(),
                        suggested.left,
                        suggested.top,
                        suggested.right - suggested.left,
                        suggested.bottom - suggested.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                };
                let old = std::mem::replace(&mut state.fonts, fonts(state.dpi));
                layout(state);
                for font in old {
                    unsafe { DeleteObject(font) };
                }
                Some(0)
            }
            _ => None,
        }
    });
    match handled {
        Some(result) => result,
        None => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

fn child(parent: HWND, class: &str, text: &str, style: u32, id: usize) -> HWND {
    let (class, text) = (wide(class), wide(text));
    unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            text.as_ptr(),
            WS_CHILD | style,
            0,
            0,
            0,
            0,
            parent,
            id as _,
            GetModuleHandleW(null()),
            null(),
        )
    }
}

pub fn run(log: Log, manifest: Source, staging: bool) -> i32 {
    let controls = INITCOMMONCONTROLSEX {
        dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_PROGRESS_CLASS,
    };
    unsafe { InitCommonControlsEx(&controls) };
    let instance = unsafe { GetModuleHandleW(null()) };
    let class = wide(CLASS);
    let icon = unsafe { LoadIconW(instance, 1 as _) };
    let registered = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(procedure),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: icon,
        hCursor: unsafe { LoadCursorW(null_mut(), IDC_ARROW) },
        hbrBackground: unsafe { GetSysColorBrush(COLOR_WINDOW) },
        lpszMenuName: null(),
        lpszClassName: class.as_ptr(),
        hIconSm: icon,
    };
    unsafe { RegisterClassExW(&registered) };

    let dpi = unsafe { GetDpiForSystem() };
    let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    let mut frame = RECT { left: 0, top: 0, right: scale(WIDTH, dpi), bottom: scale(HEIGHT, dpi) };
    unsafe { AdjustWindowRectExForDpi(&mut frame, style, 0, 0, dpi) };
    let (width, height) = (frame.right - frame.left, frame.bottom - frame.top);
    let mut area = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let centred = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut RECT as *mut _, 0) } != 0;
    let (x, y) = if centred {
        (area.left + (area.right - area.left - width) / 2, area.top + (area.bottom - area.top - height) / 2)
    } else {
        (CW_USEDEFAULT, CW_USEDEFAULT)
    };
    let title = wide(TITLE);
    let window = unsafe {
        CreateWindowExW(0, class.as_ptr(), title.as_ptr(), style, x, y, width, height, null_mut(), null_mut(), instance, null())
    };
    if window.is_null() {
        say("Harness could not open its installer window.");
        return model::EXIT_FAILED;
    }
    // SS_NOPREFIX: a path with '&' (a profile folder) is text, not an accelerator.
    let state = State {
        window,
        status: child(window, "STATIC", "", WS_VISIBLE | SS_NOPREFIX, 0),
        bar: child(window, "msctls_progress32", "", WS_VISIBLE, 0),
        detail: child(window, "EDIT", "", ES_MULTILINE as u32 | ES_READONLY as u32 | ES_AUTOVSCROLL as u32, 0),
        primary: child(window, "BUTTON", "Cancel", WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON as u32, ID_PRIMARY),
        secondary: child(window, "BUTTON", "Try again", WS_TABSTOP | BS_PUSHBUTTON as u32, ID_SECONDARY),
        fonts: fonts(dpi),
        dpi,
        phase: Phase::Working,
        step: Step::Check,
        cancel: Arc::new(AtomicBool::new(false)),
        finished: Arc::new(Mutex::new(None)),
        log: Arc::new(Mutex::new(log)),
        manifest,
        staging,
        worker: None,
    };
    unsafe { SendMessageW(state.bar, PBM_SETRANGE32, 0, 1000) };
    layout(&state);
    STATE.with(|cell| *cell.borrow_mut() = Some(state));
    STATE.with(|cell| start(cell.borrow_mut().as_mut().unwrap()));
    unsafe {
        ShowWindow(window, SW_SHOW);
        SetForegroundWindow(window);
    }

    let mut message: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut message, null_mut(), 0, 0) } > 0 {
        if unsafe { IsDialogMessageW(window, &message) } == 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    STATE.with(|cell| {
        if let Some(mut state) = cell.borrow_mut().take() {
            if let Some(worker) = state.worker.take() {
                let _ = worker.join();
            }
            for font in state.fonts {
                unsafe { DeleteObject(font) };
            }
        }
    });
    message.wParam as i32
}
```

- [ ] **Step 5: The entry point**

`installer/src/main.rs`, its final form:

```rust
//! harness-install.exe: downloads this PC's Harness desktop app and hands it to the zip's own `Harness.exe --install`
//! (docs/superpowers/specs/2026-10-19-windows-installer-design.md). A GUI program: opened from a browser's download,
//! it shows a window and no console.
#![cfg_attr(windows, windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod flow;
mod model;
#[cfg(windows)]
mod ui;
#[cfg(windows)]
mod windows;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    std::process::exit(windows::main(&args));
    #[cfg(not(windows))]
    {
        let _ = args;
        eprintln!("harness-install runs on Windows only");
        std::process::exit(model::EXIT_FAILED);
    }
}
```

- [ ] **Step 6: Check it from the Mac**

Run:

```bash
cd installer
cargo test
for t in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
  rustup target add "$t"
  cargo clippy --target "$t" --all-targets -- -D warnings
done
HARNESS_INSTALL_BASE=https://example.com/ cargo check 2>&1 | grep 'must be'
```

Expected: 26 tests pass; clippy clean for both targets; the last command prints `HARNESS_INSTALL_BASE must be …`: build.rs refuses any other base.

- [ ] **Step 7: Run it on the Windows runners**

In `.github/workflows/windows-desktop.yml`, job `build-test`, after the step `Harness.exe tests` and before `- uses: actions/setup-node@v7`:

```yaml
      # harness-install.exe (docs/superpowers/specs/2026-10-19-windows-installer-design.md §4.2): its logic, its
      # Windows calls (WinINet, the machine, the mutex), its resources and quiet runs, on each architecture.
      - name: harness-install.exe tests
        working-directory: installer
        run: |
          cargo test --locked
          if ($LASTEXITCODE -ne 0) { throw "harness-install tests failed ($LASTEXITCODE)" }
```

- [ ] **Step 8: Commit, push, and see both runners pass**

```bash
git add installer/src/windows.rs installer/src/ui.rs installer/src/main.rs installer/build.rs installer/harness-install.manifest installer/tests/windows.rs installer/Cargo.lock .github/workflows/windows-desktop.yml
git commit -m "feat(windows): harness-install.exe downloads, checks and installs the desktop app, with a window or quietly" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-desktop
```

Watch the `Windows desktop` run on the pushed head (the branch's temporary push trigger): `gh run watch <run> --exit-status`. Expected: on both runners `harness-install.exe tests` passes, 31 unit tests and 6 in `tests/windows.rs`; on the arm64 runner `the_machine_is_the_pcs_own…` passes with `Machine::Arm64`. If WinINet's download test fails on a runner with no route to the bucket, say so in the task report with the error; do not skip it.

### Task F1.4: Both installers, one set of expectations

**Files:**
- Modify: `cli/src/scripts/installPs1App.spec.ts`, `.github/workflows/windows-desktop.yml` (the `Install by one command` step)

**Interfaces:**
- Consumes: F1.1's `installer/tests/entry-vectors.json`; F1.3's debug build at `installer/target/debug/harness-install.exe`, or `HARNESS_INSTALL_BIN`.

- [ ] **Step 1: The spec**

Apply this diff to `cli/src/scripts/installPs1App.spec.ts` (`git apply`). It does three things:
- the three `Select-HarnessAppEntry` cases become one run of the shared vectors, in a single PowerShell (fourteen PowerShells would cost about 140 s on the ARM runner);
- the first install case's checks move into `expectInstalled`, so both installers are held to them;
- two cases run `harness-install.exe --quiet` in the same isolated world: the full install, and a checksum mismatch.

````diff
diff --git a/cli/src/scripts/installPs1App.spec.ts b/cli/src/scripts/installPs1App.spec.ts
--- a/cli/src/scripts/installPs1App.spec.ts
+++ b/cli/src/scripts/installPs1App.spec.ts
@@ -64,43 +64,21 @@ afterAll(() => {
 }, 180_000)
 
 // The six-call malformed-entry case took 137 seconds with slow ARM PowerShell startup.
+// One set of answers for both installers: installer/src/model.rs runs the same vectors against select_entry.
+const vectors = JSON.parse(readFileSync(join(process.cwd(), '..', 'installer', 'tests', 'entry-vectors.json'), 'utf8')) as
+  { name: string; platform: string; document: object; expect: string }[]
+
+// The fourteen-call vector case took about 140 seconds with slow ARM PowerShell startup, so it is one PowerShell.
 describe.runIf(windows)('install.ps1 -App selects the desktop zip', { timeout: 240_000 }, () => {
-  const entry = (arch: string, version: string) => ({ version, url: `https://cdn.example/${arch}.zip`, sha256: '0'.repeat(64), size: 1 })
-  function pick(document: object, platform: string): string {
-    const script = `$ErrorActionPreference = 'Stop'; . ${quote(installer)}; try { $e = Select-HarnessAppEntry -Document (${quote(JSON.stringify(document))} | ConvertFrom-Json) -Platform ${quote(platform)}; "$($e.version) $($e.url)" } catch { $_.Exception.Message }`
+  it('chooses what harness-install.exe chooses, for every shared vector', () => {
+    const script = `$ErrorActionPreference = 'Stop'; . ${quote(installer)}; ` +
+      `foreach ($v in (${quote(JSON.stringify(vectors))} | ConvertFrom-Json)) { ` +
+      `try { $e = Select-HarnessAppEntry -Document $v.document -Platform $v.platform; "$($e.version) $($e.url)" } catch { $_.Exception.Message } }`
     const result = powershell(script, { HARNESS_INSTALL_LIBRARY: '1' })
     expect(result.status, result.stderr).toBe(0)
-    return result.stdout
-  }
-
-  it('selects x64 only on x64 and reports when it is missing', () => {
-    const both = { 'desktop-windows-x64': entry('x64', '1.2.0'), 'desktop-windows-arm64': entry('arm64', '1.3.0') }
-    expect(pick(both, 'win32-x64')).toBe('1.2.0 https://cdn.example/x64.zip')
-    expect(pick({ 'desktop-windows-arm64': both['desktop-windows-arm64'] }, 'win32-x64'))
-      .toBe('The desktop manifest has no Harness desktop app for this computer (win32-x64) yet.')
-  })
-
-  it('selects the numeric newer core on arm64 and prefers arm64 on a tie', () => {
-    const doc = (x64: string, arm64: string) => ({ 'desktop-windows-x64': entry('x64', x64), 'desktop-windows-arm64': entry('arm64', arm64) })
-    expect(pick(doc('1.2.0', '1.3.0'), 'win32-arm64')).toBe('1.3.0 https://cdn.example/arm64.zip')
-    expect(pick(doc('1.10.0', '1.9.0'), 'win32-arm64')).toBe('1.10.0 https://cdn.example/x64.zip')
-    expect(pick(doc('1.3.0', '1.3.0'), 'win32-arm64')).toBe('1.3.0 https://cdn.example/arm64.zip')
-    expect(pick(doc('1.3.0', '1.3.0-rc.1'), 'win32-arm64')).toBe('1.3.0-rc.1 https://cdn.example/arm64.zip')
-  })
-
-  it('skips a malformed newer arm64 entry, including version overflow, to use valid x64', () => {
-    const x64 = entry('x64', '1.2.0')
-    for (const malformed of [
-      { ...entry('arm64', '1.9.0'), url: null },
-      { ...entry('arm64', '1.9.0'), sha256: null },
-      { ...entry('arm64', '1.9.0'), size: 'one' },
-      entry('arm64', '1.9.0junk'),
-      entry('arm64', '9999999999.0.0'),
-    ]) {
-      expect(pick({ 'desktop-windows-x64': x64, 'desktop-windows-arm64': malformed }, 'win32-arm64'))
-        .toBe('1.2.0 https://cdn.example/x64.zip')
-    }
-    expect(pick({}, 'win32-arm64')).toBe('The desktop manifest has no Harness desktop app for this computer (win32-arm64) yet.')
+    const got = result.stdout.split(/\r?\n/)
+    expect(got).toHaveLength(vectors.length)
+    vectors.forEach((vector, index) => expect(got[index], vector.name).toBe(vector.expect))
   })
 })
 
@@ -204,25 +182,33 @@ describe.runIf(windows)('install.ps1 -App runs the real launcher in an isolated
     return Number(powershell(script).stdout)
   }
 
-  it('installs the complete fixture, registers it, returns before the GUI exits, and leaves no staging', () => {
-    const w = world()
-    const app = join(w.install, 'app', '9.8.7', 'harness-desktop.exe')
-    ownedApps.push(app)
-    const oldPath = pathValue()
-    const oldTasks = taskSnapshot()
-    const started = Date.now()
-    const result = installApp(build('9.8.7'), w.env, ['-Desktop', '-NoService'])
-    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
-    expect((Date.now() - started) / 1000).toBeLessThan(90)
-    expect(result.stdout).toContain('Harness 9.8.7 is installed, and it is opening now.')
-    expect(readFileSync(join(w.install, 'current'))).toEqual(Buffer.from('9.8.7\r\n'))
-    for (const path of [join(w.install, 'Harness.exe'), join(w.install, 'Harness.ico'), app, join(w.install, 'app', '9.8.7', 'harness_pipe_io.dll'), join(w.programs, 'Harness.lnk')]) {
+  function harnessInstall(): string {
+    const candidates = [process.env.HARNESS_INSTALL_BIN, ...['debug', 'release'].map((profile) => join(process.cwd(), '..', 'installer', 'target', profile, 'harness-install.exe'))]
+    const found = candidates.find((path): path is string => !!path && existsSync(path))
+    if (!found) throw new Error('Build installer/ (cargo build) or set HARNESS_INSTALL_BIN')
+    return found
+  }
+
+  // harness-install.exe in quiet mode: no window, and its log in this world's TEMP.
+  function installExe(manifest: string, env: NodeJS.ProcessEnv) {
+    const run = spawnSync(harnessInstall(), ['--quiet'], {
+      encoding: 'utf8', env: cleanEnv({ ...env, HARNESS_INSTALL_MANIFEST: manifest }), timeout: 240_000,
+    })
+    const log = join(env.TEMP!, 'harness-install.log')
+    return { status: run.status, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
+  }
+
+  // What either installer leaves behind: the install, its registration and a running app, and nothing else.
+  function expectInstalled(w: ReturnType<typeof world>, version: string) {
+    const app = join(w.install, 'app', version, 'harness-desktop.exe')
+    expect(readFileSync(join(w.install, 'current'))).toEqual(Buffer.from(`${version}\r\n`))
+    for (const path of [join(w.install, 'Harness.exe'), join(w.install, 'Harness.ico'), app, join(w.install, 'app', version, 'harness_pipe_io.dll'), join(w.programs, 'Harness.lnk')]) {
       expect(existsSync(path)).toBe(true)
     }
     expect(query(`${w.registry}\\Classes\\harness`, 'URL Protocol').status).toBe(0)
     expect(registryValue(`${w.registry}\\Classes\\harness\\shell\\open\\command`, '').stdout).toBe(`"${join(w.install, 'Harness.exe')}" "%1"`)
     const uninstall = `${w.registry}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Harness`
-    expect(query(uninstall, 'DisplayVersion').stdout).toMatch(/DisplayVersion\s+REG_SZ\s+9\.8\.7/)
+    expect(query(uninstall, 'DisplayVersion').stdout).toMatch(new RegExp(`DisplayVersion\\s+REG_SZ\\s+${version.replace(/\./g, '\\.')}`))
     expect(registryValue(uninstall, 'DisplayIcon').stdout).toBe(`${join(w.install, 'Harness.ico')},0`)
     const shortcut = powershell(
       `$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject Shell.Application; ` +
@@ -238,10 +224,48 @@ describe.runIf(windows)('install.ps1 -App runs the real launcher in an isolated
       target: join(w.install, 'Harness.exe'), icon: join(w.install, 'Harness.ico'), index: 0,
     })
     expect(existsSync(join(w.home, '.harness'))).toBe(false)
+    expect(stagingLeft(w.temp)).toEqual([])
+    expect(running(app)).toBeGreaterThan(0)
+  }
+
+  it('installs the complete fixture, registers it, returns before the GUI exits, and leaves no staging', () => {
+    const w = world()
+    ownedApps.push(join(w.install, 'app', '9.8.7', 'harness-desktop.exe'))
+    const oldPath = pathValue()
+    const oldTasks = taskSnapshot()
+    const started = Date.now()
+    const result = installApp(build('9.8.7'), w.env, ['-Desktop', '-NoService'])
+    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
+    expect((Date.now() - started) / 1000).toBeLessThan(90)
+    expect(result.stdout).toContain('Harness 9.8.7 is installed, and it is opening now.')
+    expectInstalled(w, '9.8.7')
     expect(pathValue()).toBe(oldPath)
     expect(taskSnapshot()).toEqual(oldTasks)
+  })
+
+  // F's installer, held to install.ps1 -App's expectations (installer spec §4.2).
+  it('harness-install.exe installs the same fixture with the same result', () => {
+    const w = world()
+    ownedApps.push(join(w.install, 'app', '9.8.13', 'harness-desktop.exe'))
+    const oldPath = pathValue()
+    const started = Date.now()
+    const result = installExe(build('9.8.13'), w.env)
+    expect(result.status, result.log).toBe(0)
+    expect((Date.now() - started) / 1000).toBeLessThan(90)
+    expect(result.log).toContain('Harness 9.8.13 is installed, and it is opening now.')
+    expectInstalled(w, '9.8.13')
+    expect(pathValue()).toBe(oldPath)
+  })
+
+  it('harness-install.exe refuses a checksum mismatch with exit 1, names the step, and installs nothing', () => {
+    const w = world()
+    const result = installExe(build('9.8.14', true), w.env)
+    expect(result.status, result.log).toBe(1)
+    expect(result.log).toContain('Harness could not be installed. The step that failed: Downloading Harness.')
+    expect(result.log).toContain('failed its checksum')
+    expect(existsSync(w.install)).toBe(false)
+    expect(query(`${w.registry}\\Classes\\harness`, 'URL Protocol').status).not.toBe(0)
     expect(stagingLeft(w.temp)).toEqual([])
-    expect(running(app)).toBeGreaterThan(0)
   })
 
   it('rejects a checksum mismatch with exit 1 and no install or owned staging', () => {
````

- [ ] **Step 2: The workflow step builds nothing new, and names the binary**

In `.github/workflows/windows-desktop.yml`, the step `Install by one command (install.ps1 -App)`:
- its name becomes `Install by one command (install.ps1 -App) and by harness-install.exe`;
- `env:` gains `HARNESS_INSTALL_BIN: ${{ github.workspace }}\installer\target\debug\harness-install.exe`;
- after the line that throws `'Desktop launcher is missing'`, add:

```powershell
          # The harness-install.exe tests step built it.
          if (-not (Test-Path -LiteralPath $env:HARNESS_INSTALL_BIN -PathType Leaf)) { throw 'harness-install.exe is missing' }
```

- [ ] **Step 3: Typecheck on the Mac**

Run: `cd cli && npm run typecheck && npx vitest run src/scripts/installPs1App.spec.ts`
Expected: typecheck clean; the spec is skipped off Windows (9 skipped).

- [ ] **Step 4: Commit, push, and see it pass on Windows**

```bash
git add cli/src/scripts/installPs1App.spec.ts .github/workflows/windows-desktop.yml
git commit -m "test(windows): harness-install.exe and install.ps1 -App choose and install alike" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-desktop
```

Expected in the `Windows desktop` run, both runners: `installPs1App.spec.ts` 9 passed, among them `chooses what harness-install.exe chooses, for every shared vector`, `harness-install.exe installs the same fixture with the same result` and `harness-install.exe refuses a checksum mismatch…`.

---

## Phase F2: Windows in every desktop release

### Task F2.1: The release scripts count nine artifacts

**Files:**
- Modify: `scripts/verify-desktop-release.py`, `scripts/publish-desktop-manifest.py`, `scripts/desktop-release-candidate.py`, `scripts/check-desktop-candidate-gcs.py`, `scripts/check-desktop-publication-gcs.py` (its messages only; F2.2 gives it the Windows upload check)
- Test: `scripts/tests/test_desktop_verification.py`, `scripts/tests/test_desktop_release_candidate.py`

**Interfaces:**
- Produces (used by F2.2, F2.3):
  - `verification.KEYS` ends with `"desktop-windows-x64", "desktop-windows-arm64", "desktop-windows-installer"`;
  - `publisher.PARTS` gains `"windows-x64.json": {"desktop-windows-x64", "desktop-windows-installer"}` and `"windows-arm64.json": {"desktop-windows-arm64"}`;
  - `candidate.FILES` maps those keys to `Harness-windows-x64.zip`, `Harness-windows-arm64.zip`, `harness-install.exe`;
  - `candidate.BUILD_INPUTS` gains the trees `installer`, `pty`, `term`, `tui/vendor`;
  - `candidate.check_jobs` requires `build-windows (windows-latest, x64)`, `build-windows (windows-11-arm, arm64)` and `upload-windows`. These names are F2.2's job and matrix: change both together.

- [ ] **Step 1: Write the failing tests**

Apply to the two test files (`git apply`):

````diff
diff --git a/scripts/tests/test_desktop_verification.py b/scripts/tests/test_desktop_verification.py
--- a/scripts/tests/test_desktop_verification.py
+++ b/scripts/tests/test_desktop_verification.py
@@ -70,12 +70,12 @@ class DesktopVerificationTests(unittest.TestCase):
     def run_verification(self, **kwargs):
         return verify.verify("1.2.3", self.base + "/metadata.json", **kwargs)
 
-    def test_all_six_full_downloads_with_updater_agent_and_bounded_parallelism(self):
+    def test_all_nine_full_downloads_with_updater_agent_and_bounded_parallelism(self):
         receipt = self.run_verification(jobs=2)
         self.assertEqual(receipt["status"], "passed", receipt)
-        self.assertEqual(len(receipt["artifacts"]), 6)
+        self.assertEqual(len(receipt["artifacts"]), 9)
         self.assertEqual(self.peak, 2)
-        self.assertEqual(len(self.requests), 7)
+        self.assertEqual(len(self.requests), 10)
         self.assertTrue(all(agent == verify.USER_AGENT for _, agent in self.requests))
         self.assertTrue(all(item["actual_size"] == len(self.payload) for item in receipt["artifacts"]))
 
@@ -108,13 +108,14 @@ class DesktopVerificationTests(unittest.TestCase):
                 receipt = self.run_verification()
                 self.assertEqual(receipt["status"], "failed")
                 self.assertEqual(receipt["artifacts"][0]["status"], "failed")
-                self.assertEqual(sum(item["status"] == "passed" for item in receipt["artifacts"]), 5)
+                self.assertEqual(sum(item["status"] == "passed" for item in receipt["artifacts"]), 8)
                 self.manifest[verify.KEYS[0]] = original
 
     def test_transfer_deadline_fails_in_bounded_time(self):
         self.delay = 1.5
         start = time.monotonic()
-        receipt = self.run_verification(timeout=0.1, jobs=6)
+        # One wave, as with six downloads: two waves of nine sat at the 1.3 s bound on a loaded Mac.
+        receipt = self.run_verification(timeout=0.1, jobs=len(verify.KEYS))
         self.assertEqual(receipt["status"], "failed")
         self.assertLess(time.monotonic() - start, 1.3)
 
@@ -126,7 +127,7 @@ class DesktopVerificationTests(unittest.TestCase):
             self.assertEqual(code, 1)
             self.assertEqual(json.loads(receipt.read_text())["status"], "failed")
 
-    def test_internal_macos_scope_keeps_all_four_and_release_still_requires_six(self):
+    def test_internal_macos_scope_keeps_all_four_and_release_still_requires_nine(self):
         macos = tuple(key for key in verify.KEYS if key.startswith("desktop-macos"))
         manifest = {key: self.manifest[key] for key in macos}
         self.assertEqual(len(verify.entries_for_version(manifest, "1.2.3", keys=macos)), 4)
````

````diff
--- a/scripts/tests/test_desktop_release_candidate.py
+++ b/scripts/tests/test_desktop_release_candidate.py
@@ -29,12 +29,15 @@
 
 
 def tree_entry(path, number, kind='tree'):
+    # number is one character, repeated into the 40-character object id.
     return dict(path=path, sha=str(number) * 40, type=kind, mode='040000' if kind == 'tree' else '100644')
 
 
 TREES = {
     TREE: dict(sha=TREE, truncated=False, tree=[tree_entry('desktop', 1), tree_entry('scripts', 2),
-        tree_entry('.github', 3), tree_entry('mobile', 4)]),
+        tree_entry('.github', 3), tree_entry('mobile', 4), tree_entry('installer', 9), tree_entry('pty', 'd'),
+        tree_entry('term', 'e'), tree_entry('tui', 'f')]),
+    'f' * 40: dict(sha='f' * 40, truncated=False, tree=[tree_entry('vendor', 0), tree_entry('src', 'c')]),
     '3' * 40: dict(sha='3' * 40, truncated=False, tree=[tree_entry('actions', 5), tree_entry('workflows', 6)]),
     '6' * 40: dict(sha='6' * 40, truncated=False, tree=[tree_entry('release-desktop.yml', 7, 'blob')]),
     '4' * 40: dict(sha='4' * 40, truncated=False, tree=[tree_entry('pubspec.lock', 8, 'blob')]),
@@ -73,7 +76,8 @@
     return [dict(name=name, id=index, run_id=123, run_attempt=1, head_sha=SHA, status='completed', conclusion='success',
                  steps=[dict(conclusion='success')]) for index, name in enumerate(
                      ['version', 'preflight', 'build-macos', 'build-linux (ubuntu-22.04, x64)',
-                      'build-linux (ubuntu-22.04-arm, arm64)', 'candidate', 'cleanup'])]
+                      'build-linux (ubuntu-22.04-arm, arm64)', 'build-windows (windows-latest, x64)',
+                      'build-windows (windows-11-arm, arm64)', 'upload-windows', 'candidate', 'cleanup'])]
 
 
 class FakeGithub:
@@ -148,7 +152,7 @@
             with self.subTest(field=field), self.assertRaises(ValueError):
                 self.read(**{field: value})
 
-    def test_receipt_requires_all_six_verified_objects_with_exact_paths(self):
+    def test_receipt_requires_every_verified_object_with_exact_paths(self):
         mutations = [
             lambda r: r.update(status='failed'), lambda r: r.update(schema=1),
             lambda r: r.update(run_attempt=2), lambda r: r.update(source_sha='e' * 40),
@@ -188,7 +192,7 @@
         client = FakeGithub()
         candidate.find_candidate(client, VERSION, INPUTS, BUCKET, 456)
         paths = [path for path in client.calls if path.startswith('git/trees/')]
-        self.assertEqual(len(paths), 4)
+        self.assertEqual(len(paths), 5)
         self.assertEqual(len(paths), len(set(paths)))
         self.assertTrue(all('?' not in path for path in paths))
 
@@ -331,6 +335,9 @@
             'mobile/pubspec.lock': 'shared cache identity', '.gitattributes': '*.png binary\n',
             '.gitignore': 'build/\n', 'cli/main.ts': 'CLI', 'devices/firmware.c': 'firmware',
             'docs/guide.md': 'documentation',
+            'installer/src/main.rs': 'Windows installer', 'pty/src/bin/desktop-launcher.rs': 'Windows launcher',
+            'term/src/lib.rs': 'launcher dependency', 'tui/vendor/vte/src/lib.rs': 'patched dependency',
+            'tui/src/main.rs': 'terminal interface',
         }
         for path, content in self.files.items():
             file = self.root / path
@@ -354,7 +361,7 @@
                                       lambda sha: candidate.local_tree(sha, cwd=self.root))
 
     def test_unrelated_components_change_the_tree_without_invalidating_inputs(self):
-        for path in ['cli/main.ts', 'devices/firmware.c', 'docs/guide.md']:
+        for path in ['cli/main.ts', 'devices/firmware.c', 'docs/guide.md', 'tui/src/main.rs']:
             (self.root / path).write_text('unrelated new behavior')
         self.commit()
         self.assertNotEqual(self.git('rev-parse', 'HEAD^{tree}'), self.original_tree)
@@ -362,7 +369,7 @@
 
     def test_every_source_dependency_toolchain_and_packaging_scope_invalidates(self):
         for path in self.files:
-            if path.startswith(('cli/', 'devices/', 'docs/')):
+            if path.startswith(('cli/', 'devices/', 'docs/', 'tui/src/')):
                 continue
             with self.subTest(path=path):
                 before = self.inputs()
@@ -475,7 +482,7 @@
                     candidate.seal(VERSION, BUCKET, PREFIX, path, identity)
                 gcloud.assert_not_called()
                 (path / 'linux-arm64.json').unlink()
-                with self.assertRaisesRegex(ValueError, 'four platform manifests'):
+                with self.assertRaisesRegex(ValueError, 'expected 6 platform manifests'):
                     candidate.seal(VERSION, BUCKET, PREFIX, path, identity)
 
     def test_cleanup_never_selects_production_recent_unknown_or_unpinned_objects(self):
````

Why each change:
- verification: nine downloads and ten requests (the manifest, then nine). The deadline case keeps one wave (`jobs=len(KEYS)`): two waves of nine sat at its 1.3 s bound on a loaded Mac.
- candidate: the fixture tree gains the four new inputs (`tree_entry`'s object id is one repeated character, so the new ones use `9`, `d`, `e`, `f` and `0`); reading `tui/vendor` reads one more tree (four become five); `tui/src` is an unrelated change that must not invalidate a candidate; the required jobs gain Windows's three.

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest discover -s scripts/tests -p 'test_desktop_*.py'`
Expected: FAIL, 11 failures in six cases (measured when this plan was checked):
- `test_all_nine_full_downloads…` and the four subtests of `test_hash_size_and_http_failures…`: six downloads, not nine;
- `test_tree_lookup_is_nonrecursive…`: four trees read, not five (`BUILD_INPUTS` does not read `tui/vendor` yet);
- four subtests of `test_every_source_dependency…` (`installer/`, `pty/`, `term/`, `tui/vendor/`): a change there does not yet invalidate a candidate;
- `test_sealing_rejects_missing_platform…`: the message still says "four".

- [ ] **Step 3: The scripts**

Apply (`git apply`):

````diff
diff --git a/scripts/verify-desktop-release.py b/scripts/verify-desktop-release.py
--- a/scripts/verify-desktop-release.py
+++ b/scripts/verify-desktop-release.py
@@ -1,5 +1,5 @@
 #!/usr/bin/env python3
-"""Verify all six public Desktop downloads concurrently, without storing the binaries.
+"""Verify all nine public Desktop downloads concurrently, without storing the binaries.
 
 Uses the updater's Dart user agent, full SHA-256/size checks and curl's total
 transfer deadline (a socket idle timeout alone does not bound a slow transfer).
@@ -21,6 +21,7 @@ from urllib.parse import urlsplit
 KEYS = (
     "desktop-macos", "desktop-macos-dmg", "desktop-macos-arm64",
     "desktop-macos-arm64-dmg", "desktop-linux-x64", "desktop-linux-arm64",
+    "desktop-windows-x64", "desktop-windows-arm64", "desktop-windows-installer",
 )
 MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json"
 USER_AGENT = "Dart/3.13 (dart:io)"
@@ -136,7 +137,7 @@ def main(argv=None):
     parser.add_argument("version")
     parser.add_argument("--manifest-url", default=MANIFEST)
     parser.add_argument("--receipt", type=Path, default=Path(".harness/desktop-release-verification.json"))
-    parser.add_argument("--jobs", type=int, choices=range(1, 7), default=3)
+    parser.add_argument("--jobs", type=int, choices=range(1, len(KEYS) + 1), default=3)
     parser.add_argument("--timeout", type=int, choices=range(1, 301), default=90, metavar="SECONDS")
     args = parser.parse_args(argv)
     receipt = verify(args.version, args.manifest_url, args.jobs, args.timeout)
````

````diff
diff --git a/scripts/publish-desktop-manifest.py b/scripts/publish-desktop-manifest.py
--- a/scripts/publish-desktop-manifest.py
+++ b/scripts/publish-desktop-manifest.py
@@ -13,7 +13,7 @@ import subprocess
 import sys
 import tempfile
 
-# Use the same six-entry/schema contract as public download verification.
+# Use the same nine-entry/schema contract as public download verification.
 spec = importlib.util.spec_from_file_location("desktop_verification", Path(__file__).with_name("verify-desktop-release.py"))
 verification = importlib.util.module_from_spec(spec)
 spec.loader.exec_module(verification)
@@ -23,6 +23,9 @@ PARTS = {
     "macos-apple-silicon.json": {"desktop-macos-arm64", "desktop-macos-arm64-dmg"},
     "linux-x64.json": {"desktop-linux-x64"},
     "linux-arm64.json": {"desktop-linux-arm64"},
+    # The installer is built by the x64 job: one x64 program for every PC (installer spec, Decision 4).
+    "windows-x64.json": {"desktop-windows-x64", "desktop-windows-installer"},
+    "windows-arm64.json": {"desktop-windows-arm64"},
 }
 
 
@@ -78,7 +81,7 @@ def require_new_version(version, live, allow_initialize=False):
 def read_parts(directory, version):
     files = {path.name for path in directory.glob("*.json")}
     if files != set(PARTS):
-        raise ValueError(f"expected four platform manifests; missing={sorted(set(PARTS) - files)}, extra={sorted(files - set(PARTS))}")
+        raise ValueError(f"expected {len(PARTS)} platform manifests; missing={sorted(set(PARTS) - files)}, extra={sorted(files - set(PARTS))}")
     entries = {}
     for name, keys in PARTS.items():
         part = json.loads((directory / name).read_text())
@@ -124,7 +127,7 @@ def main(argv=None):
             print(f"Desktop {args.version} is newer than the live manifest")
         else:
             publish(args.manifest, args.version, args.parts, args.allow_initialize)
-            print(f"Published all six Desktop {args.version} entries to {args.manifest}")
+            print(f"Published all {len(verification.KEYS)} Desktop {args.version} entries to {args.manifest}")
     except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
         print(f"error: {error}", file=sys.stderr)
         return 1
````

````diff
diff --git a/scripts/desktop-release-candidate.py b/scripts/desktop-release-candidate.py
--- a/scripts/desktop-release-candidate.py
+++ b/scripts/desktop-release-candidate.py
@@ -35,6 +35,7 @@ WORKFLOW = '.github/workflows/release-desktop.yml'
 FILES = dict(zip(verification.KEYS, (
     'Harness-macos.zip', 'Harness-macos.dmg', 'Harness-macos-arm64.zip',
     'Harness-macos-arm64.dmg', 'Harness-linux-x64.AppImage', 'Harness-linux-arm64.AppImage',
+    'Harness-windows-x64.zip', 'Harness-windows-arm64.zip', 'harness-install.exe',
 )))
 PREFIX = r'harness/desktop-candidates/([1-9][0-9]*)-([1-9][0-9]*)-[0-9a-f]{32}'
 RETENTION = timedelta(days=7)
@@ -46,6 +47,11 @@ MAX_AGE_SECONDS = 1200
 BUILD_INPUTS = {
     'desktop': 'tree',
     'scripts': 'tree',
+    # Windows: Harness.exe (pty/, with the crates it builds from) and harness-install.exe (installer/).
+    'installer': 'tree',
+    'pty': 'tree',
+    'term': 'tree',
+    'tui/vendor': 'tree',
     '.github/actions': 'tree',
     WORKFLOW: 'blob',
     'mobile/pubspec.lock': None,  # included when present in the shared pub-cache key
@@ -216,7 +222,7 @@ def read_receipt(artifact, archive, run, repository, version, tree, inputs, buck
     require(timestamp(run['created_at']) <= created <= now and now - created < RETENTION, 'candidate is expired or has invalid timestamps')
     prefix = check_prefix(receipt['prefix'], run['id'], run['run_attempt'])
     entries = receipt['artifacts']
-    require(isinstance(entries, dict) and set(entries) == set(FILES), 'candidate does not contain exactly six artifacts')
+    require(isinstance(entries, dict) and set(entries) == set(FILES), f'candidate does not contain exactly {len(FILES)} artifacts')
     verification.entries_for_version(entries, version)
     for key, entry in entries.items():
         generation = entry.get('generation', '')
@@ -228,7 +234,8 @@ def read_receipt(artifact, archive, run, repository, version, tree, inputs, buck
 
 def check_jobs(run, jobs):
     required = {'version', 'preflight', 'build-macos', 'build-linux (ubuntu-22.04, x64)',
-                'build-linux (ubuntu-22.04-arm, arm64)', 'candidate', 'cleanup'}
+                'build-linux (ubuntu-22.04-arm, arm64)', 'build-windows (windows-latest, x64)',
+                'build-windows (windows-11-arm, arm64)', 'upload-windows', 'candidate', 'cleanup'}
     require(required <= {job['name'] for job in jobs}, 'candidate build/verification jobs are missing')
     for job in jobs:
         require(job.get('run_id') == run['id'] and job.get('head_sha') == run['head_sha']
@@ -401,7 +408,7 @@ def main(argv=None):
         require(args.parts is not None, 'sealing requires platform manifests')
         receipt = seal(args.version, args.bucket, args.prefix, args.parts, identity)
         Path('desktop-release-candidate.json').write_text(json.dumps(receipt, indent=2) + '\n')
-        print('All six candidate downloads passed; no product manifest was published')
+        print(f'All {len(FILES)} candidate downloads passed; no product manifest was published')
         return 0
     started = time.monotonic()
     client = Client(identity['repository'], started + args.wait_seconds + 90)
@@ -429,7 +436,7 @@ def main(argv=None):
                   candidate_run=receipt['run_id'], candidate_attempt=receipt['run_attempt'],
                   duration_seconds=round(time.monotonic() - started, 3))
     Path('desktop-candidate-reuse.json').write_text(json.dumps(result, indent=2) + '\n')
-    message = f'Reused all six verified packages from candidate {receipt["run_id"]} in {result["duration_seconds"]}s'
+    message = f'Reused all {len(FILES)} verified packages from candidate {receipt["run_id"]} in {result["duration_seconds"]}s'
     print(message)
     if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
         with open(summary, 'a') as stream:
````

````diff
diff --git a/scripts/check-desktop-candidate-gcs.py b/scripts/check-desktop-candidate-gcs.py
--- a/scripts/check-desktop-candidate-gcs.py
+++ b/scripts/check-desktop-candidate-gcs.py
@@ -1,5 +1,5 @@
 #!/usr/bin/env python3
-"""Exercise candidate sealing/promotion using six tiny run-owned GCS objects."""
+"""Exercise candidate sealing/promotion using one tiny run-owned GCS object per release artifact."""
 from datetime import datetime, timedelta, timezone
 import hashlib
 import importlib.util
@@ -42,14 +42,14 @@ def main():
             receipt = candidate.seal(version, bucket, prefix, root, identity)
             candidate.check_sources(receipt)
             candidate.promote(receipt, destination, scratch)
-            print('PASS: seal six source generations and promote their exact bytes', flush=True)
+            print(f'PASS: seal {len(candidate.FILES)} source generations and promote their exact bytes', flush=True)
             promoted = root / 'promoted'
             promoted.mkdir()
             gcloud('storage', 'cp', f'gs://{bucket}/{scratch}/*.json', str(promoted) + '/')
             candidate.publisher.publish(uri, version, promoted, allow_initialize=True)
             checked = candidate.verification.verify(version, uri.replace('gs://', 'https://storage.googleapis.com/'))
             assert checked['status'] == 'passed', checked
-            print('PASS: publish and verify all six promoted fixture downloads', flush=True)
+            print(f'PASS: publish and verify all {len(candidate.FILES)} promoted fixture downloads', flush=True)
             destination_uris = [f'gs://{bucket}/{destination}/{filename}' for filename in candidate.FILES.values()]
             before = [candidate.describe(path)['generation'] for path in destination_uris]
             try:
@@ -67,9 +67,9 @@ def main():
             now = datetime.now(timezone.utc)
             assert candidate.expired_objects(listed, now) == [], listed
             expired = candidate.expired_objects(listed, now + timedelta(days=8))
-            assert len(expired) == 6 and all(item.startswith(prefix + '/') for item in expired), listed
+            assert len(expired) == len(candidate.FILES) and all(item.startswith(prefix + '/') for item in expired), listed
             gcloud('storage', 'rm', f'gs://{bucket}/{expired[0]}')
-            print('PASS: recent objects retained; expiry recognizes all six and deletes the selected generation', flush=True)
+            print(f'PASS: recent objects retained; expiry recognizes all {len(candidate.FILES)} and deletes the selected generation', flush=True)
     finally:
         # No configurable product paths: all three prefixes are constructed from
         # this workflow's own run/attempt and random token above.
````

and in `scripts/check-desktop-publication-gcs.py` only the two messages (F2.2 adds the Windows upload to its loop):

```python
                print(f"PASS: publish and verify all {len(entries)} {version} fixtures", flush=True)
```

```python
                stream.write("Desktop publication contract passed against disposable GCS fixtures: every platform's publication/downloads, superseded and duplicate versions, incomplete builds, concurrent manifest writes, and immutable artifacts.\n")
```

In `scripts/tests/test_desktop_release_candidate.py`, the case `test_sealing_rejects_missing_platform_or_wrong_source_url` matches the publisher's message: its `assertRaisesRegex(ValueError, 'four platform manifests')` becomes `assertRaisesRegex(ValueError, 'expected 6 platform manifests')` (included in the diff above).

- [ ] **Step 4: Run them**

Run: `python3 -m unittest discover -s scripts/tests -p 'test_desktop_*.py'`
Expected: PASS, 79 tests. `grep -n "six" scripts/*desktop*.py` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-desktop-release.py scripts/publish-desktop-manifest.py scripts/desktop-release-candidate.py \
  scripts/check-desktop-candidate-gcs.py scripts/check-desktop-publication-gcs.py \
  scripts/tests/test_desktop_verification.py scripts/tests/test_desktop_release_candidate.py
git commit -m "ci(desktop): the release publishes, verifies and seals nine artifacts, Windows's three among them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task F2.2: `build-windows` and `upload-windows`

**Files:**
- Create: `desktop/scripts/check-windows-zip.py`, `desktop/scripts/upload-desktop-windows.sh`, `cli/src/scripts/uploadDesktopWindows.spec.ts`
- Modify: `desktop/scripts/publish-desktop-windows-staging.sh` (its zip check moves out), `.github/workflows/release-desktop.yml`, `cli/src/scripts/windowsWorkflows.spec.ts`, `scripts/tests/desktop_publication_fixture.py`, `scripts/tests/test_desktop_publication.py`, `scripts/check-desktop-publication-gcs.py`, `scripts/tests/test_desktop_release_candidate.py`

**Interfaces:**
- Consumes: F2.1's `PARTS`, `FILES`, job names. `release-desktop.yml`'s `version` outputs `artifact_prefix`, `artifact_base_url`, `scratch_prefix`. `desktop/scripts/package-windows.ps1 -Version -Arch -Launcher` (C), which writes `desktop/build/windows-zip/harness-desktop-<ver>-windows-<arch>.zip`. F1.3's `HARNESS_INSTALL_BASE`/`HARNESS_INSTALL_VERSION`.
- Produces: `check-windows-zip.py <zip> <version>` (exit 0, or one `error:` line); `upload-desktop-windows.sh <X.Y.Z> <folder>` with `ARTIFACT_PREFIX`, `SCRATCH_PREFIX`, `CDN_ASSET_BASE_URL`, `GCS_BUCKET`; the Actions artifacts `desktop-windows-x64` (zip and installer) and `desktop-windows-arm64`.

- [ ] **Step 1: Write the failing spec**

`cli/src/scripts/uploadDesktopWindows.spec.ts`:

```ts
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// release-desktop.yml's upload-windows job (installer spec §2.2): the three Windows files, create-only, and the two
// scratch parts publish-desktop-manifest.py merges. gcloud is a shim that records each call.
const script = join(process.cwd(), '..', 'desktop', 'scripts', 'upload-desktop-windows.sh')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const VERSION = '1.3.4'
const SCRATCH = 'harness/desktop/.ci/77-1'
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The release's three files, with zips in the install shape check-windows-zip.py requires. */
function release(over: { installer?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-upload-windows-'))
  dirs.push(root)
  const out = join(root, 'windows-release')
  mkdirSync(out)
  for (const arch of ['x64', 'arm64']) {
    const src = join(root, `src-${arch}`)
    for (const [name, value] of Object.entries({
      'Harness.exe': 'launcher', 'Harness.ico': 'icon', current: `${VERSION}\r\n`,
      [`app/${VERSION}/harness-desktop.exe`]: `app ${arch}`, [`app/${VERSION}/harness_pipe_io.dll`]: `pipe ${arch}`,
    })) {
      mkdirSync(join(src, name, '..'), { recursive: true })
      writeFileSync(join(src, name), value)
    }
    const zip = join(out, `Harness-windows-${arch}.zip`)
    const made = spawnSync('python3', ['-c', 'import shutil, sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', zip, src], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
  }
  writeFileSync(join(out, 'harness-install.exe'), over.installer ?? 'MZ installer bytes')
  const shim = join(root, 'shim')
  mkdirSync(shim)
  writeFileSync(join(shim, 'gcloud'), `#!/bin/sh
printf '%s\\n' "$*" >> "$SHIM_ROOT/gcloud.log"
[ "$1 $2" = "storage cp" ] || exit 91
shift 2
while [ "$#" -gt 2 ]; do shift; done
if [ "$SHIM_MODE" = exists ]; then echo 'precondition failed' >&2; exit 1; fi
cp "$1" "$SHIM_ROOT/uploaded-$(basename "$2")"
`, { mode: 0o755 })
  return { root, out, shim }
}

function run(world: ReturnType<typeof release>, args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }
  for (const name of ['ARTIFACT_PREFIX', 'SCRATCH_PREFIX', 'CDN_ASSET_BASE_URL', 'SHIM_MODE']) delete base[name]
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...base, PATH: `${world.shim}:${process.env.PATH}`, SHIM_ROOT: world.root, GCS_BUCKET: 's3-autonomous-upgrade-3',
      ARTIFACT_PREFIX: `harness/desktop/${VERSION}`, SCRATCH_PREFIX: SCRATCH, ...env },
  })
}

const calls = (root: string) => existsSync(join(root, 'gcloud.log')) ? readFileSync(join(root, 'gcloud.log'), 'utf8').trim().split('\n') : []

describe.skipIf(process.platform === 'win32')('upload-desktop-windows.sh', () => {
  it('refuses a bad version, a malformed call, or a destination the version job never makes', () => {
    const w = release()
    for (const args of [['v1.3.4', w.out], ['1.3.4-rc1', w.out], [VERSION], [VERSION, w.out, 'extra']]) {
      expect(run(w, args).status, args.join(' ')).toBe(2)
    }
    for (const prefix of ['harness/desktop', 'harness/desktop/1.3.5', 'harness/staging/desktop/1.3.4', 'harness/desktop/1.3.4/../cli', 'harness/desktop-candidates/1-1-short']) {
      const result = run(w, [VERSION, w.out], { ARTIFACT_PREFIX: prefix })
      expect(result.status, prefix).toBe(2)
      expect(result.stderr).toContain('nothing was uploaded')
    }
    expect(run(w, [VERSION, w.out], { SCRATCH_PREFIX: 'harness/desktop/metadata.json' }).status).toBe(2)
    expect(calls(w.root)).toEqual([])
  })

  it('uploads nothing when a zip is not a complete install or the installer is not a program', () => {
    const w = release({ installer: 'not a program' })
    const result = run(w, [VERSION, w.out])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('harness-install.exe is not a Windows program')
    const v = release()
    writeFileSync(join(v.out, 'Harness-windows-arm64.zip'), 'not a zip')
    expect(run(v, [VERSION, v.out]).stderr).toContain('is not a valid install zip')
    expect([...calls(w.root), ...calls(v.root)]).toEqual([])
  })

  it('uploads the three files create-only and immutable, then the two parts the publisher expects', () => {
    const w = release()
    const result = run(w, [VERSION, w.out])
    expect(result.status, result.stderr).toBe(0)
    const log = calls(w.root)
    expect(log).toHaveLength(5)
    for (const [index, name] of ['Harness-windows-x64.zip', 'Harness-windows-arm64.zip', 'harness-install.exe'].entries()) {
      expect(log[index]).toContain('--cache-control=public, max-age=31536000, immutable')
      expect(log[index]).toContain('--if-generation-match=0')
      expect(log[index]).toContain(`gs://s3-autonomous-upgrade-3/harness/desktop/${VERSION}/${name}`)
      expect(readFileSync(join(w.root, `uploaded-${name}`))).toEqual(readFileSync(join(w.out, name)))
    }
    for (const line of log.slice(3)) {
      expect(line).toContain('--cache-control=no-cache, no-store, must-revalidate')
      expect(line).toContain('--if-generation-match=0')
      expect(line).toContain(`gs://s3-autonomous-upgrade-3/${SCRATCH}/windows-`)
    }
    const x64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-x64.json'), 'utf8'))
    const arm64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-arm64.json'), 'utf8'))
    expect(Object.keys(x64).sort()).toEqual(['desktop-windows-installer', 'desktop-windows-x64'])
    expect(Object.keys(arm64)).toEqual(['desktop-windows-arm64'])
    expect(x64['desktop-windows-installer']).toEqual({
      version: VERSION, url: `https://cdn.autonomous.ai/harness/desktop/${VERSION}/harness-install.exe`,
      sha256: sha(join(w.out, 'harness-install.exe')), size: readFileSync(join(w.out, 'harness-install.exe')).length,
    })
    expect(arm64['desktop-windows-arm64'].sha256).toBe(sha(join(w.out, 'Harness-windows-arm64.zip')))
  })

  it('points a candidate\'s parts at its own objects on the bucket origin', () => {
    const w = release()
    const prefix = `harness/desktop-candidates/77-1-${'a'.repeat(32)}`
    const result = run(w, [VERSION, w.out], { ARTIFACT_PREFIX: prefix, CDN_ASSET_BASE_URL: 'https://storage.googleapis.com/s3-autonomous-upgrade-3' })
    expect(result.status, result.stderr).toBe(0)
    const x64 = JSON.parse(readFileSync(join(w.root, 'uploaded-windows-x64.json'), 'utf8'))
    expect(x64['desktop-windows-x64'].url).toBe(`https://storage.googleapis.com/s3-autonomous-upgrade-3/${prefix}/Harness-windows-x64.zip`)
  })

  it('stops at the first file that already exists, before any part is written', () => {
    const w = release()
    const result = run(w, [VERSION, w.out], { SHIM_MODE: 'exists' })
    expect(result.status).toBe(1)
    expect(calls(w.root)).toHaveLength(1)
    expect(existsSync(join(w.root, 'uploaded-windows-x64.json'))).toBe(false)
  })
})
```

At the end of the `describe` in `cli/src/scripts/windowsWorkflows.spec.ts`:

```ts
  // Installer spec §2.2: every desktop release ships Windows, unsigned, from the same manifest write.
  it('builds Windows in the desktop release and publishes it with the other platforms', () => {
    const release = read('release-desktop.yml')
    const job = (name: string) => release.match(new RegExp(`\n  ${name}:\n([\\s\\S]*?)(?=\n  [\\w-]+:\n|$)`))?.[1] ?? ''
    const build = job('build-windows')
    expect(build).toContain('{ runner: windows-latest, arch: x64, target: x86_64-pc-windows-msvc }')
    expect(build).toContain('{ runner: windows-11-arm, arch: arm64, target: aarch64-pc-windows-msvc }')
    expect(build).toContain("if: needs.preflight.outputs.reused != 'true'")
    expect(build).toContain('flutter build windows --release --build-name $env:VERSION')
    expect(build).not.toContain('HARNESS_STAGING')
    expect(build).toContain('HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/\n')
    expect(build).toContain("if: matrix.arch == 'x64'")
    expect(build).not.toContain('gcloud')
    expect(job('upload-windows')).toContain('bash desktop/scripts/upload-desktop-windows.sh "$VERSION" windows-release')
    expect(release).toMatch(/publish:\n\s+needs: \[version, preflight, build-macos, build-linux, build-windows, upload-windows\]/)
    expect(release).toContain("needs.build-linux.result == 'success' && needs.upload-windows.result == 'success'")
    expect(release).toMatch(/candidate:\n\s+needs: \[version, build-macos, build-linux, upload-windows\]/)
    expect(release).toMatch(/cleanup:\n\s+needs: \[version, preflight, build-macos, build-linux, build-windows, upload-windows, candidate, publish\]/)
    expect(release).toContain('[harness-install.exe](${base}/harness-install.exe)')
  })
```

In `scripts/tests/test_desktop_publication.py` and `scripts/tests/desktop_publication_fixture.py`, the immutable-upload check covers Windows's call too. Windows uploads its three files in a loop, so its `gcs_cp` line is indented; the fixture strips it, and the line runs the same alone:

````diff
diff --git a/scripts/tests/desktop_publication_fixture.py b/scripts/tests/desktop_publication_fixture.py
--- a/scripts/tests/desktop_publication_fixture.py
+++ b/scripts/tests/desktop_publication_fixture.py
@@ -29,5 +29,6 @@ def artifact_upload_script(script_name, variable):
     """Exercise the actual helper AND upload invocation, without building an app."""
     source = (ROOT / "desktop/scripts" / script_name).read_text()
     function = "gcs_cp() {" + source.split("gcs_cp() {", 1)[1].split("\n}", 1)[0] + "\n}\n"
-    invocation = next(line for line in source.splitlines() if line.startswith(f'gcs_cp "${variable}" '))
+    # Windows uploads its three files in a loop, so its call is indented; the line runs the same alone.
+    invocation = next(line.strip() for line in source.splitlines() if line.strip().startswith(f'gcs_cp "${variable}" '))
     return function + invocation + "\n"
````

````diff
diff --git a/scripts/tests/test_desktop_publication.py b/scripts/tests/test_desktop_publication.py
--- a/scripts/tests/test_desktop_publication.py
+++ b/scripts/tests/test_desktop_publication.py
@@ -163,7 +163,8 @@ class DesktopPublicationTests(unittest.TestCase):
                 self.assertEqual(state["objects"][URI]["data"], payload)
 
     def test_real_artifact_upload_commands_cannot_overwrite_existing_bytes(self):
-        for script, variable in (("upload-desktop.sh", "ZIP"), ("upload-desktop.sh", "DMG"), ("upload-desktop-linux.sh", "OUTPUT")):
+        for script, variable in (("upload-desktop.sh", "ZIP"), ("upload-desktop.sh", "DMG"), ("upload-desktop-linux.sh", "OUTPUT"),
+                                 ("upload-desktop-windows.sh", "FILE")):
             with self.subTest(script=script, variable=variable):
                 payload = self.root / "artifact"
                 payload.write_text("original bytes")
````

and the reuse contract's checkout coverage reads the new job:

````diff
--- a/scripts/tests/test_desktop_release_candidate.py
+++ b/scripts/tests/test_desktop_release_candidate.py
@@ -400,7 +400,7 @@
         self.assertEqual(self.git('status', '--porcelain'), '')
 
     def test_native_checkout_inputs_are_all_covered_by_the_reuse_contract(self):
-        for filename, jobs in [('release-desktop.yml', ['build-macos', 'build-linux']),
+        for filename, jobs in [('release-desktop.yml', ['build-macos', 'build-linux', 'build-windows']),
                                ('desktop-internal-build.yml', ['build-macos'])]:
             workflow = (ROOT / '.github/workflows' / filename).read_text()
             for job in jobs:
````

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/scripts/uploadDesktopWindows.spec.ts src/scripts/windowsWorkflows.spec.ts; cd .. && python3 -m unittest discover -s scripts/tests -p 'test_desktop_*.py'`
Expected: FAIL: the script does not exist; `build-windows` is not in the workflow (the coverage test's `re.search` finds no job, and the publication test cannot read `upload-desktop-windows.sh`).

- [ ] **Step 3: The zip check, shared**

`desktop/scripts/check-windows-zip.py` (executable): the Python block that `publish-desktop-windows-staging.sh` runs today, moved to a file of its own so the release refuses exactly the zips staging refuses. The body is the block's lines unchanged:

```python
#!/usr/bin/env python3
"""Check a Windows desktop zip has the install's exact shape (desktop spec §3.3), before anything uploads it.

Usage: check-windows-zip.py <zip> <version>. Exit 0 when it is a complete install for <version>; otherwise one
`error:` line and a non-zero exit. Shared by the staging publisher and the release upload
(publish-desktop-windows-staging.sh, upload-desktop-windows.sh), so both refuse the same zips.
"""
import stat
import sys
import zipfile

path, version = sys.argv[1:3]
try:
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len({name.casefold() for name in names}):
            sys.exit(f"error: {path} has duplicate entries")
        for info in infos:
            name = info.filename
            parts = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") or any(c in part for c in '<>:"|?*') for part in parts)):
                sys.exit(f"error: {path} has an unsafe entry {name!r}")
            if parts[0] not in ("Harness.exe", "Harness.ico", "current", "app") or (
                    parts[0] != "app" and (len(parts) != 1 or info.is_dir())) or (
                    parts[0] == "app" and len(parts) == 1 and not info.is_dir()) or (
                    parts[0] == "app" and len(parts) > 1 and parts[1] != version) or (
                    parts[:2] == ["app", version] and len(parts) == 2 and not info.is_dir()):
                sys.exit(f"error: {path} has an unexpected entry {name!r}")
            if any(part.lower() == ".started" for part in parts):
                sys.exit(f"error: {path} contains an inherited .started marker")
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind not in ((0, stat.S_IFDIR) if info.is_dir() else (0, stat.S_IFREG)):
                sys.exit(f"error: {path} contains a non-file entry {name!r}")
        required = ("Harness.exe", "Harness.ico", "current",
                    f"app/{version}/harness-desktop.exe", f"app/{version}/harness_pipe_io.dll")
        for name in required:
            if name not in names or archive.getinfo(name).is_dir() or archive.getinfo(name).file_size == 0:
                sys.exit(f"error: {path} has no {name}")
        current = archive.read("current").decode("utf-8-sig")
        if current not in (version, version + "\n", version + "\r\n"):
            sys.exit(f"error: {path} says current is '{current.strip()}', not {version}")
        bad = archive.testzip()
        if bad is not None:
            sys.exit(f"error: {path} has a corrupt entry {bad}")
except (OSError, ValueError, UnicodeError, RuntimeError, zipfile.BadZipFile) as error:
    sys.exit(f"error: {path} is not a valid install zip: {error}")
```

and in `publish-desktop-windows-staging.sh` the heredoc becomes one call:

````diff
--- a/desktop/scripts/publish-desktop-windows-staging.sh
+++ b/desktop/scripts/publish-desktop-windows-staging.sh
@@ -60,49 +60,7 @@
     echo "error: the $arch zip must be named $name, not $(basename "$zip")" >&2
     exit 1
   }
-  python3 - "$zip" "$VERSION" <<'PY'
-import stat
-import sys
-import zipfile
-
-path, version = sys.argv[1:3]
-try:
-    with zipfile.ZipFile(path) as archive:
-        infos = archive.infolist()
-        names = [info.filename for info in infos]
-        if len(names) != len({name.casefold() for name in names}):
-            sys.exit(f"error: {path} has duplicate entries")
-        for info in infos:
-            name = info.filename
-            parts = name.rstrip("/").split("/")
-            if (not name or name.startswith("/") or "\\" in name or
-                    any(part in ("", ".", "..") or any(c in part for c in '<>:"|?*') for part in parts)):
-                sys.exit(f"error: {path} has an unsafe entry {name!r}")
-            if parts[0] not in ("Harness.exe", "Harness.ico", "current", "app") or (
-                    parts[0] != "app" and (len(parts) != 1 or info.is_dir())) or (
-                    parts[0] == "app" and len(parts) == 1 and not info.is_dir()) or (
-                    parts[0] == "app" and len(parts) > 1 and parts[1] != version) or (
-                    parts[:2] == ["app", version] and len(parts) == 2 and not info.is_dir()):
-                sys.exit(f"error: {path} has an unexpected entry {name!r}")
-            if any(part.lower() == ".started" for part in parts):
-                sys.exit(f"error: {path} contains an inherited .started marker")
-            kind = stat.S_IFMT(info.external_attr >> 16)
-            if kind not in ((0, stat.S_IFDIR) if info.is_dir() else (0, stat.S_IFREG)):
-                sys.exit(f"error: {path} contains a non-file entry {name!r}")
-        required = ("Harness.exe", "Harness.ico", "current",
-                    f"app/{version}/harness-desktop.exe", f"app/{version}/harness_pipe_io.dll")
-        for name in required:
-            if name not in names or archive.getinfo(name).is_dir() or archive.getinfo(name).file_size == 0:
-                sys.exit(f"error: {path} has no {name}")
-        current = archive.read("current").decode("utf-8-sig")
-        if current not in (version, version + "\n", version + "\r\n"):
-            sys.exit(f"error: {path} says current is '{current.strip()}', not {version}")
-        bad = archive.testzip()
-        if bad is not None:
-            sys.exit(f"error: {path} has a corrupt entry {bad}")
-except (OSError, ValueError, UnicodeError, RuntimeError, zipfile.BadZipFile) as error:
-    sys.exit(f"error: {path} is not a valid install zip: {error}")
-PY
+  python3 "$REPO/desktop/scripts/check-windows-zip.py" "$zip" "$VERSION"
   object="${STAGING_PREFIX}/desktop/${VERSION}/${name}"
   url="${CDN_ASSET_BASE_URL%/}/${object}"
   size="$(wc -c < "$zip" | tr -d ' ')"
````

Run: `cd cli && npx vitest run src/scripts/publishDesktopWindowsStaging.spec.ts`
Expected: PASS, 13 tests, unchanged: the same messages from the same checks.

- [ ] **Step 4: The upload**

`desktop/scripts/upload-desktop-windows.sh` (executable):

```bash
#!/usr/bin/env bash
# Upload one desktop release's Windows files and write their two scratch manifests, which release-desktop.yml's
# publish job merges with the other platforms' (docs/superpowers/specs/2026-10-19-windows-installer-design.md §2.2).
# It runs on ubuntu, so the Windows build runners never need gcloud.
#
# Usage: bash desktop/scripts/upload-desktop-windows.sh <X.Y.Z> <folder>
#   <folder> holds Harness-windows-x64.zip, Harness-windows-arm64.zip and harness-install.exe.
# Environment, from release-desktop.yml's version job: ARTIFACT_PREFIX (harness/desktop/<version>, a candidate's
# prefix, or the disposable promotion check's), SCRATCH_PREFIX (harness/desktop/.ci/<run>-<attempt>),
# CDN_ASSET_BASE_URL and GCS_BUCKET.
set -euo pipefail
set +x

VERSION="${1:-}"
DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$DIR" ] || [ "$#" -ne 2 ]; then
  echo "usage: $0 <X.Y.Z> <folder with Harness-windows-x64.zip, Harness-windows-arm64.zip and harness-install.exe>" >&2
  exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
ARTIFACT_PREFIX="${ARTIFACT_PREFIX:-harness/desktop/$VERSION}"
SCRATCH_PREFIX="${SCRATCH_PREFIX:-}"
if [[ ! "$GCS_BUCKET" =~ ^[a-z0-9][a-z0-9._-]*[a-z0-9]$ ]]; then
  echo "error: GCS_BUCKET must be a bucket name without a path; nothing was uploaded." >&2
  exit 2
fi
# The three destinations the version job makes, and nothing else: a release, a candidate, a promotion check.
if [[ ! "$ARTIFACT_PREFIX" =~ ^(harness/desktop/${VERSION//./\\.}|harness/desktop-candidates/[1-9][0-9]*-[1-9][0-9]*-[0-9a-f]{32}|harness/desktop/\.candidate-check/[1-9][0-9]*-[1-9][0-9]*/artifacts)$ ]]; then
  echo "error: ARTIFACT_PREFIX '$ARTIFACT_PREFIX' is not this release's, a candidate's or a promotion check's; nothing was uploaded." >&2
  exit 2
fi
if [[ ! "$SCRATCH_PREFIX" =~ ^harness/desktop/\.ci/[1-9][0-9]*-[1-9][0-9]*$ ]]; then
  echo "error: SCRATCH_PREFIX '$SCRATCH_PREFIX' is not harness/desktop/.ci/<run>-<attempt>; nothing was uploaded." >&2
  exit 2
fi
for tool in gcloud python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done

NAMES=(Harness-windows-x64.zip Harness-windows-arm64.zip harness-install.exe)
for name in "${NAMES[@]}"; do
  [ -f "$DIR/$name" ] || { echo "error: $DIR/$name is missing; nothing was uploaded." >&2; exit 1; }
done
python3 "$REPO/desktop/scripts/check-windows-zip.py" "$DIR/Harness-windows-x64.zip" "$VERSION"
python3 "$REPO/desktop/scripts/check-windows-zip.py" "$DIR/Harness-windows-arm64.zip" "$VERSION"
[ "$(head -c 2 "$DIR/harness-install.exe")" = MZ ] || {
  echo "error: $DIR/harness-install.exe is not a Windows program; nothing was uploaded." >&2
  exit 1
}

# gcs_cp <src> <dst> [cache-control] [content-type] [generation-match], as upload-desktop-linux.sh has it.
gcs_cp() {
  local src="$1" dst="$2" cc="${3:-}" ct="${4:-}" generation="${5:-}" args=(storage cp)
  if [ -n "$cc" ]; then args+=("--cache-control=$cc"); fi
  if [ -n "$ct" ]; then args+=("--content-type=$ct"); fi
  if [ -n "$generation" ]; then args+=("--if-generation-match=$generation"); fi
  gcloud "${args[@]}" "$src" "$dst"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 - "$WORK" "$VERSION" "${CDN_ASSET_BASE_URL%/}/${ARTIFACT_PREFIX}" "$DIR" <<'PY'
import hashlib
import json
import pathlib
import sys

work, version, base, folder = sys.argv[1:5]


def entry(name):
    data = (pathlib.Path(folder) / name).read_bytes()
    return dict(version=version, url=f"{base}/{name}", sha256=hashlib.sha256(data).hexdigest(), size=len(data))


# publish-desktop-manifest.py's PARTS: the installer comes from the x64 job, one x64 program for every PC.
parts = {
    "windows-x64.json": {"desktop-windows-x64": entry("Harness-windows-x64.zip"),
                         "desktop-windows-installer": entry("harness-install.exe")},
    "windows-arm64.json": {"desktop-windows-arm64": entry("Harness-windows-arm64.zip")},
}
for name, part in parts.items():
    (pathlib.Path(work) / name).write_text(json.dumps(part, indent=2) + "\n")
PY

for name in "${NAMES[@]}"; do
  FILE="$DIR/$name"
  GCS_PATH="$ARTIFACT_PREFIX/$name"
  echo ">> uploading $name ($(wc -c < "$FILE" | tr -d ' ') bytes) to gs://${GCS_BUCKET}/${GCS_PATH}"
  # Create-only: a versioned file is immutable, because the CDN keeps the first bytes it served for a path
  # (upload-desktop-linux.sh, gcs_refuse_republish). A re-run fails here instead of replacing them.
  gcs_cp "$FILE" "gs://${GCS_BUCKET}/${GCS_PATH}" "public, max-age=31536000, immutable" "" 0
done
for part in windows-x64.json windows-arm64.json; do
  gcs_cp "$WORK/$part" "gs://${GCS_BUCKET}/${SCRATCH_PREFIX}/$part" "no-cache, no-store, must-revalidate" "application/json" 0
done
echo ">> Windows desktop $VERSION uploaded to gs://${GCS_BUCKET}/${ARTIFACT_PREFIX}/ and its parts to ${SCRATCH_PREFIX}/"
```

- [ ] **Step 5: The jobs**

Apply to `.github/workflows/release-desktop.yml` (`git apply`). `build-windows` installs Flutter as `windows-desktop.yml` does (a clone of the pinned tag, so arm64 gets its own Dart SDK) and builds the production app: no `HARNESS_STAGING`. `publish`, `candidate` and `cleanup` wait for `upload-windows`; with a reused candidate, `build-windows` is skipped and so is `upload-windows`, as for the other builds.

````diff
diff --git a/.github/workflows/release-desktop.yml b/.github/workflows/release-desktop.yml
--- a/.github/workflows/release-desktop.yml
+++ b/.github/workflows/release-desktop.yml
@@ -12,10 +12,10 @@ run-name: Desktop ${{ inputs.prepare_only && 'candidate' || inputs.test_candidat
 # The Flutter project lives under desktop/: the jobs that touch the tree run with
 # working-directory: desktop, and `desktop/scripts/...` below is what `scripts/...` used to mean.
 #
-# macOS and both Linux architectures build in parallel. The macOS coordinator compiles one
+# macOS, both Linux architectures and both Windows architectures build in parallel. The macOS coordinator compiles one
 # universal app, derives both renderer bundles, and packages/notarizes/uploads them in parallel.
 # Each variant writes its own scratch manifest under harness/desktop/.ci/<run id>/.
-# The publish job combines all four parts with a generation-conditional write and verifies every
+# The publish job combines every platform's parts with a generation-conditional write and verifies every
 # public download while holding the publication lock. Different releases may build concurrently.
 #
 # The tag IS the version — CI never auto-bumps. The scripts bump by reading the current version out
@@ -25,7 +25,9 @@ run-name: Desktop ${{ inputs.prepare_only && 'candidate' || inputs.test_candidat
 # Publishes the keys running apps poll (desktop/lib/update/desktop_updater.dart): desktop-macos and
 # desktop-macos-dmg (the Intel build, on Skia — also what every older install and the website read),
 # desktop-macos-arm64 and desktop-macos-arm64-dmg (Apple Silicon, on Impeller), desktop-linux-x64 and
-# desktop-linux-arm64. A MINOR bump (1.0.x -> 1.1.1) is a forced update — running apps block until it
+# desktop-linux-arm64, and Windows's desktop-windows-x64, desktop-windows-arm64 (the install-shaped zips the Windows
+# updater and install.ps1 -App take) and desktop-windows-installer (harness-install.exe, which the website serves).
+# A MINOR bump (1.0.x -> 1.1.1) is a forced update — running apps block until it
 # is installed. See RELEASE.md, "Two macOS builds" for why macOS is published twice.
 #
 # Dry run first: Actions -> Release -> Run workflow, with metadata_path = harness/desktop/
@@ -386,16 +388,129 @@ jobs:
           VERSION: ${{ needs.version.outputs.version }}
         run: bash scripts/upload-desktop-linux.sh "$VERSION"
 
+  # Each architecture on its own runner, like Linux (docs/superpowers/specs/2026-10-19-windows-installer-design.md
+  # §2.2). Not signed: there is no signing service yet. The x64 job also builds harness-install.exe, one x64
+  # program for every PC. upload-windows publishes the files from ubuntu, so these runners need no gcloud.
+  build-windows:
+    needs: [version, preflight]
+    if: needs.preflight.outputs.reused != 'true'
+    runs-on: ${{ matrix.runner }}
+    timeout-minutes: 60
+    strategy:
+      fail-fast: false
+      matrix:
+        include:
+          - { runner: windows-latest, arch: x64, target: x86_64-pc-windows-msvc }
+          - { runner: windows-11-arm, arch: arm64, target: aarch64-pc-windows-msvc }
+    env:
+      VERSION: ${{ needs.version.outputs.version }}
+    defaults:
+      run:
+        shell: pwsh
+    steps:
+      - uses: actions/checkout@v7
+        with:
+          # The app, Harness.exe (pty/ and the crates it builds from) and harness-install.exe (installer/).
+          sparse-checkout: |
+            /desktop/
+            /installer/
+            /pty/
+            /term/
+            /tui/vendor/
+            /.github/actions/
+          sparse-checkout-cone-mode: false
+      # A clone of the pinned tag, as windows-desktop.yml does: Flutter's bootstrap then fetches the Dart SDK for the
+      # runner's architecture, arm64 included.
+      - name: Install Flutter ${{ env.FLUTTER_VERSION }}
+        working-directory: ${{ runner.temp }}
+        run: |
+          git clone --depth 1 --branch "$env:FLUTTER_VERSION" https://github.com/flutter/flutter.git flutter
+          if ($LASTEXITCODE -ne 0) { throw "Flutter clone failed ($LASTEXITCODE)" }
+          "$env:RUNNER_TEMP\flutter\bin" | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
+      - name: Check the Flutter pin, and get packages
+        working-directory: desktop
+        run: |
+          flutter config --no-analytics
+          $version = flutter --version --machine | ConvertFrom-Json
+          if ($version.frameworkVersion -ne $env:FLUTTER_VERSION) { throw "Flutter is $($version.frameworkVersion), not $env:FLUTTER_VERSION" }
+          flutter pub get
+          if ($LASTEXITCODE -ne 0) { throw "Flutter pub get failed ($LASTEXITCODE)" }
+      - uses: dtolnay/rust-toolchain@stable
+        with:
+          targets: ${{ matrix.target }}
+      - name: Build Harness.exe
+        working-directory: pty
+        run: |
+          cargo build --locked --release --target ${{ matrix.target }} --bin harness-desktop-launcher
+          if ($LASTEXITCODE -ne 0) { throw "Launcher build failed ($LASTEXITCODE)" }
+      - name: Build the app
+        working-directory: desktop
+        run: |
+          flutter build windows --release --build-name $env:VERSION --build-number ${{ github.run_number }}
+          if ($LASTEXITCODE -ne 0) { throw "App build failed ($LASTEXITCODE)" }
+      - name: Package
+        run: |
+          pwsh desktop/scripts/package-windows.ps1 -Version $env:VERSION -Arch ${{ matrix.arch }} -Launcher pty/target/${{ matrix.target }}/release/harness-desktop-launcher.exe
+          if ($LASTEXITCODE -ne 0) { throw "Windows package failed ($LASTEXITCODE)" }
+          New-Item -ItemType Directory -Force -Path windows-release | Out-Null
+          Move-Item -LiteralPath "desktop/build/windows-zip/harness-desktop-$env:VERSION-windows-${{ matrix.arch }}.zip" -Destination 'windows-release/Harness-windows-${{ matrix.arch }}.zip'
+      - name: Build harness-install.exe
+        if: matrix.arch == 'x64'
+        working-directory: installer
+        env:
+          HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/
+          HARNESS_INSTALL_VERSION: ${{ env.VERSION }}
+        run: |
+          cargo build --locked --release --target ${{ matrix.target }}
+          if ($LASTEXITCODE -ne 0) { throw "harness-install build failed ($LASTEXITCODE)" }
+          Copy-Item -LiteralPath 'target/${{ matrix.target }}/release/harness-install.exe' -Destination '../windows-release/harness-install.exe'
+      - uses: actions/upload-artifact@v4
+        with:
+          name: desktop-windows-${{ matrix.arch }}
+          path: windows-release/
+          if-no-files-found: error
+
+  upload-windows:
+    needs: [version, build-windows]
+    runs-on: ubuntu-latest
+    timeout-minutes: 15
+    env:
+      VERSION: ${{ needs.version.outputs.version }}
+      ARTIFACT_PREFIX: ${{ needs.version.outputs.artifact_prefix }}
+      CDN_ASSET_BASE_URL: ${{ needs.version.outputs.artifact_base_url }}
+      SCRATCH_PREFIX: ${{ needs.version.outputs.scratch_prefix }}
+    steps:
+      - uses: actions/checkout@v7
+        with:
+          sparse-checkout: |
+            /.github/actions/setup-gcloud/
+            /desktop/scripts/check-windows-zip.py
+            /desktop/scripts/upload-desktop-windows.sh
+          sparse-checkout-cone-mode: false
+      - uses: actions/download-artifact@v4
+        with:
+          pattern: desktop-windows-*
+          path: windows-release
+          merge-multiple: true
+      - name: Authenticate to GCP (workload identity federation)
+        uses: google-github-actions/auth@v2
+        with:
+          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
+          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
+      - uses: ./.github/actions/setup-gcloud
+      - name: Upload the Windows files and write their parts
+        run: bash desktop/scripts/upload-desktop-windows.sh "$VERSION" windows-release
+
   # The only job that touches the REAL manifest, and the only one that can, because it is the only
   # one that runs after every build has finished.
   publish:
-    needs: [version, preflight, build-macos, build-linux]
-    if: ${{ always() && !inputs.prepare_only && needs.version.result == 'success' && needs.preflight.result == 'success' && (needs.preflight.outputs.reused == 'true' || (needs.build-macos.result == 'success' && needs.build-linux.result == 'success')) }}
+    needs: [version, preflight, build-macos, build-linux, build-windows, upload-windows]
+    if: ${{ always() && !inputs.prepare_only && needs.version.result == 'success' && needs.preflight.result == 'success' && (needs.preflight.outputs.reused == 'true' || (needs.build-macos.result == 'success' && needs.build-linux.result == 'success' && needs.upload-windows.result == 'success')) }}
     runs-on: ubuntu-latest
     timeout-minutes: 8
     concurrency:
       # Include verification: another release must not advance the live manifest
-      # between this publication and its six-download check. GCS's generation
+      # between this publication and its nine-download check. GCS's generation
       # condition also protects against writers outside this workflow.
       # Keep the historical group so a release already using the older workflow
       # still serializes with this publisher during the transition.
@@ -525,6 +640,9 @@ jobs:
           | macOS — Intel (also runs on Apple Silicon) | [Harness-macos.dmg](${base}/Harness-macos.dmg) |
           | Linux x64 | [Harness-linux-x64.AppImage](${base}/Harness-linux-x64.AppImage) |
           | Linux arm64 | [Harness-linux-arm64.AppImage](${base}/Harness-linux-arm64.AppImage) |
+          | Windows — installer (x64 and ARM64) | [harness-install.exe](${base}/harness-install.exe) |
+          | Windows x64 | [Harness-windows-x64.zip](${base}/Harness-windows-x64.zip) |
+          | Windows ARM64 | [Harness-windows-arm64.zip](${base}/Harness-windows-arm64.zip) |
 
           Already running Harness? It updates itself — no download needed.
           EOF
@@ -545,7 +663,7 @@ jobs:
   # precisely when scratch manifests are left behind — the builds that DID succeed have already
   # written theirs. `if: always()` here means the prefix is cleared whatever happened upstream.
   cleanup:
-    needs: [version, preflight, build-macos, build-linux, candidate, publish]
+    needs: [version, preflight, build-macos, build-linux, build-windows, upload-windows, candidate, publish]
     if: ${{ always() && needs.version.result == 'success' }}
     runs-on: ubuntu-latest
     steps:
@@ -589,10 +707,10 @@ jobs:
           fi
 
   # Same build/signing path and production updater settings. Only the storage
-  # destination differs. A successful receipt binds six verified generations to
+  # destination differs. A successful receipt binds nine verified generations to
   # its full producer source tree, Desktop build inputs, version, run and attempt.
   candidate:
-    needs: [version, build-macos, build-linux]
+    needs: [version, build-macos, build-linux, upload-windows]
     if: ${{ inputs.prepare_only }}
     runs-on: ubuntu-latest
     timeout-minutes: 8
@@ -611,7 +729,7 @@ jobs:
           workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
           service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
       - uses: ./.github/actions/setup-gcloud
-      - name: Verify all six candidate downloads and seal their source identity
+      - name: Verify every candidate download and seal their source identity
         env:
           VERSION: ${{ needs.version.outputs.version }}
           PREFIX: ${{ needs.version.outputs.candidate_prefix }}
````

and in `scripts/check-desktop-publication-gcs.py` the immutable-upload loop gains Windows:

```python
            for script, variable in (("upload-desktop.sh", "ZIP"), ("upload-desktop.sh", "DMG"), ("upload-desktop-linux.sh", "OUTPUT"),
                                     ("upload-desktop-windows.sh", "FILE")):
```

with its PASS line `"PASS: macOS ZIP/DMG, Linux and Windows upload commands refuse immutable overwrites"`.

- [ ] **Step 6: Run everything the change touches**

Run:

```bash
(cd cli && npx vitest run src/scripts/uploadDesktopWindows.spec.ts src/scripts/windowsWorkflows.spec.ts src/scripts/publishDesktopWindowsStaging.spec.ts)
python3 -m unittest discover -s scripts/tests -p 'test_desktop_*.py'
actionlint .github/workflows/release-desktop.yml
shellcheck desktop/scripts/upload-desktop-windows.sh
```

Expected: 5, 5 and 13 tests pass (the staging case of `windowsWorkflows.spec.ts` is F2.3's); 79 Python tests pass; `actionlint` reports only the `SC2129` style note on the `version` job that `main` already has; shellcheck is clean.

- [ ] **Step 7: Commit and push**

```bash
git add desktop/scripts/check-windows-zip.py desktop/scripts/upload-desktop-windows.sh desktop/scripts/publish-desktop-windows-staging.sh \
  .github/workflows/release-desktop.yml cli/src/scripts/uploadDesktopWindows.spec.ts cli/src/scripts/windowsWorkflows.spec.ts \
  scripts/tests/desktop_publication_fixture.py scripts/tests/test_desktop_publication.py scripts/check-desktop-publication-gcs.py \
  scripts/tests/test_desktop_release_candidate.py
git commit -m "ci(desktop): every desktop release builds Windows on its own runners and publishes it with the other platforms" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-desktop
```

`release-desktop.yml` runs on a tag or by hand only, so this push starts no run of it; F4.2's candidate is its first run.

### Task F2.3: A staging installer, and the release docs

**Files:**
- Modify: `desktop/scripts/publish-desktop-windows-staging.sh`, `cli/src/scripts/publishDesktopWindowsStaging.spec.ts`, `.github/workflows/windows-desktop.yml` (`release-build`, `release-staging`), `cli/src/scripts/windowsWorkflows.spec.ts`
- Modify (docs): `desktop/RELEASE.md`, `docs/validation-and-release.md`, `AGENTS.md`, `desktop/scripts/release-desktop.sh`, `desktop/scripts/build-macos-variants.py` (a help string)

**Interfaces:**
- Consumes: F1.3's build variables; F2.2's `check-windows-zip.py`.
- Produces: `publish-desktop-windows-staging.sh <version> <x64 zip> <arm64 zip> <harness-install.exe>` (a fourth argument, required); the staging manifest key `desktop-windows-installer` at `https://cdn.autonomous.ai/harness/staging/desktop/<version>/harness-install.exe`, used by F4.3.

- [ ] **Step 1: Write the failing spec**

Apply to `cli/src/scripts/publishDesktopWindowsStaging.spec.ts` (`git apply`). Every call passes the installer; a new case refuses a missing one, a wrongly named one, and one that is not a Windows program; the dry run and the live upload carry it as the third file:

````diff
diff --git a/cli/src/scripts/publishDesktopWindowsStaging.spec.ts b/cli/src/scripts/publishDesktopWindowsStaging.spec.ts
--- a/cli/src/scripts/publishDesktopWindowsStaging.spec.ts
+++ b/cli/src/scripts/publishDesktopWindowsStaging.spec.ts
@@ -38,6 +38,13 @@ function zip(root: string, version: string, arch: string, over: { current?: stri
   return out
 }
 
+/** harness-install.exe as far as the publisher checks it: its name and a Windows program's first two bytes. */
+function installer(root: string) {
+  const out = join(root, 'harness-install.exe')
+  writeFileSync(out, 'MZ installer bytes')
+  return out
+}
+
 function shim(root: string) {
   const dir = join(root, 'shim')
   mkdirSync(dir)
@@ -99,47 +106,66 @@ const sha = (path: string) => createHash('sha256').update(readFileSync(path)).di
 describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.sh', () => {
   it('refuses a non-staging prefix, bad version, missing zip, or malformed invocation', () => {
     const root = scratch()
-    const x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
+    const x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
     for (const prefix of ['harness', 'harness/desktop', 'harness/stagingx', 'harness/staging/../desktop']) {
-      const result = run(['1.2.90', x64, arm64], { STAGING_PREFIX: prefix })
+      const result = run(['1.2.90', x64, arm64, exe], { STAGING_PREFIX: prefix })
       expect(result.status, prefix).toBe(2)
       expect(result.stderr).toContain('is not harness/staging or a folder under it')
     }
-    expect(run(['v1.2.90', x64, arm64]).status).toBe(2)
-    expect(run(['1.2.90', x64]).status).toBe(2)
-    expect(run(['1.2.90', x64, arm64, 'extra']).status).toBe(2)
-    expect(run(['1.2.90', x64, arm64], { DRY_RUN: 'yes' }).status).toBe(2)
-    expect(run(['1.2.90', x64, arm64], { GCS_BUCKET: 'bucket/escape' }).status).toBe(2)
-    expect(run(['1.2.90', join(root, 'none.zip'), arm64], { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }).stderr).toContain('is missing')
+    expect(run(['v1.2.90', x64, arm64, exe]).status).toBe(2)
+    expect(run(['1.2.90', x64, arm64]).status).toBe(2)
+    expect(run(['1.2.90', x64, arm64, exe, 'extra']).status).toBe(2)
+    expect(run(['1.2.90', x64, arm64, exe], { DRY_RUN: 'yes' }).status).toBe(2)
+    expect(run(['1.2.90', x64, arm64, exe], { GCS_BUCKET: 'bucket/escape' }).status).toBe(2)
+    expect(run(['1.2.90', join(root, 'none.zip'), arm64, exe], { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }).stderr).toContain('is missing')
+  })
+
+  it('takes only a harness-install.exe that is a Windows program', () => {
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
+    const dry = { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }
+    expect(run(['1.2.90', x64, arm64, join(root, 'harness-install.exe')], dry).stderr).toContain('is missing')
+    const named = join(root, 'setup.exe')
+    writeFileSync(named, 'MZ')
+    expect(run(['1.2.90', x64, arm64, named], dry).stderr).toContain('must be named harness-install.exe')
+    const text = join(scratch(), 'harness-install.exe')
+    writeFileSync(text, 'not a program')
+    expect(run(['1.2.90', x64, arm64, text], dry).stderr).toContain('is not a Windows program')
+    expect(existsSync(join(root, 'out'))).toBe(false)
   })
 
   it('requires the exact complete install shape and excludes the first-frame marker', () => {
-    const root = scratch(), arm64 = zip(root, '1.2.90', 'arm64')
+    const root = scratch(), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
     const dry = { DRY_RUN: '1', DRY_RUN_OUT: join(root, 'out') }
-    expect(run(['1.2.90', arm64, arm64], dry).stderr).toContain('must be named harness-desktop-1.2.90-windows-x64.zip')
+    expect(run(['1.2.90', arm64, arm64, exe], dry).stderr).toContain('must be named harness-desktop-1.2.90-windows-x64.zip')
     for (const needed of ['Harness.exe', 'Harness.ico', 'current', 'app/1.2.90/harness-desktop.exe', 'app/1.2.90/harness_pipe_io.dll']) {
       const other = scratch()
-      expect(run(['1.2.90', zip(other, '1.2.90', 'x64', { leave: needed }), arm64], dry).stderr).toContain(`has no ${needed}`)
+      expect(run(['1.2.90', zip(other, '1.2.90', 'x64', { leave: needed }), arm64, exe], dry).stderr).toContain(`has no ${needed}`)
     }
     const wrong = scratch()
-    expect(run(['1.2.90', zip(wrong, '1.2.90', 'x64', { current: '1.2.89' }), arm64], dry).stderr).toContain("says current is '1.2.89'")
+    expect(run(['1.2.90', zip(wrong, '1.2.90', 'x64', { current: '1.2.89' }), arm64, exe], dry).stderr).toContain("says current is '1.2.89'")
     const multiline = scratch()
-    expect(run(['1.2.90', zip(multiline, '1.2.90', 'x64', { current: '1.2.90\nother' }), arm64], dry).stderr).toContain('says current is')
+    expect(run(['1.2.90', zip(multiline, '1.2.90', 'x64', { current: '1.2.90\nother' }), arm64, exe], dry).stderr).toContain('says current is')
     const marked = scratch()
-    expect(run(['1.2.90', zip(marked, '1.2.90', 'x64', { marker: true }), arm64], dry).stderr).toContain('inherited .started')
+    expect(run(['1.2.90', zip(marked, '1.2.90', 'x64', { marker: true }), arm64, exe], dry).stderr).toContain('inherited .started')
     expect(existsSync(join(root, 'out'))).toBe(false)
   })
 
-  it('writes both proposed entries and zip bytes without any bucket command', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
+  it('writes the three proposed entries and their bytes without any bucket command', () => {
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
     const out = join(root, 'out')
-    const result = run(['1.2.90', x64, arm64], {
+    const result = run(['1.2.90', x64, arm64, exe], {
       DRY_RUN: '1', DRY_RUN_OUT: out, STAGING_PREFIX: 'harness/staging/test', SHIM_ROOT: root,
       PATH: `${shim(root)}:${process.env.PATH}`,
     })
     expect(result.status, result.stderr).toBe(0)
     const manifest = JSON.parse(readFileSync(join(out, 'metadata.json'), 'utf8'))
-    expect(Object.keys(manifest).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-x64'])
+    expect(Object.keys(manifest).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
+    expect(manifest['desktop-windows-installer']).toEqual({
+      version: '1.2.90',
+      url: 'https://cdn.autonomous.ai/harness/staging/test/desktop/1.2.90/harness-install.exe',
+      sha256: sha(exe), size: readFileSync(exe).length,
+    })
+    expect(readFileSync(join(out, 'harness-install.exe'))).toEqual(readFileSync(exe))
     expect(manifest['desktop-windows-x64']).toEqual({
       version: '1.2.90',
       url: 'https://cdn.autonomous.ai/harness/staging/test/desktop/1.2.90/harness-desktop-1.2.90-windows-x64.zip',
@@ -151,62 +177,63 @@ describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.s
   })
 
   it('refuses an existing version before uploading either zip', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'exists-arm', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'exists-arm', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('windows-arm64.zip already exists')
     expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
   })
 
   it('aborts before uploading if object lookup fails for an unknown reason', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'unknown', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'unknown', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('Reauthentication failed')
     expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
   })
 
   it('aborts before upload if the existing manifest generation cannot be observed', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'generation-error', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'generation-error', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('could not observe the generation')
     expect(readFileSync(join(root, 'gcloud.log'), 'utf8')).not.toMatch(/storage cp/)
   })
 
-  it('uploads two create-only zips, verifies their bytes, then merges the observed manifest generation', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, PATH: `${shim(root)}:${process.env.PATH}` })
+  it('uploads three create-only files, verifies their bytes, then merges the observed manifest generation', () => {
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status, result.stderr).toBe(0)
     const log = readFileSync(join(root, 'gcloud.log'), 'utf8').trim().split('\n')
-    expect(log.filter((line) => line.includes('storage ls'))).toHaveLength(3)
+    expect(log.filter((line) => line.includes('storage ls'))).toHaveLength(4)
     expect(log).toContain('storage objects describe gs://s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json --format=value(generation)')
     expect(log.some((line) => line.includes('gs://s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json#17'))).toBe(true)
     const uploads = log.filter((line) => line.includes('storage cp') && line.includes(' --if-generation-match='))
-    expect(uploads).toHaveLength(3)
-    expect(uploads[0]).toContain('--if-generation-match=0')
-    expect(uploads[1]).toContain('--if-generation-match=0')
-    expect(uploads[2]).toContain('--if-generation-match=17')
-    expect(uploads[2]).toContain('--cache-control=no-cache, no-store, must-revalidate')
+    expect(uploads).toHaveLength(4)
+    for (const upload of uploads.slice(0, 3)) expect(upload).toContain('--if-generation-match=0')
+    expect(uploads[2]).toContain('gs://s3-autonomous-upgrade-3/harness/staging/desktop/1.2.90/harness-install.exe')
+    expect(uploads[3]).toContain('--if-generation-match=17')
+    expect(uploads[3]).toContain('--cache-control=no-cache, no-store, must-revalidate')
     const manifest = JSON.parse(readFileSync(join(root, 'uploaded-metadata.json'), 'utf8'))
-    expect(Object.keys(manifest).sort()).toEqual(['desktop-macos', 'desktop-windows-arm64', 'desktop-windows-x64'])
+    expect(Object.keys(manifest).sort()).toEqual(['desktop-macos', 'desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
     expect(manifest['desktop-windows-x64'].sha256).toBe(sha(x64))
+    expect(manifest['desktop-windows-installer'].sha256).toBe(sha(exe))
     expect(readFileSync(join(root, 'uploaded-harness-desktop-1.2.90-windows-arm64.zip'))).toEqual(readFileSync(arm64))
   })
 
   it('uses generation zero for a confirmed absent manifest', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'missing-metadata', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'missing-metadata', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status, result.stderr).toBe(0)
     const log = readFileSync(join(root, 'gcloud.log'), 'utf8')
     expect(log).toContain('--if-generation-match=0')
     expect(log).not.toContain('metadata.json#17')
-    expect(Object.keys(JSON.parse(readFileSync(join(root, 'uploaded-metadata.json'), 'utf8'))).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-x64'])
+    expect(Object.keys(JSON.parse(readFileSync(join(root, 'uploaded-metadata.json'), 'utf8'))).sort()).toEqual(['desktop-windows-arm64', 'desktop-windows-installer', 'desktop-windows-x64'])
   })
 
   it('leaves verified objects announced by no manifest when a concurrent metadata writer wins', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'race', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'race', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('metadata changed')
     expect(result.stderr).toContain('new version')
@@ -216,8 +243,8 @@ describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.s
   })
 
   it('reports a partial object upload without publishing the manifest', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'fail-arm', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'fail-arm', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('Confirmed prior uploads: x64')
     expect(result.stderr).toContain('arm64 object outcome is unknown')
@@ -231,8 +258,8 @@ describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.s
     ['x64', 'fail-after-store-x64', 'none'],
     ['arm64', 'fail-after-store-arm', 'x64'],
   ])('reports an unknown %s upload result after the fake stores its object', (arch, mode, prior) => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: mode, PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: mode, PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain(`${arch} upload failed`)
     expect(result.stderr).toContain(`${arch} object outcome is unknown`)
@@ -244,8 +271,8 @@ describe.skipIf(process.platform === 'win32')('publish-desktop-windows-staging.s
   })
 
   it('does not announce a zip whose served bytes fail the manifest hash', () => {
-    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64')
-    const result = run(['1.2.90', x64, arm64], { SHIM_ROOT: root, SHIM_MODE: 'corrupt-readback', PATH: `${shim(root)}:${process.env.PATH}` })
+    const root = scratch(), x64 = zip(root, '1.2.90', 'x64'), arm64 = zip(root, '1.2.90', 'arm64'), exe = installer(root)
+    const result = run(['1.2.90', x64, arm64, exe], { SHIM_ROOT: root, SHIM_MODE: 'corrupt-readback', PATH: `${shim(root)}:${process.env.PATH}` })
     expect(result.status).toBe(1)
     expect(result.stderr).toContain('x64 served bytes differ')
     expect(existsSync(join(root, 'uploaded-metadata.json'))).toBe(false)
````

At the end of the `describe` in `cli/src/scripts/windowsWorkflows.spec.ts`, before F2.2's case:

```ts
  // Installer spec §2.4 and §4.2.
  it('tests harness-install.exe on both runners and publishes a staging one with the staging zips', () => {
    const desktop = read('windows-desktop.yml')
    expect(desktop).toMatch(/- name: harness-install\.exe tests\n\s+working-directory: installer\n\s+run: \|\n\s+cargo test --locked\n/)
    expect(desktop).toContain('HARNESS_INSTALL_BIN: ${{ github.workspace }}\\installer\\target\\debug\\harness-install.exe')
    expect(desktop).toContain('HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/')
    expect(desktop).toContain('windows-arm64.zip" .zips/harness-install.exe')
    expect(desktop).toContain("'desktop-windows-installer': 'harness-install.exe'")
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/scripts/publishDesktopWindowsStaging.spec.ts src/scripts/windowsWorkflows.spec.ts`
Expected: FAIL: four arguments are a usage error today (exit 2), and the workflow builds no staging installer.

- [ ] **Step 3: The publisher takes the installer**

Apply to `desktop/scripts/publish-desktop-windows-staging.sh`:

````diff
--- a/desktop/scripts/publish-desktop-windows-staging.sh
+++ b/desktop/scripts/publish-desktop-windows-staging.sh
@@ -1,6 +1,6 @@
 #!/usr/bin/env bash
-# Publish the two install-shaped Windows desktop zips under a staging prefix only.
-# DRY_RUN=1 writes proposed Windows entries and local zip copies without contacting GCS.
+# Publish the two install-shaped Windows desktop zips and harness-install.exe under a staging prefix only.
+# DRY_RUN=1 writes proposed Windows entries and local copies without contacting GCS.
 # Live publication reads one observed manifest generation and conditionally replaces it;
 # a failed or partial publish burns this version and must be followed by a new one.
 set -euo pipefail
@@ -8,9 +8,10 @@
 VERSION="${1:-}"
 X64_ZIP="${2:-}"
 ARM64_ZIP="${3:-}"
+INSTALLER="${4:-}"
 if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] ||
-  [ -z "$X64_ZIP" ] || [ -z "$ARM64_ZIP" ] || [ "$#" -ne 3 ]; then
-  echo "usage: $0 <X.Y.Z[-prerelease]> <x64 zip> <arm64 zip>" >&2
+  [ -z "$X64_ZIP" ] || [ -z "$ARM64_ZIP" ] || [ -z "$INSTALLER" ] || [ "$#" -ne 4 ]; then
+  echo "usage: $0 <X.Y.Z[-prerelease]> <x64 zip> <arm64 zip> <harness-install.exe>" >&2
   exit 2
 fi
 REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
@@ -31,7 +32,7 @@
   exit 2
 fi
 if [ "$DRY_RUN" = 1 ] && [ -z "${DRY_RUN_OUT:-}" ]; then
-  echo 'error: DRY_RUN=1 needs DRY_RUN_OUT, a local folder for proposed entries and zips' >&2
+  echo 'error: DRY_RUN=1 needs DRY_RUN_OUT, a local folder for proposed entries and files' >&2
   exit 2
 fi
 for tool in node python3; do
@@ -71,11 +72,26 @@
   node "$REPO/cli/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "desktop-windows-${arch}" "$VERSION" "$url" "$hash" "$size"
 done
 
+# harness-install.exe: one x64 program for every PC, built for the staging manifest (installer spec §2.4).
+[ -f "$INSTALLER" ] || { echo "error: $INSTALLER is missing" >&2; exit 1; }
+[ "$(basename "$INSTALLER")" = harness-install.exe ] || {
+  echo "error: the installer must be named harness-install.exe, not $(basename "$INSTALLER")" >&2
+  exit 1
+}
+[ "$(head -c 2 "$INSTALLER")" = MZ ] || { echo "error: $INSTALLER is not a Windows program" >&2; exit 1; }
+ARCHES+=(installer)
+ZIPS+=("$INSTALLER")
+OBJECTS+=("${STAGING_PREFIX}/desktop/${VERSION}/harness-install.exe")
+SIZES+=("$(wc -c < "$INSTALLER" | tr -d ' ')")
+HASHES+=("$(sha256_of "$INSTALLER")")
+node "$REPO/cli/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" desktop-windows-installer "$VERSION" \
+  "${CDN_ASSET_BASE_URL%/}/${OBJECTS[2]}" "${HASHES[2]}" "${SIZES[2]}"
+
 if [ "$DRY_RUN" = 1 ]; then
   mkdir -p "$DRY_RUN_OUT"
   for zip in "${ZIPS[@]}"; do cp "$zip" "$DRY_RUN_OUT/"; done
   cp "$WORK/entries.json" "$DRY_RUN_OUT/metadata.json"
-  echo ">> dry run: proposed Windows entries and both zips in $DRY_RUN_OUT; no bucket was read or written"
+  echo ">> dry run: proposed Windows entries and the three files in $DRY_RUN_OUT; no bucket was read or written"
   exit 0
 fi
 
@@ -119,21 +135,21 @@
 writeFileSync(dst, JSON.stringify(document, null, 2) + '\n')
 JS
 
-for i in 0 1; do
+for i in 0 1 2; do
   arch="${ARCHES[$i]}"
   uri="gs://${GCS_BUCKET}/${OBJECTS[$i]}"
-  echo ">> uploading $arch zip (${SIZES[$i]} bytes) to $uri"
+  echo ">> uploading $arch (${SIZES[$i]} bytes) to $uri"
   if ! gcloud storage cp --if-generation-match=0 --cache-control='public, max-age=31536000, immutable' "${ZIPS[$i]}" "$uri"; then
     echo "error: $arch upload failed; attempted $arch object outcome is unknown. Confirmed prior uploads: ${UPLOADED[*]:-none}. Inspect staging and publish a new version; no metadata was written." >&2
     exit 1
   fi
   UPLOADED+=("$arch")
-  if ! gcloud storage cp "$uri" "$WORK/verify-$arch.zip" >/dev/null; then
+  if ! gcloud storage cp "$uri" "$WORK/verify-$arch" >/dev/null; then
     echo "error: cannot read back $arch; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
     exit 1
   fi
-  served_size="$(wc -c < "$WORK/verify-$arch.zip" | tr -d ' ')"
-  served_hash="$(sha256_of "$WORK/verify-$arch.zip")"
+  served_size="$(wc -c < "$WORK/verify-$arch" | tr -d ' ')"
+  served_hash="$(sha256_of "$WORK/verify-$arch")"
   if [ "$served_size" != "${SIZES[$i]}" ] || [ "$served_hash" != "${HASHES[$i]}" ]; then
     echo "error: $arch served bytes differ; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
     exit 1
@@ -142,7 +158,7 @@
 
 if ! gcloud storage cp --if-generation-match="$generation" --content-type=application/json \
     --cache-control='no-cache, no-store, must-revalidate' "$WORK/metadata.next.json" "$METADATA_URI"; then
-  echo "error: metadata changed or write result is unknown; both zips uploaded. Inspect staging and publish a new version." >&2
+  echo "error: metadata changed or write result is unknown; all three files uploaded. Inspect staging and publish a new version." >&2
   exit 1
 fi
 echo ">> published Windows desktop $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
````

and to `.github/workflows/windows-desktop.yml`:

````diff
--- a/.github/workflows/windows-desktop.yml
+++ b/.github/workflows/windows-desktop.yml
@@ -424,6 +424,23 @@
           name: harness-desktop-zip-windows-${{ matrix.arch }}
           path: desktop/build/windows-zip/harness-desktop-${{ env.VERSION }}-windows-${{ matrix.arch }}.zip
           if-no-files-found: error
+      # One x64 harness-install.exe for every PC, reading the staging manifest (installer spec §2.4).
+      - name: Build the staging harness-install.exe
+        if: matrix.arch == 'x64'
+        shell: pwsh
+        working-directory: installer
+        env:
+          HARNESS_INSTALL_BASE: https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/
+          HARNESS_INSTALL_VERSION: ${{ env.VERSION }}
+        run: |
+          cargo build --locked --release --target ${{ matrix.target }}
+          if ($LASTEXITCODE -ne 0) { throw "harness-install build failed ($LASTEXITCODE)" }
+      - uses: actions/upload-artifact@v4
+        if: matrix.arch == 'x64'
+        with:
+          name: harness-install-staging
+          path: installer/target/${{ matrix.target }}/release/harness-install.exe
+          if-no-files-found: error
 
   release-staging:
     needs: [mode, release-build]
@@ -447,9 +464,13 @@
           pattern: harness-desktop-zip-windows-*
           path: .zips
           merge-multiple: true
+      - uses: actions/download-artifact@v4
+        with:
+          name: harness-install-staging
+          path: .zips
       - name: Dry run
         if: ${{ needs.mode.outputs.dry_run == 'true' }}
-        run: DRY_RUN=1 DRY_RUN_OUT=.dry-run bash desktop/scripts/publish-desktop-windows-staging.sh "$VERSION" ".zips/harness-desktop-$VERSION-windows-x64.zip" ".zips/harness-desktop-$VERSION-windows-arm64.zip"
+        run: DRY_RUN=1 DRY_RUN_OUT=.dry-run bash desktop/scripts/publish-desktop-windows-staging.sh "$VERSION" ".zips/harness-desktop-$VERSION-windows-x64.zip" ".zips/harness-desktop-$VERSION-windows-arm64.zip" .zips/harness-install.exe
       - uses: actions/upload-artifact@v4
         if: ${{ needs.mode.outputs.dry_run == 'true' }}
         with:
@@ -466,7 +487,7 @@
         if: ${{ needs.mode.outputs.dry_run != 'true' }}
       - name: Publish to staging
         if: ${{ needs.mode.outputs.dry_run != 'true' }}
-        run: bash desktop/scripts/publish-desktop-windows-staging.sh "$VERSION" ".zips/harness-desktop-$VERSION-windows-x64.zip" ".zips/harness-desktop-$VERSION-windows-arm64.zip"
+        run: bash desktop/scripts/publish-desktop-windows-staging.sh "$VERSION" ".zips/harness-desktop-$VERSION-windows-x64.zip" ".zips/harness-desktop-$VERSION-windows-arm64.zip" .zips/harness-install.exe
       - name: Verify served staging artifacts
         if: ${{ needs.mode.outputs.dry_run != 'true' }}
         run: |
@@ -479,10 +500,14 @@
               const response = await fetch(manifest, { cache: 'no-store' })
               if (!response.ok) throw new Error(`GET ${manifest} -> ${response.status}`)
               const document = await response.json()
-              for (const arch of ['x64', 'arm64']) {
-                const key = `desktop-windows-${arch}`
+              const files = {
+                'desktop-windows-x64': `harness-desktop-${VERSION}-windows-x64.zip`,
+                'desktop-windows-arm64': `harness-desktop-${VERSION}-windows-arm64.zip`,
+                'desktop-windows-installer': 'harness-install.exe',
+              }
+              for (const [key, file] of Object.entries(files)) {
                 const entry = document[key]
-                const expectedUrl = `https://cdn.autonomous.ai/${STAGING_PREFIX}/desktop/${VERSION}/harness-desktop-${VERSION}-windows-${arch}.zip`
+                const expectedUrl = `https://cdn.autonomous.ai/${STAGING_PREFIX}/desktop/${VERSION}/${file}`
                 if (!entry || entry.version !== VERSION || entry.url !== expectedUrl) throw new Error(`${key}: manifest entry differs`)
                 const served = await fetch(entry.url, { cache: 'no-store' })
                 if (!served.ok) throw new Error(`${key}: GET ${entry.url} -> ${served.status}`)
@@ -491,7 +516,7 @@
                   throw new Error(`${key}: served bytes differ`)
                 }
               }
-              console.log(`staging desktop ${VERSION}: x64 + arm64 verified`)
+              console.log(`staging desktop ${VERSION}: x64, arm64 and harness-install.exe verified`)
             }
             main().catch((error) => { console.error(`::error::${error.message}`); process.exit(1) })
           JS
````

- [ ] **Step 4: The docs**

Apply (`git apply`):

````diff
diff --git a/desktop/RELEASE.md b/desktop/RELEASE.md
--- a/desktop/RELEASE.md
+++ b/desktop/RELEASE.md
@@ -26,7 +26,7 @@ HTTPS read of the manifest; `--prepare` and `--wait` also need the authenticated
 
 For an authorized release, run `--prepare` once the final implementation is pushed to its PR
 branch, while the required tests and review run. It selects the next version by the same rules
-as a release, builds/signs/notarizes all platforms in CI, and verifies all six downloads at an
+as a release, builds/signs/notarizes all platforms in CI, and verifies all nine downloads at an
 isolated candidate path. It creates neither a release tag nor a product manifest/Release page.
 After checks pass, merge and release that same version normally. CI reuses the candidate only
 when the Desktop build inputs and version match; unrelated component merges and a clean
@@ -168,8 +168,8 @@ It compiles one universal app, copies it into separate directories, pins and ver
 renderer, then packages, notarizes and uploads both variants in parallel. Version/build-number,
 arm64/x86_64 slices, signatures and hardened runtime are checked before publication. Each variant
 still receives both app and DMG notarization, with the stapled app inside the DMG. Separate scratch
-manifests are combined only after all macOS and Linux builds succeed, followed by verification of
-all six public downloads. `macos-build-timings` records the bounded build and per-variant phases.
+manifests are combined only after all macOS, Linux and Windows builds succeed, followed by verification of
+all nine public downloads. `macos-build-timings` records the bounded build and per-variant phases.
 App copies and DMG staging use independent APFS clones when available. The temporary
 notarization ZIP uses faster compression; the downloadable ZIP retains normal compression
 and is rebuilt from the stapled app while DMG notarization runs. Compression failures stop
@@ -481,7 +481,7 @@ running app back.
 `scripts/upload-desktop-linux.sh` publishes architecture-specific Linux ARM64 and x64 releases to the
 **same** `metadata.json` as macOS. `release-desktop.yml` runs it on both a `ubuntu-22.04` and a
 `ubuntu-22.04-arm` runner — the oldest Ubuntu supported, because the bundle links the build host's
-GLib and glibc and a 24.04 build will not start on 22.04 — so one `make release-desktop` covers every build — which is also why the six
+GLib and glibc and a 24.04 build will not start on 22.04 — so one `make release-desktop` covers every build — which is also why the nine
 `desktop-*` keys only stay on one version when the release goes through CI. Run by hand
 (`make upload-desktop-linux ARCH=arm64`) it moves one key and leaves the others behind. `amd64` and
 `x86_64` are accepted aliases for `x64`; `aarch64` is accepted as an alias for `arm64`.
@@ -556,7 +556,24 @@ Same shape as macOS (see above), with the platform-specific pieces:
 Same conventions as macOS — publish to a scratch `METADATA_PATH` first, and roll back only by
 publishing a newer version containing the older code (see above).
 
-## Windows (staging)
+## Windows
+
+Every release ships Windows with macOS and Linux: `release-desktop.yml`'s `build-windows` builds each architecture on
+its own runner and `upload-windows` publishes from ubuntu. Three files go to `harness/desktop/<version>/`:
+
+- `Harness-windows-x64.zip` and `Harness-windows-arm64.zip` (`desktop-windows-x64`, `desktop-windows-arm64`), the
+  install-shaped zips below, which the Windows updater and `install.ps1 -App` take;
+- `harness-install.exe` (`desktop-windows-installer`), what the website's **Download for Windows** serves. It carries
+  no app: it reads the manifest when it runs, picks this PC's zip as `install.ps1 -App` does, checks it and runs its
+  `Harness.exe --install` (`installer/`, docs/superpowers/specs/2026-10-19-windows-installer-design.md).
+
+Nothing is code-signed yet. Windows shows SmartScreen once, on the installer a browser downloaded; Smart App Control
+blocks the build where it is on. A failed Windows build stops the release, as a failed macOS or Linux build does.
+
+If Microsoft Defender flags `harness-install.exe` or the app, submit the file as a software developer at
+https://www.microsoft.com/wdsi/filesubmission with the release version. Do not change the build to dodge a detection.
+
+### Staging
 
 `scripts/package-windows.ps1` packages the complete Flutter Release bundle in the per-user install shape:
 `Harness.exe` (the `harness-desktop-launcher` binary), `Harness.ico`, `current`, and
@@ -566,7 +583,8 @@ zip, and the Windows updater consumes the same layout. The version comes from th
 `ProductVersion` resource, stamped by `flutter build windows --build-name <version>`; Windows
 does not use a `version.txt` file.
 
-The Windows desktop workflow has a release mode that builds both x64 and arm64 staging zips on
+The Windows desktop workflow has a release mode that builds both x64 and arm64 staging zips, and a staging
+`harness-install.exe` (`desktop-windows-installer`) in the x64 job, on
 their own runners. It passes `--dart-define=HARNESS_STAGING=true`, so the installed app reads the
 staging desktop manifest and installs the staging CLI. `dry_run` defaults to true. Its artifact
 contains **proposed Windows manifest entries**, computed without reading or writing the bucket;
@@ -586,12 +604,13 @@ Until then, the temporary branch push trigger recognizes a head-commit subject o
 gs://s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json
 gs://s3-autonomous-upgrade-3/harness/staging/desktop/<version>/harness-desktop-<version>-windows-x64.zip
 gs://s3-autonomous-upgrade-3/harness/staging/desktop/<version>/harness-desktop-<version>-windows-arm64.zip
+gs://s3-autonomous-upgrade-3/harness/staging/desktop/<version>/harness-install.exe
 ```
 
-The publisher validates both complete zips before upload, creates each versioned object only
+The publisher validates both complete zips (`check-windows-zip.py`) and the installer before upload, creates each versioned object only
 when absent, reads the uploaded bytes back, and conditionally writes the manifest so another
 publisher's change cannot be lost. If a publish stops after uploading an object, that version is
-spent: inspect staging and use a new version. Production publication and signing are separate.
+spent: inspect staging and use a new version. Signing is separate.
 
 **Install by one command.** After an approved staging publish, `bash cli/scripts/upload-install-ps1.sh --app`
 publishes `harness/staging/desktop/install.ps1`, a copy of B's installer with its app-default line on. A person runs
````

````diff
diff --git a/docs/validation-and-release.md b/docs/validation-and-release.md
--- a/docs/validation-and-release.md
+++ b/docs/validation-and-release.md
@@ -167,9 +167,9 @@ When the final implementation is pushed, start `make release-desktop ARGS="--pre
 on that PR branch alongside its required tests and review. This chooses the next
 version using the same tags/live-manifest rules as a release, then dispatches a
 candidate build. Use an explicit version with `--prepare` when preparing a minor
-bump. The candidate uses the release's normal macOS and Linux build, signing and
+bump. The candidate uses the release's normal macOS, Linux and Windows build, signing and
 notarization steps and production updater settings. It writes only to a random
-candidate prefix, verifies all six downloads, and retains a small receipt in
+candidate prefix, verifies all nine downloads, and retains a small receipt in
 GitHub Actions. It neither tags nor updates the product manifest or Release page.
 
 After validation and review pass, merge and release that version normally. The
@@ -191,7 +191,7 @@ or malformed responses cannot authorize reuse. The workflow checks the
 producer run's successful completion, repository, workflow, source, attempt and
 immutable receipt digest. Promotion copies only the exact object generations
 whose sizes and SHA-256 hashes were verified, with atomic no-overwrite conditions.
-The normal version check, serialized manifest publication and six public-download
+The normal version check, serialized manifest publication and nine public-download
 checks still apply. Candidate packaging never substitutes for application tests
 or authorizes a merge or release.
 
@@ -212,7 +212,7 @@ Unused candidates expire after seven days; a daily job deletes only recognized
 old candidate objects at their listed generations. Failed candidates and consumed
 candidates are removed by their owning workflow. For process maintenance, dispatch
 `test_candidate_reuse=true` for the same branch/version after its candidate passes:
-it requires reuse, promotes to disposable paths, verifies all six downloads, then
+it requires reuse, promotes to disposable paths, verifies all nine downloads, then
 removes those objects and the consumed candidate. It cannot publish a product.
 
 PR CI runs the TUI unit tests only. The TUI release builds the shipped musl targets
````

````diff
diff --git a/AGENTS.md b/AGENTS.md
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -23,7 +23,7 @@ For product names, terminology, and visible copy, follow the
   suite as passing, and never silently skip a required check to meet a time target.
 - Once required checks pass, carry out the authorized merge/release without another
   validation cycle. Verify published versions and checksums, then report completion.
-  Desktop's `--wait` follows the exact tag/SHA through the workflow's six-artifact
+  Desktop's `--wait` follows the exact tag/SHA through the workflow's nine-artifact
   verification; reuse that receipt instead of repeating the downloads manually.
 - CI rules (details in [docs/validation-and-release.md](docs/validation-and-release.md#pr-ci)):
   - PR CI is fast on purpose. It runs only the Linux unit checks of the components
````

````diff
diff --git a/desktop/scripts/release-desktop.sh b/desktop/scripts/release-desktop.sh
--- a/desktop/scripts/release-desktop.sh
+++ b/desktop/scripts/release-desktop.sh
@@ -1,6 +1,6 @@
 #!/usr/bin/env bash
 # Cut a desktop release: work out the next version, tag it, push the tag. CI does everything else —
-# ../.github/workflows/release-desktop.yml builds macOS + Linux, publishes to GCS, and creates the
+# ../.github/workflows/release-desktop.yml builds macOS, Linux and Windows, publishes to GCS, and creates the
 # GitHub Release. The tag IS the version; CI never bumps on its own. Tags are "vX.Y.Z_desktop" — the
 # "_desktop" suffix is stripped by release-desktop.yml before anything treats it as a version; it
 # exists only so this tag never also triggers the CLI's "vX.Y.Z_cli" or the backend's "vX.Y.Z_backend"
@@ -308,7 +308,7 @@ git tag -a "$TAG" --cleanup=verbatim -F "$NOTES"
 git push origin "$TAG"
 
 echo ""
-echo "  pushed $TAG → CI builds macOS + Linux, publishes to GCS, and cuts the GitHub Release."
+echo "  pushed $TAG → CI builds macOS, Linux and Windows, publishes to GCS, and cuts the GitHub Release."
 echo "  watch (from repo root): python3 scripts/watch-desktop-release.py $TAG --sha $HEAD_SHA"
 echo ""
 if [ "$WAIT" -eq 1 ]; then
````

````diff
diff --git a/desktop/scripts/build-macos-variants.py b/desktop/scripts/build-macos-variants.py
--- a/desktop/scripts/build-macos-variants.py
+++ b/desktop/scripts/build-macos-variants.py
@@ -143,7 +143,7 @@ def main(argv=None):
     parser.add_argument("--metadata-prefix", type=object_prefix, help="publish only to these separate per-variant manifests")
     parser.add_argument("--artifact-prefix", type=object_prefix)
     parser.add_argument("--artifact-suffix", default="")
-    parser.add_argument("--verify-downloads", action="store_true", help="verify all four internal-build downloads; real releases use their six-artifact final gate")
+    parser.add_argument("--verify-downloads", action="store_true", help="verify all four internal-build downloads; real releases use their nine-artifact final gate")
     parser.add_argument("--dart-define", action="append", default=[])
     args = parser.parse_args(argv)
     if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
````

- [ ] **Step 5: Run everything the change touches**

Run:

```bash
(cd cli && npx vitest run src/scripts/publishDesktopWindowsStaging.spec.ts src/scripts/windowsWorkflows.spec.ts src/scripts/uploadDesktopWindows.spec.ts)
actionlint .github/workflows/windows-desktop.yml
bash -n desktop/scripts/release-desktop.sh
```

Expected: 14, 6 and 5 tests pass; `actionlint` clean.

- [ ] **Step 6: Commit and push**

```bash
git add desktop/scripts/publish-desktop-windows-staging.sh cli/src/scripts/publishDesktopWindowsStaging.spec.ts \
  .github/workflows/windows-desktop.yml cli/src/scripts/windowsWorkflows.spec.ts \
  desktop/RELEASE.md docs/validation-and-release.md AGENTS.md desktop/scripts/release-desktop.sh desktop/scripts/build-macos-variants.py
git commit -m "ci(windows): the staging release publishes harness-install.exe; the release docs count nine artifacts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-desktop
```

Expected: the `Windows desktop` test run on this head passes as F1.4's did (`release-build` runs only in release mode).

---

## Phase F3: The website

### Task F3.1: Download for Windows

**Files:**
- Create: `website/src/app/desktop/download/windows/route.ts`, `route.spec.ts`, `website/src/lib/desktopPlatform.spec.ts`, `website/src/app/desktop/DesktopDownload.spec.tsx`
- Modify: `website/src/lib/installCommand.ts`, `website/src/lib/desktopPlatform.ts`, `website/src/app/desktop/DesktopDownload.tsx`, `website/src/app/desktop/page.tsx`, `website/src/app/download/page.spec.tsx`

**Interfaces:**
- Consumes: F2's manifest key `desktop-windows-installer`; `resolveDesktopDownload(key, ext)` (`website/src/lib/desktopManifest.ts`, unchanged: it already accepts only the bucket and CDN's `harness/desktop/`).
- Produces: `DESKTOP_DOWNLOAD_WINDOWS_URL = "/desktop/download/windows"`, `DESKTOP_WINDOWS_INSTALL_COMMAND`; `DesktopBuildId` gains `windows`, and `VisitorPlatform`'s `windows` is now that build.

- [ ] **Step 1: Write the failing specs**

`website/src/app/desktop/download/windows/route.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ASSET = "https://cdn.autonomous.ai/harness/desktop/1.3.4/harness-install.exe";

function manifest(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /desktop/download/windows", () => {
  it("redirects to the installer the manifest currently advertises, and never caches the hop", async () => {
    manifest({ "desktop-windows-installer": { version: "1.3.4", url: ASSET, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ASSET);
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  // The zips are what the app's updater and install.ps1 take; a browser gets the installer, never a zip.
  it("serves the installer, not either zip", async () => {
    manifest({
      "desktop-windows-x64": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-windows-x64.zip" },
      "desktop-windows-installer": { url: ASSET },
    });
    expect((await GET()).headers.get("Location")).toBe(ASSET);

    manifest({ "desktop-windows-installer": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-windows-x64.zip" } });
    expect((await GET()).status).toBe(503);
  });

  it("refuses to redirect outside the release bucket", async () => {
    manifest({ "desktop-windows-installer": { url: "https://evil.example/harness-install.exe" } });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
  });

  // Until the first release with Windows, the manifest has no key: "not ready", not a broken page.
  it("reports 503 when the manifest carries no installer yet", async () => {
    manifest({ "desktop-linux-x64": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-linux-x64.AppImage" } });

    expect((await GET()).status).toBe(503);
  });
});
```

`website/src/lib/desktopPlatform.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DESKTOP_BUILD, DESKTOP_BUILDS, buildsFor, detectVisitorPlatform, platformFromUserAgent } from "./desktopPlatform";

const EDGE_ON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

describe("the Windows desktop build", () => {
  it("is one build for both CPUs, behind the manifest-backed route", () => {
    expect(DESKTOP_BUILD.windows).toEqual({ id: "windows", name: "Windows", detail: "x64 and ARM", href: "/desktop/download/windows" });
    expect(DESKTOP_BUILDS.map((build) => build.id)).toEqual(["macos", "linux-x64", "linux-arm64", "windows"]);
  });

  it("is what a Windows browser gets, whatever its CPU", async () => {
    expect(platformFromUserAgent({ userAgent: EDGE_ON_WINDOWS, platform: "Win32" })).toBe("windows");
    for (const architecture of ["x86", "arm"]) {
      const platform = await detectVisitorPlatform({
        userAgent: EDGE_ON_WINDOWS,
        userAgentData: { platform: "Windows", mobile: false, getHighEntropyValues: async () => ({ architecture, bitness: "64" }) },
      });
      expect(platform, architecture).toBe("windows");
    }
  });

  it("is listed for every visitor, the Windows one included", () => {
    for (const platform of ["windows", "macos-arm64", "linux-x64", null] as const) {
      expect(buildsFor(platform).some((build) => build.id === "windows"), String(platform)).toBe(true);
    }
  });
});
```

`website/src/app/desktop/DesktopDownload.spec.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitorPlatform } from "@/lib/desktopPlatform";

let platform: VisitorPlatform | null = null;
vi.mock("@/lib/useVisitorPlatform", () => ({ useVisitorPlatform: () => platform }));

const { DesktopDownload } = await import("./DesktopDownload");

describe("the /desktop download offer", () => {
  beforeEach(() => {
    platform = null;
  });

  it("gives a Windows visitor the installer, the way past SmartScreen, and the PowerShell line", () => {
    platform = "windows";
    render(<DesktopDownload />);

    expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", "/desktop/download/windows");
    expect(screen.getByText("Download the installer and open it. It sets up Harness and opens the app.")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("isn't code-signed yet, so Windows may say it protected your PC. Choose More info, then Run anyway.");
    expect(document.body).toHaveTextContent("irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex");
    expect(screen.getByRole("link", { name: "macOS" })).toHaveAttribute("href", "/desktop/download-macos");
    expect(screen.getByRole("link", { name: "Linux (x64)" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("no Windows version");
  });

  it("lists Windows among the other downloads on a Mac", () => {
    platform = "macos-arm64";
    render(<DesktopDownload />);

    expect(screen.getByRole("link", { name: "Windows" })).toHaveAttribute("href", "/desktop/download/windows");
  });

  it("names Windows among the computers a phone visitor can open the page on", () => {
    platform = "mobile";
    render(<DesktopDownload />);

    expect(document.body).toHaveTextContent("runs on a Mac, a Windows PC or a Linux computer");
  });
});
```

and in `website/src/app/download/page.spec.tsx`:

````diff
diff --git a/website/src/app/download/page.spec.tsx b/website/src/app/download/page.spec.tsx
--- a/website/src/app/download/page.spec.tsx
+++ b/website/src/app/download/page.spec.tsx
@@ -37,6 +37,7 @@ describe("/download", () => {
       "href",
       "/desktop/download/linux-arm64",
     );
+    expect(screen.getByRole("link", { name: /Windows/ })).toHaveAttribute("href", "/desktop/download/windows");
     // No install script for the desktop app any more — direct links only. (The CLI section below
     // still has its own `cli/install.sh` script, which is intentional and covered separately.)
     expect(document.body).not.toHaveTextContent("desktop/install.sh");
````

- [ ] **Step 2: Run them to see them fail**

Run: `cd website && npx vitest run src/app/desktop src/app/download src/lib`
Expected: FAIL: `./route` does not exist; `DESKTOP_BUILD.windows` is undefined; no "Download for Windows" link; `/download` lists no Windows.

- [ ] **Step 3: The route**

`website/src/app/desktop/download/windows/route.ts`:

```ts
/**
 * `GET /desktop/download/windows` — hand a Windows visitor the current `harness-install.exe`, the
 * `desktop-windows-installer` key (docs/superpowers/specs/2026-10-19-windows-installer-design.md §3). One x64
 * program for every Windows PC: it reads the same manifest when it runs and installs the app for the PC's own CPU.
 * See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveDesktopDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveDesktopDownload("desktop-windows-installer", ".exe");
}
```

- [ ] **Step 4: The build, the offer and the copy**

Apply (`git apply`):

````diff
diff --git a/website/src/lib/installCommand.ts b/website/src/lib/installCommand.ts
--- a/website/src/lib/installCommand.ts
+++ b/website/src/lib/installCommand.ts
@@ -52,3 +52,16 @@ export const DESKTOP_DOWNLOAD_LINUX_ARM64_URL = "/desktop/download/linux-arm64";
  * whose browser reports an ARM CPU; `DESKTOP_DOWNLOAD_URL` stays the one every other Mac gets.
  */
 export const DESKTOP_DOWNLOAD_MACOS_ARM64_URL = "/desktop/download/macos-arm64";
+
+/**
+ * Windows: `src/app/desktop/download/windows/`, redirecting to the manifest's `harness-install.exe`
+ * (`desktop-windows-installer`). One x64 program for every Windows PC: it installs the app built for the
+ * PC's own CPU, so there is no per-architecture link.
+ */
+export const DESKTOP_DOWNLOAD_WINDOWS_URL = "/desktop/download/windows";
+
+/**
+ * The PowerShell alternative to the Windows installer, verbatim. The script is the CLI's install.ps1 in its
+ * app mode, published as `harness/desktop/install.ps1` by `cli/scripts/upload-install-ps1.sh --app --production`.
+ */
+export const DESKTOP_WINDOWS_INSTALL_COMMAND = "irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex";
````

````diff
diff --git a/website/src/lib/desktopPlatform.ts b/website/src/lib/desktopPlatform.ts
--- a/website/src/lib/desktopPlatform.ts
+++ b/website/src/lib/desktopPlatform.ts
@@ -25,9 +25,10 @@ import {
   DESKTOP_DOWNLOAD_LINUX_X64_URL,
   DESKTOP_DOWNLOAD_MACOS_ARM64_URL,
   DESKTOP_DOWNLOAD_URL,
+  DESKTOP_DOWNLOAD_WINDOWS_URL,
 } from "@/lib/installCommand";
 
-export type DesktopBuildId = "macos" | "macos-arm64" | "linux-x64" | "linux-arm64";
+export type DesktopBuildId = "macos" | "macos-arm64" | "linux-x64" | "linux-arm64" | "windows";
 
 export type DesktopBuild = {
   id: DesktopBuildId;
@@ -46,6 +47,8 @@ export const DESKTOP_BUILD = {
   },
   "linux-x64": { id: "linux-x64", name: "Linux (x64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_X64_URL },
   "linux-arm64": { id: "linux-arm64", name: "Linux (ARM64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_ARM64_URL },
+  // One installer for both CPUs: it picks the app for the PC it runs on.
+  windows: { id: "windows", name: "Windows", detail: "x64 and ARM", href: DESKTOP_DOWNLOAD_WINDOWS_URL },
 } as const satisfies Record<DesktopBuildId, DesktopBuild>;
 
 /**
@@ -56,16 +59,18 @@ export const DESKTOP_BUILDS: readonly DesktopBuild[] = [
   DESKTOP_BUILD.macos,
   DESKTOP_BUILD["linux-x64"],
   DESKTOP_BUILD["linux-arm64"],
+  DESKTOP_BUILD.windows,
 ];
 
 /**
  * What the visitor is on, as far as the desktop download cares:
  * - a `DesktopBuildId`: that build suits this computer (`macos` also covers a Mac of unknown CPU);
  * - `linux`: Linux, but the browser did not say which CPU (or it is one with no build);
- * - `windows`, `mobile`: no desktop build runs here (`mobile` covers phones and tablets, iPad included);
+ * - `windows` is a `DesktopBuildId` too: one installer serves both of its CPUs;
+ * - `mobile`: no desktop build runs here (phones and tablets, iPad included);
  * - `unknown`: anything else, ChromeOS included. Pages treat it like no detection at all.
  */
-export type VisitorPlatform = DesktopBuildId | "linux" | "windows" | "mobile" | "unknown";
+export type VisitorPlatform = DesktopBuildId | "linux" | "mobile" | "unknown";
 
 /**
  * `DESKTOP_BUILDS` as this visitor should see them: on an ARM Mac, macOS's row (still named "macOS")
````

````diff
diff --git a/website/src/app/desktop/DesktopDownload.tsx b/website/src/app/desktop/DesktopDownload.tsx
--- a/website/src/app/desktop/DesktopDownload.tsx
+++ b/website/src/app/desktop/DesktopDownload.tsx
@@ -4,6 +4,7 @@ import { Fragment } from "react";
 import { Download } from "lucide-react";
 import styles from "./page.module.css";
 import { DESKTOP_BUILD, DESKTOP_BUILDS, type DesktopBuild, type VisitorPlatform } from "@/lib/desktopPlatform";
+import { DESKTOP_WINDOWS_INSTALL_COMMAND } from "@/lib/installCommand";
 import { useVisitorPlatform } from "@/lib/useVisitorPlatform";
 
 type Offer = {
@@ -26,6 +27,10 @@ const MAC_DESCRIPTION = "Download the app for macOS, then drag Harness into your
 const MAC_TRUST = "Signed and notarized by Apple, so it opens without a security warning. Requires macOS 12 or later.";
 const LINUX_DESCRIPTION = "Download the AppImage, make it executable (chmod +x), then open it.";
 const LINUX_NOTE = "Built for Ubuntu 22.04 or later.";
+// The build is unsigned until code signing lands, so the person meets SmartScreen once and needs the way past it.
+const WINDOWS_NOTE =
+  "Harness for Windows isn't code-signed yet, so Windows may say it protected your PC. Choose More info, then Run anyway. " +
+  `Prefer PowerShell? Run ${DESKTOP_WINDOWS_INSTALL_COMMAND}. Requires Windows 10 or 11.`;
 
 const MAC_OFFER: Offer = {
   primary: [DESKTOP_BUILD.macos],
@@ -67,10 +72,11 @@ function offerFor(platform: VisitorPlatform | null): Offer {
     }
     case "windows":
       return {
-        primary: [],
-        others: DESKTOP_BUILDS,
-        othersLabel: "Downloading for another computer?",
-        description: "The Harness desktop app runs on macOS and Linux. There is no Windows version yet.",
+        primary: [DESKTOP_BUILD.windows],
+        others: othersThan([DESKTOP_BUILD.windows]),
+        othersLabel: "Other downloads:",
+        description: "Download the installer and open it. It sets up Harness and opens the app.",
+        note: WINDOWS_NOTE,
       };
     case "mobile":
       return {
@@ -78,7 +84,7 @@ function offerFor(platform: VisitorPlatform | null): Offer {
         others: DESKTOP_BUILDS,
         othersLabel: "Downloading for another computer?",
         description:
-          "The Harness desktop app runs on a Mac or a Linux computer. Open this page on that computer to download it.",
+          "The Harness desktop app runs on a Mac, a Windows PC or a Linux computer. Open this page on that computer to download it.",
       };
     default:
       // Not answered yet, a Mac of unknown CPU, or nothing recognizable: exactly what the server rendered.
````

````diff
diff --git a/website/src/app/desktop/page.tsx b/website/src/app/desktop/page.tsx
--- a/website/src/app/desktop/page.tsx
+++ b/website/src/app/desktop/page.tsx
@@ -10,7 +10,7 @@ export default function DesktopPage() {
         <div className={styles.badge}>
           <Download size={21} strokeWidth={2} />
         </div>
-        <p className={styles.eyebrow}>Harness for macOS and Linux</p>
+        <p className={styles.eyebrow}>Harness for macOS, Windows and Linux</p>
         <h1 className={styles.title}>Install the Harness desktop app</h1>
         <DesktopDownload />
         <p className={styles.description}>
````

The page's terminal block (`curl … | bash`) and the CLI section stay "macOS and Linux": those commands are for those systems. `grep -rn "macOS and Linux\|Mac or a Linux" website/src` then finds only those two notes.

- [ ] **Step 5: Run the website's checks**

Run: `cd website && npx vitest run src/app/desktop src/app/download src/lib && npx eslint src/app/desktop src/app/download src/lib && npx tsc --noEmit -p .`
Expected: PASS, 98 tests; eslint and tsc clean.

- [ ] **Step 6: Commit**

```bash
git add website/src/app/desktop/download/windows website/src/lib/installCommand.ts website/src/lib/desktopPlatform.ts website/src/lib/desktopPlatform.spec.ts \
  website/src/app/desktop/DesktopDownload.tsx website/src/app/desktop/DesktopDownload.spec.tsx website/src/app/desktop/page.tsx website/src/app/download/page.spec.tsx
git commit -m "feat(website): Download for Windows, through the manifest's harness-install.exe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The route answers 503 until a release carries `desktop-windows-installer`; the website therefore ships after the first desktop release with Windows (After F).

---

## Phase F4: End to end

### Task F4.1: What an install left, for the kit

**Files:**
- Create: `desktop/scripts/windows-e2e/install-state.ps1`
- Modify: `desktop/scripts/windows-e2e/desktop-e2e.sh` (`vm_tools`), `desktop/scripts/windows-e2e/README.md`

**Interfaces:**
- Consumes: C's kit (`$D ps <tool> [Name=Value…]` runs a tool from `vm_tools` as the test user), E's `VM_ADMIN`.
- Produces: `install-state.ps1 [-Lines 12] [-Downloaded <path under the profile>]`, read-only. Its lines: `install: … exists=`, `current:`, `previous:`, `versions:`, `shortcut:`, `harness:// key:`, `uninstall entry:`, `installed files marked as downloaded: <n>`, `downloaded installer: <ZoneId=3 | not marked | none>`, `temp folders left: <n>`, `running app:`, then the log's last lines.

- [ ] **Step 1: The tool**

`desktop/scripts/windows-e2e/install-state.ps1` (ASCII only):

```powershell
# install-state.ps1 [-Lines 12] [-Downloaded <path under the profile>]: the Harness desktop install as this user has
# it, read-only (installer plan F4.2). What harness-install.exe and Harness.exe --install leave: the version folders
# and pointers, the shortcut, the harness:// and uninstall keys, how many installed files carry a Zone.Identifier (none:
# the installer writes its downloads itself), the browser's mark on the downloaded installer, the installer's temp
# folders, the running app, and the installer log's last lines.
param([int]$Lines = 12, [string]$Downloaded = 'Downloads\harness-install.exe')
$ErrorActionPreference = 'Stop'
$install = Join-Path $env:LOCALAPPDATA 'Programs\Harness'
"install: $install exists=$(Test-Path -LiteralPath $install)"
foreach ($name in 'current', 'previous') {
  $pointer = Join-Path $install $name
  if (Test-Path -LiteralPath $pointer) { "${name}: $((Get-Content -LiteralPath $pointer -Raw).Trim())" }
}
$apps = Join-Path $install 'app'
if (Test-Path -LiteralPath $apps) { "versions: $(@(Get-ChildItem -LiteralPath $apps -Directory | ForEach-Object Name) -join ', ')" }
"shortcut: $(Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Harness.lnk'))"
"harness:// key: $(Test-Path -LiteralPath 'HKCU:\Software\Classes\harness\shell\open\command')"
$entry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness'
"uninstall entry: $(if (Test-Path -LiteralPath $entry) { (Get-ItemProperty -LiteralPath $entry).DisplayVersion } else { 'none' })"
$marked = @(if (Test-Path -LiteralPath $install) {
  Get-ChildItem -LiteralPath $install -Recurse -File | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }
})
"installed files marked as downloaded: $($marked.Count)"
$download = Join-Path $env:USERPROFILE $Downloaded
if (Test-Path -LiteralPath $download) {
  $zone = @(Get-Content -LiteralPath $download -Stream Zone.Identifier -ErrorAction SilentlyContinue) -match '^ZoneId='
  "downloaded installer: $(if ($zone) { $zone -join ' ' } else { 'not marked' })"
} else { 'downloaded installer: none' }
"temp folders left: $(@(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -Filter '.harness-desktop-staging-*' -ErrorAction SilentlyContinue).Count)"
$running = @(Get-CimInstance Win32_Process -Filter "Name='harness-desktop.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$install\", 'OrdinalIgnoreCase') })
"running app: $(if ($running) { @($running | ForEach-Object { $_.ExecutablePath.Substring($install.Length + 1) }) -join ', ' } else { 'none' })"
$log = Join-Path $env:TEMP 'harness-install.log'
if (Test-Path -LiteralPath $log) { '--- harness-install.log'; Get-Content -LiteralPath $log -Tail $Lines }
```

Append `install-state.ps1` to `vm_tools` in `desktop-e2e.sh`. In `README.md`, after the paragraph on `VM_ADMIN` (E1.3):

```markdown
`install-state.ps1` (sub-project F) says what an install left for the test user, read-only: the version folders,
the shortcut and keys, how many installed files carry a Zone.Identifier, the browser's mark on the downloaded
installer, the installer's temp folders and log.
```

- [ ] **Step 2: Check it, then commit**

Run: `LC_ALL=C grep -nP '[^\x00-\x7F]' desktop/scripts/windows-e2e/install-state.ps1` (expect no output), `shellcheck desktop/scripts/windows-e2e/desktop-e2e.sh` (nothing new), `python3 -I -m unittest discover -s desktop/scripts/windows-e2e -p 'test_*.py'` (passes). Windows PowerShell 5.1 parses and runs it (checked on the ARM64 VM when this plan was written; F4.3 runs it again).

```bash
git add desktop/scripts/windows-e2e/install-state.ps1 desktop/scripts/windows-e2e/desktop-e2e.sh desktop/scripts/windows-e2e/README.md
git commit -m "test(windows): the E2E kit says what a desktop install left, read-only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task F4.2: A release candidate and the publication check, before the merge

**Files:** none, unless a run fails; then the fix goes in the task that owns the file, with a test that fails without it, and the run is started once more.

**Interfaces:**
- Consumes: F2 pushed. `make release-desktop ARGS="--prepare"` (desktop/RELEASE.md). `release-desktop.yml`'s `test_publication` and `test_candidate_reuse` modes.

**Ask the owner first.** A candidate builds and signs the macOS app, uploads nine files to a random `harness/desktop-candidates/` prefix and verifies them; it publishes nothing a user or an app reads, and its packages expire after seven days. The publication check writes and removes tiny objects under `harness/desktop/.publication-check/<run>/`. Neither is a release; both write to the release bucket, so both need the owner's OK.

- [ ] **Step 1: The candidate**

From `feat/windows-desktop`, pushed and clean:

```bash
make release-desktop ARGS="--prepare"
```

It picks the next version and dispatches `release-desktop.yml` with `prepare_only`. Watch the run it prints (`gh run watch <run> --exit-status`). Pass:
- `build-windows (windows-latest, x64)`, `build-windows (windows-11-arm, arm64)` and `upload-windows` succeed, beside the macOS and Linux builds;
- `candidate` prints `All 9 candidate downloads passed; no product manifest was published`;
- the `desktop-release-candidate-<attempt>` artifact's receipt lists nine artifacts, `harness-install.exe` among them.

Record the run link, each job's duration and the size of the three Windows files in the F4.3 doc. Expect the Windows jobs to be the release's slowest (Flutter's Windows build and the Rust launcher); if they lengthen the release past its macOS build, record by how much.

- [ ] **Step 2: Promotion and publication, against disposable paths**

```bash
gh workflow run release-desktop.yml --ref feat/windows-desktop -f version=<the candidate's version> -f test_candidate_reuse=true
gh workflow run release-desktop.yml --ref feat/windows-desktop -f version=0.0.1 -f test_publication=true
```

Pass: the reuse run promotes all nine to `.candidate-check/…`, verifies them and removes them (`Reused all 9 verified packages…`); the publication run prints `PASS: macOS ZIP/DMG, Linux and Windows upload commands refuse immutable overwrites` with its other PASS lines. Leave the candidate in place: the release after the merge reuses it when the build inputs still match.

### Task F4.3: Seven scenarios on the x64 test PC, one on the ARM64 VM, and `docs/testing/windows-installer-e2e.md`

**Files:**
- Create: `docs/testing/windows-installer-e2e.md`, `desktop/scripts/windows-e2e/evidence/installer-*.log` and `.png` (every screenshot looked at, and masked where it shows an account or an address, before commit)
- Modify: only through a fix found during the run, as in F4.2.

**Interfaces:**
- Consumes: F1–F3 on this branch, pushed; F4.1's tool; E's kit (`VM_HOST`, `VM_ADMIN`, `put-admin`), E1.3 Step 3's key route; C's staging version N1 (C5.2) and its staging zips.
- E ships after the Windows PR, so its kit is not on this branch. Before F4.3, cherry-pick E1.3's kit commit, `7ee856dd9` on `feat/windows-dial`, "test(windows): add dial measurement tooling and configurable admin". It is test tooling only (`desktop-e2e.sh`, the kit README, `serial-check.ps1` and their Python tests). Keep F4.1's README paragraph after E's `VM_ADMIN` paragraph. Record it as a ruling.

**Who checks what**, as in C5.2 and E5.2: **Script** (`install-state.ps1`, logs, files), **Person** (the owner at the PC: Edge, SmartScreen, the installer's window, Settings). The executor asks, waits, and records what the person reports. Stamp each step's start and end (`$D stamp`); report implementation, validation, waiting and writing separately.

**Safety:** the PC's own account and files are not touched; everything is the throwaway user's, and is removed at the end. The only publish is Step 0's staging release, with the owner's OK.

- [ ] **Step 0: A staging release with the installer (owner's OK)**

Ask the owner. Then pick `VF`, the next unused staging version above every `desktop-windows-*` entry in `https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json` (a prerelease of the same line, as C used). While the branch has its temporary push trigger, publish through it, as C5.2 did:

```bash
git commit --allow-empty -m "ci(windows): desktop staging release $VF"
git push origin feat/windows-desktop
```

Watch the `Windows desktop` run (release mode). Pass: `Verify served staging artifacts` prints `staging desktop $VF: x64, arm64 and harness-install.exe verified`. Then:

```bash
export E2E_WORK=$(mktemp -d)/installer-f4; D=desktop/scripts/windows-e2e/desktop-e2e.sh; EV=desktop/scripts/windows-e2e/evidence
curl -fsSL https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/desktop/metadata.json > "$E2E_WORK/staging.json"
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); [print(k, m[k]["version"], m[k]["size"], m[k]["url"]) for k in ("desktop-windows-x64","desktop-windows-arm64","desktop-windows-installer")]' "$E2E_WORK/staging.json" | tee "$EV/installer-staging.log"
```

Pass: three lines at `$VF`; the installer's URL ends `/harness/staging/desktop/$VF/harness-install.exe`.

- [ ] **Step 1: The test user, at the PC's screen**

Ask the owner, then reach the PC by key exactly as E1.3 Step 3 does (`VM_HOST`, `VM_ADMIN` and the password typed, never written; record `file existed before`). Then:

```bash
export E2E_USER=hxinst
$D stamp "F4.3 start" | tee "$E2E_WORK/times.log"
$D preflight | tee "$EV/installer-preflight.log"
$D user-add | tee "$EV/installer-users.log"
```

**Person:** the owner signs in as `hxinst` at the PC with **Switch user** (the password is the last line of `$E2E_WORK/users.txt`; give it in person). Then `$D session-on | tee "$EV/installer-session.log"` and `$D ps install-state.ps1 | tee "$EV/installer-before.log"`.

Pass: `hxinst` is in `Users`, not `Administrators`; `installer-before.log` says `exists=False`, `downloaded installer: none`.

- [ ] **Step 2: Scenario 1, a browser download**

**Person:** in `hxinst`'s session, open Edge at the staging installer's URL (Step 0), keep the download if Edge asks, and open it. Say what Edge said, and photograph SmartScreen's dialog; choose **More info**, then **Run anyway**. Say whether a UAC prompt appeared, and photograph the **Install Harness** window while it downloads. While it runs: `$D shot installer-s1-window`. When the app opens: `$D shot installer-s1-app` and `$D ps install-state.ps1 | tee "$EV/installer-s1.log"`.

Pass:
- SmartScreen asked once; no UAC prompt; the window showed its steps and the bar moved; the app opened;
- `installer-s1.log`: `current: $VF`, `shortcut: True`, `harness:// key: True`, `uninstall entry: $VF`, `installed files marked as downloaded: 0`, `downloaded installer: ZoneId=3` (Edge marked it, so this was SmartScreen's real path), `temp folders left: 0`, `running app: app\$VF\harness-desktop.exe`, and the log's last line `Harness $VF is installed, and it is opening now.`

- [ ] **Step 3: Scenario 2, the same installer again**

**Person:** open `Downloads\harness-install.exe` again; say whether SmartScreen asked again. Then `$D ps install-state.ps1 | tee "$EV/installer-s2.log"` and `$D logs` (the launcher's `launch.log`).

Pass: the app is in front; `current` and `versions` unchanged; `launch.log` has no second `installed $VF` line; the installer's log ends with the same success line. Record SmartScreen's answer either way: Windows may remember the first "Run anyway".

- [ ] **Step 4: Scenario 3, Cancel**

The zip is fast on this network, so the cancel uses a slower file: a local manifest whose `desktop-windows-x64` entry names production's macOS `.dmg` (allowed: it is under `harness/desktop/`; never installed: it has no `Harness.exe`). On the Mac:

```bash
curl -fsSL https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json | python3 -c '
import json, sys
dmg = json.load(sys.stdin)["desktop-macos-dmg"]
entry = {k: dmg[k] for k in ("version", "url", "sha256", "size")}
json.dump({"desktop-windows-x64": entry, "desktop-windows-arm64": entry}, open(sys.argv[1], "w"))' "$E2E_WORK/slow.json"
$D put "$E2E_WORK/slow.json"
```

Start the installer in the session with that manifest (PowerShell only starts it; the installer is the one under test):

```bash
PS="\$env:HARNESS_INSTALL_MANIFEST = \"\$env:USERPROFILE\\Downloads\\slow.json\"; Start-Process \"\$env:USERPROFILE\\Downloads\\harness-install.exe\""
B64=$(printf '%s' "$PS" | iconv -t UTF-16LE | base64 | tr -d '\n')
$D run start-app.ps1 'Path=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe' "ArgumentList=[\"-NoProfile\",\"-WindowStyle\",\"Hidden\",\"-EncodedCommand\",\"$B64\"]" NoWait=true
```

**Person:** when the bar has moved, press **Cancel**. Then `$D ps install-state.ps1 | tee "$EV/installer-s3.log"`.

Pass: the window closed at once; `current: $VF` unchanged; `temp folders left: 0`; the log ends `The install was cancelled. Nothing was installed.`

- [ ] **Step 5: Scenario 4, a download whose hash differs**

`$E2E_WORK/badhash.json`: the staging x64 entry from Step 0 with its `sha256` replaced by 64 `f`s, for both keys; `$D put` it. Start the installer with it as in Step 4 (`badhash.json` in place of `slow.json`). **Person:** say what the window shows; `$D shot installer-s4-failure`; press **Try again**, say what it shows, then **Close**. Then `$D ps install-state.ps1 | tee "$EV/installer-s4.log"`.

Pass: the window says `Harness could not be installed.` and, below, `The step that failed: Downloading Harness.` and `… failed its checksum (expected ffff…, got …): it is not the published file.`; Try again repeats it; after Close, `current: $VF` unchanged and `temp folders left: 0`.

- [ ] **Step 6: Scenario 6, uninstall**

**Person:** Settings ▸ Apps ▸ Installed apps ▸ Harness ▸ Uninstall. Then `$D ps install-state.ps1 | tee "$EV/installer-s6.log"`.

Pass: `exists=False`, `shortcut: False`, `harness:// key: False`, `uninstall entry: none`, `running app: none`. (The installer adds nothing C's uninstall does not remove.)

- [ ] **Step 7: Scenario 5, an upgrade over a running older app**

Install C's N1 first, with the installer itself: `$E2E_WORK/n1.json` holds the staging N1 zip's entry (its `url` `https://cdn.autonomous.ai/harness/staging/desktop/<N1>/harness-desktop-<N1>-windows-x64.zip`, with the `size` and `sha256` of that file, downloaded once on the Mac to measure them) under both keys; `$D put` it; start the installer with it as in Step 4. **Person:** say when N1's app is open. `$D ps install-state.ps1 | tee "$EV/installer-s5-before.log"`.

**Person:** with N1 running, open `Downloads\harness-install.exe` (`$VF`). Then `$D ps install-state.ps1 | tee "$EV/installer-s5-after.log"`.

Pass: before, `current: <N1>` and `running app: app\<N1>\…`; after, `current: $VF`, `previous: <N1>`, `running app: app\$VF\harness-desktop.exe` only: the old app quit, the new one opened.

- [ ] **Step 8: Scenario 7, Defender**

```bash
$D sh-admin '"%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File C:\Users\hxinst\Downloads\harness-install.exe -DisableRemediation' | tee "$EV/installer-s7.log"
```

Record the result. If it reports a threat, follow desktop/RELEASE.md's Windows section (submit the file); do not change the build to dodge it, and tell the owner.

- [ ] **Step 9: The ARM64 VM**

On the Windows 11 ARM64 VM (`VM_HOST` unset: the kit's default; `VM_ADMIN` unset), as a new throwaway user; never `C:\work\e2e`, never the admin profile:

```bash
export E2E_USER=hxinstarm
$D user-add | tee "$EV/installer-arm-users.log"
curl -fsSL -o "$E2E_WORK/harness-install.exe" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["desktop-windows-installer"]["url"])' "$E2E_WORK/staging.json")"
$D put "$E2E_WORK/harness-install.exe"
$D sh 'Downloads\harness-install.exe --quiet & echo exit %errorlevel%' | tee "$EV/installer-arm.log"
$D ps install-state.ps1 | tee -a "$EV/installer-arm.log"
PS='$p = Join-Path $env:LOCALAPPDATA ("Programs\Harness\app\" + (Get-Content -Raw (Join-Path $env:LOCALAPPDATA "Programs\Harness\current")).Trim() + "\harness-desktop.exe"); $b = [IO.File]::ReadAllBytes($p); $pe = [BitConverter]::ToInt32($b, 60); "machine: 0x{0:X4}" -f [BitConverter]::ToUInt16($b, $pe + 4)'
$D sh "powershell -NoProfile -EncodedCommand $(printf '%s' "$PS" | iconv -t UTF-16LE | base64 | tr -d '\n')" | tee -a "$EV/installer-arm.log"
$D cleanup hxinstarm | tee "$EV/installer-arm-cleanup.log"
```

Pass: `exit 0`; `current: $VF`; `machine: 0xAA64` (the arm64 app, though the installer is x64 and ran emulated).

- [ ] **Step 10: Clean up, and the doc**

```bash
$D cleanup hxinst | tee "$EV/installer-cleanup.log"
```

Remove the key line from the test PC exactly as E5.2 Step 14 does (or the file, if Step 1 recorded `file existed before: False`); then `ssh -o BatchMode=yes "$VM_ADMIN@$VM_HOST" whoami` must fail.

Write `docs/testing/windows-installer-e2e.md`: a summary table (one row per scenario: pass, or what failed and the fix's commit), the setup, each scenario's steps and evidence, the timings, SmartScreen's and Edge's exact words, the Defender result, findings and known limits, the safety rules and the clean-up. No address, account or password.

```bash
git add docs/testing/windows-installer-e2e.md desktop/scripts/windows-e2e/evidence/installer-*
git commit -m "test(windows): harness-install.exe, seven scenarios on the x64 test PC and the arm64 app on the ARM64 VM" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task F4.4: The spec's status and the handoff's production order

**Files:**
- Modify: `docs/superpowers/specs/2026-10-19-windows-installer-design.md`, `desktop/RELEASE.md`

- [ ] **Step 1: Write it**

- Spec: `Status: implemented on feat/windows-desktop; E2E in docs/testing/windows-installer-e2e.md`. Under Known limits, one line for each limit F4 found and did not fix (for instance SmartScreen asking again in scenario 2, or a Defender detection).
- Handoff, "After the merge, production": the Desktop side becomes the order in **After F** below, and the line "the Windows desktop artifacts go to production in sub-project D (signing). Until D lands, ask the owner whether the unsigned build ships to production or waits for D" is replaced by "The owner decided (2026-10-19) that the unsigned Windows build ships: sub-project F."

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-19-windows-installer-design.md desktop/RELEASE.md
git commit -m "docs(windows): harness-install.exe and Windows in the desktop release are implemented; the production order" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## After F

F is the last sub-project before the Windows PR. The handoff's "Shipping Windows" applies, with F included:
- remove the TEMPORARY `push:` triggers (B's `windows.yml`, C's `windows-desktop.yml`) and C's commit-subject release mode, before the PR is marked ready;
- the final whole-branch review weighs F's seams: `harness-install.exe` ↔ `Harness.exe --install` and `install.ps1 -App` (one set of vectors, one spec), the release's nine artifacts across the publisher, the verifier and the candidate, and the website's route ↔ the manifest key;
- after the merge, each step at the owner's go:
  1. the CLI side's production steps, as the handoff lists them (the Windows CLI must be in production before an app installs it);
  2. `make release-desktop` (it may reuse F4.2's candidate): the first release with Windows. Check its receipt lists nine downloads;
  3. `bash cli/scripts/upload-install-ps1.sh --app --production`, so the website's PowerShell line works;
  4. the website release;
  5. `curl -sI https://harness.autonomous.ai/desktop/download/windows` answers 302 with `Location: https://cdn.autonomous.ai/harness/desktop/<version>/harness-install.exe`.
