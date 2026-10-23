# Windows Native: the Harness Dial (sub-project E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Windows 10/11 PC with the Harness CLI installed, a Harness dial plugged in by USB works as it does on a Mac: the daemon finds it and talks the cable protocol to it, the desktop's Devices tab shows and changes it, its firmware updates over the cable, and `harness flash` (and Flash firmware in the app) re-flashes it.

**Architecture:**
- A small Windows-only Rust program, `harness-serial.exe` (its own crate, `serial/`), finds the dial (SetupAPI/CfgMgr32) and moves its bytes (an overlapped COM handle) over stdin/stdout.
- The CLI's `cli/src/cable/serial.ts` gains a `win32` branch that runs it; everything above the byte stream (fleet, session, firmware push, services) is unchanged.
- `harness flash` on Windows runs `flash-circle.ps1`, a PowerShell twin of the bash flasher with the same steps, flags, numbers and output lines, so the desktop's flasher reads it unchanged.

**Tech Stack:**
- Rust 2024, `windows-sys` 0.59, `serde`/`serde_json` (no serial crate).
- TypeScript (Node 22) in `cli/`, vitest.
- Windows PowerShell 5.1 for the flasher; Next.js route in `website/`.
- Flutter/Dart in `desktop/` (one small change).
- GitHub Actions `windows.yml` on `windows-latest` and `windows-11-arm`.

**Spec:** `docs/superpowers/specs/2026-10-19-windows-dial-design.md`. It builds on sub-project B (`docs/superpowers/specs/2026-10-16-windows-native-cli-design.md`) and C (`docs/superpowers/specs/2026-10-18-windows-desktop-design.md`), whose code is on this branch.

**Where and when.** E continues on `feat/windows-dial`, cut from `feat/windows-desktop` at `8fb220f15` (C through C5.3 landed; C5.2's last live checks still run there). Per the owner's 2026-10-20 update, E ships in the combined Windows PR, `feat/windows-desktop` → `main`. When E5.2, E5.3 and the final review are done, report back; the owner's session will merge `feat/windows-dial` into `feat/windows-desktop`. Do not perform that merge yourself. F cherry-picks only E1.3's immutable, test-tooling-only kit commit `7ee856dd9`; no rebase onto E is assumed. Commits and pushes of `feat/windows-dial` are authorized; never `feat/windows-desktop` or `main`, never force-push.

## Global Constraints

**Platform and permissions**
- Windows 10/11, x64 and arm64. No administrator rights, no driver install, no UAC prompt. The in-box `usbser.sys` serves the dial.
- macOS and Linux behaviour is unchanged. No change to the `darwin` and `linux` branches of `serial.ts`, to `flash-circle.sh`, or to the desktop on macOS/Linux.

**The dial**
- USB id: VID `303A`, PID `1001`; the serial interface is `MI_00`. Match by id and nothing else: never by friendly name, never "the only COM port".
- On Windows the dial's port is `COM<n>`, opened as `\\.\COM<n>`.

**`harness-serial.exe` (spec §1)**
- Crate `serial/`, bin `harness-serial`. Not part of `pty/`.
- Commands: `watch`, `open COMn`, `probe COMn`, `version`. Usage error: exit 2.
- `watch` line: `{"console":<bool>,"ports":[{"path":"COMn","serialNumber":"…","session":"…"}]}`, ports in COM-number order; `serialNumber` and `session` omitted when unknown.
- Exit codes: `watch` 0 at end of stdin, 2 when enumeration fails (`error: <reason>`). `open`/`probe`: 3 `busy`, 4 `gone`, 5 `closed: <reason>` / `error: <reason>`, 0 at end of stdin (`open`) or when free (`probe`).
- `open` writes `open` to stderr once the port is open and configured; stdout carries only the dial's bytes.
- DCB: 115200 8N1, `fBinary`, no flow control, `DTR_CONTROL_ENABLE` and `RTS_CONTROL_ENABLE` set in ONE `SetCommState`, never changed afterwards. Read timeouts `MAXDWORD`/`MAXDWORD`/1000 ms.
- `watch` and `open` exit at end of stdin. That is how they end with the daemon, however it ends.
- The stdio contract only grows: an older `harness-serial.exe` stays in use until `install.ps1` runs again (spec, Known limits).

**The CLI (spec §2)**
- `serial.ts` keeps its exports and their signatures. The Windows code lives in `cli/src/cable/windowsSerial.ts`.
- Binary lookup: `HARNESS_SERIAL_BIN`; `<runtime>/pty/<current-pty>/harness-serial.exe`; `pty/harness-serial.exe` beside the bundle.
- No native Node module. No shell: every spawn passes an argument array, with `windowsHide: true`.

**The flasher (spec §3)**
- `flash-circle.ps1` source is ASCII only. First line exactly `# flash-circle.ps1`.
- Its numbers equal the bash flasher's: `CHIP`, `APP_OFFSET`, `OTADATA_OFFSET`, `OTADATA_SIZE`, `NVS_OFFSET`, `NVS_SIZE`, `FLASH_MODE`, `FLASH_FREQ`, `FLASH_SIZE`, `ESPTOOL_VERSION`, `OTA_KEY`, `METADATA_PATH`, `FIRMWARE_PATH_PREFIX`, `GCS_BUCKET`, `FLASHER_VERSION`, and the esptool `--before`/`--after`/`-b` values. A test fails on any difference.
- esptool for Windows: `esptool-v5.3.1-windows-amd64.zip`, sha256 `2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3`.
- The lines the desktop reads are byte-identical to bash's: `>> board: <port>`, `more than one ESP32-S3 is connected:`, `no permission`, `error: <text>`.
- Cancel on Windows: the file `<flasher cache>\cancel`; the script exits 130 after its `finally`.

**Testing and safety**
- Never test against the developer's own machine: the real `~/.harness`, the daemon on 18473, engine homes, tmux. Never `harness service install` or launchd on the Mac.
- The x64 test PC (a real Dell with the dial on COM3): its address, account and password are the owner's and are **never written into the repo**; take them from the owner. Touch nothing E did not install; remove what E installs at the end of each run.
- No production publish. Staging publishes need the owner's OK. Nothing in E publishes by itself.
- The repo is public: no full serial numbers, ids, addresses or passwords in committed evidence. Shorten serials to `28:84:85:…`.
- Docs, comments and commit messages in English. Comments say why, naming the measurement or incident.
- Never bare `git stash`; never `git clean -fdx`.
- One task is one commit, or a few, conventional (`feat(windows): …`, `test(windows): …`), each ending with the `Co-Authored-By` line the branch uses.

## Review Focus

The inputs and conditions the spec implies but its own test list does not pin, most likely first. Each names the task whose test pins it.

1. **A profile path with spaces, an apostrophe, `&`, `%` and non-ASCII letters** (`C:\Users\Nguyễn Văn A' & 100%\…`). `harness-serial.exe` under it must start, and the flasher's cache under it must work. Pinned by E2.1 (the binary copied under such a folder and spawned) and E4.1 (Windows CI runs `flash-circle.ps1 --no-flash` with its cache in such a folder).
2. **COM10 and above** need the `\\.\` prefix to open; `COM9` must sort before `COM10`. Pinned by E1.1 (`device_path`, `State::line` ordering).
3. **The daemon killed hard** (TerminateProcess, a crash) while the dial is open. Its `harness-serial` children must end and free the port for the next daemon. Pinned by E1.2 (a `watch` whose stdin closes ends within 5 s, on Windows CI) and E2.1 (a killed Node parent's child ends).
4. **A `watch` line split across two reads, or a stray non-JSON line.** The CLI must buffer to the newline and ignore what is not a state. Pinned by E2.1.
5. **Two dials at once.** `watch` lists both; each gets its own `open` child and its own session. Pinned by E1.1 (two ports in one line) and E2.1 (both parsed), and E5.2 scenario 1 when a second dial is available (recorded as not run otherwise).

## File map

| File | Task | Responsibility |
|---|---|---|
| `serial/Cargo.toml`, `serial/Cargo.lock` | E1.1 | The crate: bin `harness-serial`, `serde`, `serde_json`, `windows-sys` on Windows |
| `serial/src/main.rs` | E1.1 | Arguments, `version`, dispatch; "Windows only" elsewhere |
| `serial/src/model.rs` | E1.1 | Pure, every OS: argument parsing, the dial's ids, the state line, exit codes, the DCB bits |
| `serial/tests/cli.rs` | E1.1 | The binary's usage and `version`, every OS |
| `serial/src/windows.rs` | E1.2 | SetupAPI/CfgMgr32 enumeration, `watch`, `open`, `probe` |
| `serial/tests/windows.rs` | E1.2 | The binary on real Windows with no dial |
| `.github/workflows/windows.yml` | E1.2, E2.2, E3.1, E4.1 | Build and test `serial/`; the payload's sixth file; the Windows specs; the flasher without a board |
| `desktop/scripts/windows-e2e/desktop-e2e.sh`, `README.md` | E1.3 | `VM_ADMIN`, `put-admin`, the dial tools in `vm_tools` |
| `desktop/scripts/windows-e2e/serial-check.ps1` | E1.3 | `watch` → `open` for N s → `watch`: does opening reset the dial |
| `desktop/scripts/windows-e2e/dial-state.ps1`, `hold-port.ps1` | E5.1 | The dial as the daemon sees it; a port held by another program |
| `cli/src/cable/windowsSerial.ts` | E2.1 | Binary lookup, the `watch` child, the `open` child as a stream, `probe` |
| `cli/src/cable/__fixtures__/fakeHarnessSerial.mjs` | E2.1 | A stand-in speaking §1's stdio contract |
| `cli/src/cable/windowsSerial.spec.ts` | E2.1 | The above against the stand-in, every OS |
| `cli/src/cable/serial.ts`, `usbConsoleUser.ts`, `cableFleet.ts` | E2.2 | The `win32` branches; the fleet's console log line |
| `cli/src/cable/serial.windows.spec.ts` | E2.2 | `SerialLink` and `findDialPorts` over the stand-in; the real binary on Windows CI |
| `cli/scripts/install.ps1`, `cli/scripts/windows-install-manifest.mjs`, `cli/scripts/publish-pty-payload.sh`, `cli/scripts/lib/ptyPayload.mjs`, `cli/scripts/windows-ci/check-install.ps1` | E3.1 | Six payload files |
| `cli/src/scripts/installPs1.spec.ts`, `windowsInstallManifest.spec.ts`, `publishPtyPayload.spec.ts`, `windowsWorkflows.spec.ts`, `cli/src/ptyPayload.spec.ts` | E3.1 | Their pinned lists |
| `website/src/app/flash-circle.ps1/flash-circle.ps1`, `route.ts`, `website/next.config.js` | E4.1 | The Windows flasher and its route |
| `website/src/app/flash-circle.ps1/flash-circle-ps1.spec.ts` | E4.1 | Same numbers as bash, ASCII only, the output lines |
| `devices/harness-device/firmware/scripts/upload-flasher.sh`, `devices/harness-device/firmware/RELEASE.md` | E4.1 | The Windows esptool zip in the mirror and the pin block |
| `cli/src/lib/flash.ts`, `flash.spec.ts` | E4.2 | `harness flash` runs the `.ps1` with PowerShell on Windows |
| `desktop/lib/flash/flasher.dart`, `desktop/lib/core/serial_port_lease.dart`, `desktop/test/flasher_test.dart` | E4.3 | Cancel on Windows by file |
| `docs/testing/windows-dial-e2e.md`, `desktop/scripts/windows-e2e/evidence/dial-*` | E5.2 | The run on the test PC |
| `docs/superpowers/specs/2026-10-19-windows-dial-design.md`, `cli/AGENTS.md` | E5.3 | Status, findings, the devices row on Windows |

## Phases

| Phase | Tasks | Delivers |
|---|---|---|
| E1 `harness-serial` | E1.1–E1.3 | The binary, tested on Windows CI, and measured on the test PC's dial before anything is built on it |
| E2 The CLI | E2.1–E2.2 | The daemon finds, opens and releases the dial on Windows |
| E3 Packaging | E3.1 | `install.ps1` lays `harness-serial.exe` down with the host |
| E4 Re-flash | E4.1–E4.3 | `flash-circle.ps1`, `harness flash` on Windows, cancel from the app |
| E5 End to end | E5.1–E5.3 | Eleven scenarios on the test PC, the evidence doc, the spec's status |

---

## Phase E1: `harness-serial`

### Task E1.1: The crate and its pure model

**Files:**
- Create: `serial/Cargo.toml`, `serial/Cargo.lock` (generated), `serial/src/main.rs`, `serial/src/model.rs`, `serial/tests/cli.rs`
- Modify: `.gitignore` (only if `serial/target/` is not already ignored by a `target/` rule; check with `git check-ignore serial/target/x`)

**Interfaces:**
- Produces (used by E1.2):
  - `model::Command { Watch, Open(String), Probe(String), Version }`, `model::parse(&[String]) -> Result<Command, String>`;
  - `model::is_com_name(&str) -> bool`, `model::device_path(&str) -> String` (`\\.\COMn`);
  - `model::is_dial_interface(&str) -> bool`, `model::serial_from_parent(&str) -> Option<String>`;
  - `model::Port { path, serial_number: Option<String>, session: Option<String> }`, `model::State { console, ports }`, `State::line(&self) -> String`;
  - `model::OpenFailure { Busy, Gone, Other }`, `model::open_failure(u32) -> OpenFailure`;
  - `model::{EXIT_FAILED = 2, EXIT_BUSY = 3, EXIT_GONE = 4, EXIT_CLOSED = 5}`, `model::DCB_RAW: u32`;
  - `model::version_line() -> String`.

- [ ] **Step 1: The crate manifest**

`serial/Cargo.toml`:

```toml
[package]
name = "harness-serial"
version = "0.1.0"
edition = "2024"

# The Harness dial's serial port on Windows, for the CLI's cable/serial.ts
# (docs/superpowers/specs/2026-10-19-windows-dial-design.md §1). Its own crate, not a bin of pty/: that is the
# terminal host, and one program doing two jobs is harder to read and to debug (owner, 2026-10-19).
[[bin]]
name = "harness-serial"
path = "src/main.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Devices_Communication", "Win32_Devices_DeviceAndDriverInstallation", "Win32_Devices_Properties", "Win32_Security", "Win32_Storage_FileSystem", "Win32_System_IO", "Win32_System_Ioctl", "Win32_System_Registry", "Win32_System_RemoteDesktop", "Win32_System_Threading"] }
```

- [ ] **Step 2: Write the failing tests of the model**

`serial/src/model.rs`, the test module first (the functions above it come in Step 4):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_the_four_commands_and_nothing_else() {
        assert_eq!(parse(&args(&["watch"])), Ok(Command::Watch));
        assert_eq!(parse(&args(&["version"])), Ok(Command::Version));
        assert_eq!(parse(&args(&["open", "com3"])), Ok(Command::Open("COM3".into())));
        assert_eq!(parse(&args(&["probe", "COM12"])), Ok(Command::Probe("COM12".into())));
        for bad in [&[][..], &["open"][..], &["open", "COM3", "x"][..], &["open", r"\\.\COM3"][..], &["open", "NUL"][..], &["serve"][..]] {
            assert_eq!(parse(&args(bad)), Err(USAGE.to_string()), "{bad:?}");
        }
    }

    #[test]
    fn a_com_name_is_com_and_one_to_three_digits_without_a_leading_zero() {
        for good in ["COM1", "com9", "COM10", "COM256"] {
            assert!(is_com_name(good), "{good}");
        }
        for bad in ["COM", "COM0", "COM01", "COM1000", "COM1a", "LPT1", "COM3:", "C:\\COM3", ""] {
            assert!(!is_com_name(bad), "{bad}");
        }
    }

    // Review Focus 2: COM10 and above open only through the device namespace; COM1-COM9 work either way.
    #[test]
    fn every_port_is_opened_through_the_device_namespace() {
        assert_eq!(device_path("COM3"), r"\\.\COM3");
        assert_eq!(device_path("COM10"), r"\\.\COM10");
    }

    // The ids as the test PC reported them (2026-10-19, Get-PnpDevice), with the serial shortened.
    #[test]
    fn the_dial_is_its_serial_interface_and_the_parent_carries_its_serial() {
        assert!(is_dial_interface(r"USB\VID_303A&PID_1001&MI_00\6&106766F5&0&0000"));
        assert!(is_dial_interface(r"usb\vid_303a&pid_1001&mi_00\6&1&0&0000"));
        assert!(!is_dial_interface(r"USB\VID_303A&PID_1001&MI_02\6&106766F5&0&0002")); // the JTAG interface
        assert!(!is_dial_interface(r"USB\VID_303A&PID_1001\28:84:85:00:00:01")); // the composite device
        assert!(!is_dial_interface(r"USB\VID_10C4&PID_EA60\0001")); // another USB-serial chip
        assert_eq!(serial_from_parent(r"USB\VID_303A&PID_1001\28:84:85:00:00:01"), Some("28:84:85:00:00:01".into()));
        // Windows makes up an id with `&` for a device that reports no serial number.
        assert_eq!(serial_from_parent(r"USB\VID_303A&PID_1001\6&2F1A9C&0&1"), None);
        assert_eq!(serial_from_parent(r"USB\VID_303A&PID_1001\"), None);
        assert_eq!(serial_from_parent(r"USB\ROOT_HUB30\4&1&0&0"), None);
    }

    // Review Focus 5 and 2: two dials in one line, COM9 before COM10, unknown fields left out.
    #[test]
    fn the_state_line_lists_ports_in_com_number_order_and_omits_what_is_unknown() {
        let state = State {
            console: true,
            ports: vec![
                Port { path: "COM10".into(), serial_number: Some("28:84:85:00:00:02".into()), session: Some("2".into()) },
                Port { path: "COM9".into(), serial_number: None, session: None },
            ],
        };
        assert_eq!(
            state.line(),
            r#"{"console":true,"ports":[{"path":"COM9"},{"path":"COM10","serialNumber":"28:84:85:00:00:02","session":"2"}]}"#
        );
        assert_eq!(State { console: false, ports: vec![] }.line(), r#"{"console":false,"ports":[]}"#);
    }

    #[test]
    fn open_failures_are_busy_gone_or_other() {
        assert_eq!(open_failure(5), OpenFailure::Busy); // ERROR_ACCESS_DENIED: another program has it
        assert_eq!(open_failure(32), OpenFailure::Busy); // ERROR_SHARING_VIOLATION
        assert_eq!(open_failure(2), OpenFailure::Gone); // ERROR_FILE_NOT_FOUND
        assert_eq!(open_failure(3), OpenFailure::Gone); // ERROR_PATH_NOT_FOUND
        assert_eq!(open_failure(1167), OpenFailure::Gone); // ERROR_DEVICE_NOT_CONNECTED
        assert_eq!(open_failure(31), OpenFailure::Other); // ERROR_GEN_FAILURE
    }

    #[test]
    fn the_dcb_is_binary_with_dtr_and_rts_enabled_and_no_flow_control() {
        // fBinary (bit 0), fDtrControl = DTR_CONTROL_ENABLE (bits 4-5 = 1), fRtsControl = RTS_CONTROL_ENABLE
        // (bits 12-13 = 1). Every other bit is 0: no parity check, no CTS/DSR/XON flow control, no abort on error.
        assert_eq!(DCB_RAW, 0x1011);
    }

    #[test]
    fn version_names_the_protocol() {
        assert_eq!(version_line(), format!(r#"{{"version":"{VERSION}","protocol":1}}"#));
    }
}
```

`serial/tests/cli.rs`:

```rust
//! The binary's own surface, on every OS: usage and version need no Windows.
use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_harness-serial")).args(args).output().expect("harness-serial runs")
}

#[test]
fn a_bad_command_line_is_a_usage_error() {
    for args in [&["open"][..], &["open", "NUL"][..], &[][..]] {
        let out = run(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: harness-serial"), "{args:?}");
    }
}

#[test]
fn version_prints_one_json_line() {
    let out = run(&["version"]);
    assert_eq!(out.status.code(), Some(0));
    let line = String::from_utf8(out.stdout).unwrap();
    assert!(line.starts_with(r#"{"version":""#) && line.trim_end().ends_with(r#","protocol":1}"#), "{line}");
}
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd serial && cargo test`
Expected: FAIL to compile (`parse`, `is_com_name`, … not found; `src/main.rs` missing).

- [ ] **Step 4: The model and `main.rs`**

The top of `serial/src/model.rs`, above the test module:

```rust
//! What harness-serial decides without Windows: its command line, which device is the dial, the line `watch`
//! prints, and what an open failure means. Pure, so `cargo test` checks it on any machine.
// Off Windows only the tests and `version` use this module.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;

/// The stdio contract's version (spec §1). It only grows: an older binary stays in use until install.ps1 runs.
pub const PROTOCOL: u32 = 1;

/// The version the payload is released as. windows.yml's release mode stamps it (HARNESS_PTY_VERSION, the same
/// variable as the host's, pty/src/cli.rs), so the two ship under one number; otherwise the crate's own.
pub const VERSION: &str = release_version(option_env!("HARNESS_PTY_VERSION"));

const fn release_version(given: Option<&'static str>) -> &'static str {
    match given {
        Some(version) if !version.is_empty() => version,
        _ => env!("CARGO_PKG_VERSION"),
    }
}

pub fn version_line() -> String {
    format!(r#"{{"version":"{VERSION}","protocol":{PROTOCOL}}}"#)
}

pub const USAGE: &str = "usage: harness-serial watch | open COMn | probe COMn | version";

/// `watch` could not enumerate devices; also a usage error.
pub const EXIT_FAILED: i32 = 2;
/// Another program holds the port.
pub const EXIT_BUSY: i32 = 3;
/// The port is not there (unplugged between `watch` and `open`).
pub const EXIT_GONE: i32 = 4;
/// The port failed while open (an unplug), or failed to open for any other reason.
pub const EXIT_CLOSED: i32 = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Watch,
    Open(String),
    Probe(String),
    Version,
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["watch"] => Ok(Command::Watch),
        ["version"] => Ok(Command::Version),
        ["open", port] if is_com_name(port) => Ok(Command::Open(port.to_ascii_uppercase())),
        ["probe", port] if is_com_name(port) => Ok(Command::Probe(port.to_ascii_uppercase())),
        _ => Err(USAGE.to_string()),
    }
}

/// `COM1` to `COM999`, any case. Nothing else becomes a path: the CLI passes back what `watch` reported, and a
/// name like `NUL` or `C:\x` must never reach CreateFileW.
pub fn is_com_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    match upper.strip_prefix("COM") {
        Some(n) => (1..=3).contains(&n.len()) && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// `\\.\COMn`. COM1-COM9 also open by their bare name, COM10 and above only through the device namespace.
pub fn device_path(name: &str) -> String {
    format!(r"\\.\{name}")
}

const DIAL_INTERFACE: &str = r"USB\VID_303A&PID_1001&MI_00\";
const DIAL_DEVICE: &str = r"USB\VID_303A&PID_1001\";

/// The dial's CDC serial interface. The SoC's own USB peripheral (USB-Serial/JTAG) is the only USB function the
/// dial has: a composite device with this interface and a JTAG one (MI_02), measured on the test PC 2026-10-19.
pub fn is_dial_interface(instance_id: &str) -> bool {
    instance_id.to_ascii_uppercase().starts_with(DIAL_INTERFACE)
}

/// The serial number, from the parent composite device's instance id (`USB\VID_303A&PID_1001\<serial>`).
pub fn serial_from_parent(parent_id: &str) -> Option<String> {
    if !parent_id.to_ascii_uppercase().starts_with(DIAL_DEVICE) {
        return None;
    }
    let rest = &parent_id[DIAL_DEVICE.len()..];
    // Windows makes up an instance id with `&` in it for a device that reports no serial number.
    if rest.is_empty() || rest.contains('&') || rest.contains('\\') {
        return None;
    }
    Some(rest.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    /// The attachment: the composite device's LastArrivalDate (a FILETIME, in decimal). It changes on an unplug and
    /// replug and stays put across a reset or a reflash, as macOS's sessionID does (cable/serial.ts DialPort.session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct State {
    pub console: bool,
    pub ports: Vec<Port>,
}

impl State {
    /// One line for the CLI, the ports in COM-number order (COM9 before COM10), so a line differs only when the
    /// answer does.
    pub fn line(&self) -> String {
        let mut ports = self.ports.clone();
        ports.sort_by_key(|port| (com_number(&port.path), port.path.clone()));
        serde_json::to_string(&State { console: self.console, ports }).expect("a state serializes")
    }
}

fn com_number(path: &str) -> u32 {
    path.get(3..).and_then(|n| n.parse().ok()).unwrap_or(u32::MAX)
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenFailure {
    Busy,
    Gone,
    Other,
}

/// What CreateFileW's error says about a COM port. COM ports are exclusive: a port another program has open
/// answers ERROR_ACCESS_DENIED.
pub fn open_failure(code: u32) -> OpenFailure {
    match code {
        5 | 32 => OpenFailure::Busy,
        2 | 3 | 1167 => OpenFailure::Gone,
        _ => OpenFailure::Other,
    }
}

/// DCB's bit field for the dial: fBinary, DTR_CONTROL_ENABLE, RTS_CONTROL_ENABLE, nothing else.
///
/// On ESP32-S3 USB-Serial/JTAG, RTS asserted while DTR is not resets the chip. One SetCommState carries both lines
/// in one CDC SET_CONTROL_LINE_STATE request, so they go from whatever they were to both asserted at once, as a
/// macOS open leaves them, never through RTS-without-DTR. Measured on the test PC before anything was built on it
/// (plan E1.3, docs/testing/windows-dial-e2e.md).
pub const DCB_RAW: u32 = 1 | (1 << 4) | (1 << 12);
```

`serial/src/main.rs`:

```rust
//! harness-serial: the Harness dial's serial port on Windows, for the CLI's cable/serial.ts
//! (docs/superpowers/specs/2026-10-19-windows-dial-design.md §1). `watch` lists the dials, `open` moves one dial's
//! bytes between the port and stdin/stdout, `probe` says whether another program holds a port.

mod model;
#[cfg(windows)]
mod windows;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match model::parse(&args) {
        Ok(command) => command,
        Err(usage) => {
            eprintln!("{usage}");
            std::process::exit(model::EXIT_FAILED);
        }
    };
    if command == model::Command::Version {
        println!("{}", model::version_line());
        return;
    }
    #[cfg(windows)]
    std::process::exit(windows::run(command));
    #[cfg(not(windows))]
    {
        eprintln!("error: harness-serial runs on Windows only");
        std::process::exit(model::EXIT_FAILED);
    }
}
```

`serial/src/windows.rs` does not exist yet, and `main.rs` names it on Windows only, so this step builds on the Mac. On Windows CI it comes with E1.2; until E1.2 nothing builds `serial/` there.

- [ ] **Step 5: Generate the lock file and run the tests**

Run: `cd serial && cargo generate-lockfile && cargo test --locked`
Expected: PASS: `model::tests` (8 tests) and `tests/cli.rs` (2 tests).

The lock file is resolved for every target, `windows-sys` included, so `--locked` works on the Windows runners.

- [ ] **Step 6: Commit**

```bash
git check-ignore -q serial/target/x || echo 'serial/target/' >> .gitignore
git add serial/Cargo.toml serial/Cargo.lock serial/src/main.rs serial/src/model.rs serial/tests/cli.rs .gitignore
git commit -m "feat(windows): harness-serial crate: its command line, the dial's ids and the watch line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E1.2: `watch`, `open` and `probe` on Windows

**Files:**
- Create: `serial/src/windows.rs`, `serial/tests/windows.rs`
- Modify: `.github/workflows/windows.yml` (the TEMPORARY push trigger, and the `serial/` build and tests in the `windows-pty` job)

**Interfaces:**
- Consumes: E1.1's `model`.
- Produces: the binary `serial/target/<target>/release/harness-serial.exe`, which the `windows-pty` job puts in its payload artifact (`harness-pty-windows-<arch>`) beside the host. E1.3 downloads it from there; E3.1 makes it part of the install.

- [ ] **Step 1: Write the failing Windows tests**

`serial/tests/windows.rs`:

```rust
//! The binary on real Windows. The runners have no dial, so these pin what an empty machine and a missing port say;
//! the dial itself is plan E1.3 and E5 on the test PC.
#![cfg(windows)]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_harness-serial"))
}

#[test]
fn watch_reports_no_dial_and_ends_when_its_stdin_closes() {
    let mut child = bin().arg("watch").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    // A runner may have other COM ports; none is a dial.
    assert!(line.starts_with(r#"{"console":"#) && line.trim_end().ends_with(r#""ports":[]}"#), "{line}");
    // Review Focus 3: the parent going away closes the pipe, and that alone ends the watch.
    drop(child.stdin.take());
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(0));
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(5), "watch outlived its stdin");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_port_that_is_not_there_is_gone_for_open_and_probe() {
    for command in ["open", "probe"] {
        let out = bin().args([command, "COM250"]).stdin(Stdio::null()).output().unwrap();
        assert_eq!(out.status.code(), Some(4), "{command}");
        if command == "open" {
            assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "gone");
        }
    }
}
```

- [ ] **Step 2: See them fail on Windows CI**

The tests need Windows. Add the build to `windows.yml` first (Step 3), push, and see the `Serial: Rust tests` step fail to compile (`windows::run` not found).

- [ ] **Step 3: The workflow**

In `.github/workflows/windows.yml`:

1. The TEMPORARY push trigger also runs on this branch (removed with B's before the merge, handoff "Shipping Windows" step 2):

```yaml
  # TEMPORARY: remove before merging (workflow_dispatch needs the file on main)
  push:
    branches: [feat/windows-native-cli, feat/windows-desktop, feat/windows-dial]
```

2. In the `windows-pty` job, after the `Rust tests` step:

```yaml
      # harness-serial (serial/, sub-project E): the dial's serial port. Its own crate; tested on each architecture.
      - name: 'Serial: Rust tests'
        if: ${{ !inputs.release }}
        working-directory: serial
        run: cargo test --locked --target ${{ matrix.target }}
      - name: 'Serial: build release'
        working-directory: serial
        env:
          HARNESS_PTY_VERSION: ${{ inputs.version }}
        run: cargo build --locked --release --target ${{ matrix.target }}
```

3. In `Place the ConPTY payload beside the host`, after the two `Copy-Item` lines of the ConPTY files, so what is tested is what ships:

```powershell
          Copy-Item "serial/target/${{ matrix.target }}/release/harness-serial.exe" $release
```

4. In `Check the release payload`, after the `harness-pty.exe` version check:

```powershell
          $serial = & "$release/harness-serial.exe" version
          if ($serial -notmatch ('"version":"' + [regex]::Escape($env:VERSION) + '"')) { throw "harness-serial.exe says $serial, not $env:VERSION" }
```

5. In `Collect the payload`, add `"$release/harness-serial.exe"` to the `Copy-Item` list.

6. Update the header comment: the payload is six files, `harness-serial.exe` the sixth (`serial/`).

- [ ] **Step 4: `serial/src/windows.rs`**

```rust
//! The Windows half of harness-serial: SetupAPI and CfgMgr32 find the dial, an overlapped COM handle moves its
//! bytes. Every long-running command ends at end of stdin, which is how it ends with the daemon that started it,
//! however that daemon ends (a crash, TerminateProcess, an update handoff).

use std::ffi::c_void;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use windows_sys::Win32::Devices::Communication::{
    COMMTIMEOUTS, DCB, GetCommState, NOPARITY, ONESTOPBIT, SetCommState, SetCommTimeouts,
};
use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_PropertyW, CM_Get_Device_IDW, CM_Get_Parent, CM_NOTIFY_ACTION, CM_NOTIFY_EVENT_DATA,
    CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE, CM_Register_Notification, CM_Unregister_Notification,
    CR_SUCCESS, DICS_FLAG_GLOBAL, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, DIREG_DEV, HCMNOTIFICATION, HDEVINFO,
    SP_DEVINFO_DATA, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiOpenDevRegKey,
};
use windows_sys::Win32::Devices::Properties::{DEVPKEY_Device_LastArrivalDate, DEVPROP_TYPE_FILETIME, DEVPROPTYPE};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Ioctl::GUID_DEVINTERFACE_COMPORT;
use windows_sys::Win32::System::Registry::{KEY_READ, REG_SZ, RegCloseKey, RegQueryValueExW};
use windows_sys::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcessId};

use crate::model::{self, Command, OpenFailure, Port, State};

pub fn run(command: Command) -> i32 {
    match command {
        Command::Watch => watch(),
        Command::Open(name) => open(&name),
        Command::Probe(name) => probe(&name),
        Command::Version => 0,
    }
}

// ---- finding the dial ---------------------------------------------------------------------------------------

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn describe(code: u32) -> String {
    std::io::Error::from_raw_os_error(code as i32).to_string()
}

/// Every present COM port that is the dial's serial interface, with its serial number and attachment.
fn dial_ports() -> Result<Vec<Port>, String> {
    let set: HDEVINFO = unsafe {
        SetupDiGetClassDevsW(&GUID_DEVINTERFACE_COMPORT, std::ptr::null(), std::ptr::null_mut(), DIGCF_PRESENT | DIGCF_DEVICEINTERFACE)
    };
    if set == -1 {
        return Err(format!("SetupDiGetClassDevsW: {}", describe(unsafe { GetLastError() })));
    }
    let mut ports = Vec::new();
    let mut index = 0;
    loop {
        let mut info: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        if unsafe { SetupDiEnumDeviceInfo(set, index, &mut info) } == 0 {
            break;
        }
        index += 1;
        let mut id = [0u16; 512];
        if unsafe { SetupDiGetDeviceInstanceIdW(set, &info, id.as_mut_ptr(), id.len() as u32, std::ptr::null_mut()) } == 0 {
            continue;
        }
        if !model::is_dial_interface(&from_wide(&id)) {
            continue;
        }
        // An arrival can be reported before usbser writes PortName; `watch` looks again 500 ms later.
        let Some(path) = port_name(set, &info) else { continue };
        let mut parent = 0u32;
        let (serial_number, session) = if unsafe { CM_Get_Parent(&mut parent, info.DevInst, 0) } == CR_SUCCESS {
            (device_id(parent).and_then(|id| model::serial_from_parent(&id)), last_arrival(parent))
        } else {
            (None, None)
        };
        ports.push(Port { path, serial_number, session });
    }
    unsafe { SetupDiDestroyDeviceInfoList(set) };
    Ok(ports)
}

/// `Device Parameters\PortName`, as usbser wrote it: `COM3`.
fn port_name(set: HDEVINFO, info: &SP_DEVINFO_DATA) -> Option<String> {
    let key = unsafe { SetupDiOpenDevRegKey(set, info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ) };
    if key as isize == -1 || key.is_null() {
        return None;
    }
    let name = wide("PortName");
    let mut buffer = [0u16; 32];
    let mut size = (buffer.len() * 2) as u32;
    let mut kind = 0u32;
    let status = unsafe {
        RegQueryValueExW(key, name.as_ptr(), std::ptr::null(), &mut kind, buffer.as_mut_ptr() as *mut u8, &mut size)
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS || kind != REG_SZ {
        return None;
    }
    let port = from_wide(&buffer).to_ascii_uppercase();
    model::is_com_name(&port).then_some(port)
}

fn device_id(devinst: u32) -> Option<String> {
    let mut buffer = [0u16; 512];
    (unsafe { CM_Get_Device_IDW(devinst, buffer.as_mut_ptr(), buffer.len() as u32, 0) } == CR_SUCCESS).then(|| from_wide(&buffer))
}

/// The composite device's DEVPKEY_Device_LastArrivalDate: when it was last plugged in.
fn last_arrival(devinst: u32) -> Option<String> {
    let mut kind: DEVPROPTYPE = 0;
    let mut value = 0u64;
    let mut size = 8u32;
    let status = unsafe {
        CM_Get_DevNode_PropertyW(devinst, &DEVPKEY_Device_LastArrivalDate, &mut kind, &mut value as *mut u64 as *mut u8, &mut size, 0)
    };
    (status == CR_SUCCESS && kind == DEVPROP_TYPE_FILETIME && size == 8).then(|| value.to_string())
}

/// Whether this process's session is the one at the screen. A Remote Desktop session is not; a user switched
/// away from is not. That user's daemon releases the dial (cable/cableFleet.ts, canUseUsb).
fn at_console() -> bool {
    let mut mine = 0u32;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut mine) != 0 && WTSGetActiveConsoleSessionId() == mine }
}

// ---- watch --------------------------------------------------------------------------------------------------

/// The CLI scans every 2 s; reading the console that often costs one call into the kernel.
const CONSOLE_EVERY: Duration = Duration::from_secs(2);
/// An arrival can come before usbser writes PortName.
const LOOK_AGAIN_AFTER: Duration = Duration::from_millis(500);
/// A missed notification is caught within this, as macOS's DIAL_RESCAN_MS.
const SAFETY_NET: Duration = Duration::from_secs(300);

struct Notification(HCMNOTIFICATION);

impl Drop for Notification {
    fn drop(&mut self) {
        unsafe { CM_Unregister_Notification(self.0) };
    }
}

unsafe extern "system" fn on_change(
    _notification: HCMNOTIFICATION,
    context: *const c_void,
    _action: CM_NOTIFY_ACTION,
    _data: *const CM_NOTIFY_EVENT_DATA,
    _size: u32,
) -> u32 {
    // The context is the leaked Sender below; it lives for the whole process.
    let sender = unsafe { &*(context as *const mpsc::Sender<()>) };
    let _ = sender.send(());
    ERROR_SUCCESS
}

/// Arrivals and removals of any COM port interface. Called back on a system thread.
fn notify_changes(sender: mpsc::Sender<()>) -> Result<Notification, String> {
    let context: &'static mpsc::Sender<()> = Box::leak(Box::new(sender));
    let mut filter: CM_NOTIFY_FILTER = unsafe { std::mem::zeroed() };
    filter.cbSize = std::mem::size_of::<CM_NOTIFY_FILTER>() as u32;
    filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
    filter.u.DeviceInterface.ClassGuid = GUID_DEVINTERFACE_COMPORT;
    let mut handle: HCMNOTIFICATION = std::ptr::null_mut();
    let status = unsafe {
        CM_Register_Notification(&filter, context as *const mpsc::Sender<()> as *const c_void, Some(on_change), &mut handle)
    };
    if status != CR_SUCCESS {
        return Err(format!("CM_Register_Notification failed ({status})"));
    }
    Ok(Notification(handle))
}

/// End the process at end of stdin: the daemon closed the pipe, or the daemon is gone.
fn exit_at_end_of_stdin() {
    std::thread::spawn(|| {
        let mut sink = [0u8; 256];
        let mut stdin = std::io::stdin().lock();
        loop {
            match stdin.read(&mut sink) {
                Ok(0) | Err(_) => std::process::exit(0),
                Ok(_) => {}
            }
        }
    });
}

fn print_line(line: &str) -> bool {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|_| out.flush()).is_ok()
}

fn watch() -> i32 {
    exit_at_end_of_stdin();
    let (sender, changes) = mpsc::channel();
    let _notification = match notify_changes(sender) {
        Ok(notification) => notification,
        Err(why) => {
            eprintln!("error: {why}");
            return model::EXIT_FAILED;
        }
    };
    let mut ports = match dial_ports() {
        Ok(ports) => ports,
        Err(why) => {
            eprintln!("error: {why}");
            return model::EXIT_FAILED;
        }
    };
    let mut looked = Instant::now();
    let mut again: Option<Instant> = None;
    let mut printed: Option<String> = None;
    loop {
        let line = State { console: at_console(), ports: ports.clone() }.line();
        if printed.as_deref() != Some(line.as_str()) {
            if !print_line(&line) {
                return 0; // nobody is reading
            }
            printed = Some(line);
        }
        let wait = again.map_or(CONSOLE_EVERY, |at| at.saturating_duration_since(Instant::now()).min(CONSOLE_EVERY));
        let changed = match changes.recv_timeout(wait) {
            Ok(()) => {
                while changes.try_recv().is_ok() {}
                again = Some(Instant::now() + LOOK_AGAIN_AFTER);
                true
            }
            Err(mpsc::RecvTimeoutError::Timeout) => false,
            Err(mpsc::RecvTimeoutError::Disconnected) => return 0,
        };
        let due = again.is_some_and(|at| Instant::now() >= at);
        if due {
            again = None;
        }
        if changed || due || looked.elapsed() >= SAFETY_NET {
            match dial_ports() {
                Ok(next) => {
                    ports = next;
                    looked = Instant::now();
                }
                Err(why) => {
                    eprintln!("error: {why}");
                    return model::EXIT_FAILED;
                }
            }
        }
    }
}

// ---- open and probe -----------------------------------------------------------------------------------------

struct ComPort(HANDLE);

// The handle is used from the reader thread and the writer thread at once, which overlapped I/O allows.
unsafe impl Send for ComPort {}
unsafe impl Sync for ComPort {}

impl Drop for ComPort {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Share mode 0: a COM port is exclusive, and asking for that makes another program's open the error we see.
fn create(name: &str) -> Result<ComPort, u32> {
    let path = wide(&model::device_path(name));
    let handle = unsafe {
        CreateFileW(path.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut())
    };
    if handle == INVALID_HANDLE_VALUE { Err(unsafe { GetLastError() }) } else { Ok(ComPort(handle)) }
}

fn refuse(code: u32) -> i32 {
    match model::open_failure(code) {
        OpenFailure::Busy => {
            eprintln!("busy");
            model::EXIT_BUSY
        }
        OpenFailure::Gone => {
            eprintln!("gone");
            model::EXIT_GONE
        }
        OpenFailure::Other => {
            eprintln!("error: {}", describe(code));
            model::EXIT_CLOSED
        }
    }
}

/// Raw, and DTR/RTS asserted together in this one call (model::DCB_RAW says why). Reads return as soon as any
/// byte is there, or after 1 s with none, so the reader wakes once a second at most while the dial is quiet.
fn configure(port: &ComPort) -> Result<(), String> {
    let mut dcb: DCB = unsafe { std::mem::zeroed() };
    dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
    if unsafe { GetCommState(port.0, &mut dcb) } == 0 {
        return Err(format!("GetCommState: {}", describe(unsafe { GetLastError() })));
    }
    dcb.BaudRate = 115_200; // USB-Serial/JTAG ignores it; a driver that checks it gets a real one
    dcb._bitfield = model::DCB_RAW;
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    if unsafe { SetCommState(port.0, &dcb) } == 0 {
        return Err(format!("SetCommState: {}", describe(unsafe { GetLastError() })));
    }
    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: u32::MAX,
        ReadTotalTimeoutConstant: 1000,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 0,
    };
    if unsafe { SetCommTimeouts(port.0, &timeouts) } == 0 {
        return Err(format!("SetCommTimeouts: {}", describe(unsafe { GetLastError() })));
    }
    Ok(())
}

struct Event(HANDLE);

impl Event {
    fn new() -> Event {
        Event(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// One overlapped ReadFile or WriteFile, waited for. Ok(bytes) or Err(the Windows error).
fn overlapped(port: &ComPort, event: &Event, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> Result<u32, u32> {
    let mut request: OVERLAPPED = unsafe { std::mem::zeroed() };
    request.hEvent = event.0;
    if start(&mut request) == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_IO_PENDING {
            return Err(code);
        }
    }
    let mut done = 0u32;
    if unsafe { GetOverlappedResult(port.0, &request, &mut done, 1) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    Ok(done)
}

fn closed(code: u32) -> ! {
    eprintln!("closed: {}", describe(code));
    std::process::exit(model::EXIT_CLOSED)
}

/// Port to stdout until the port fails (an unplug: the process ends, exit 5) or `closing` is set.
fn pump_out(port: &ComPort, closing: &AtomicBool) {
    let event = Event::new();
    let mut buffer = vec![0u8; 16 * 1024];
    let mut stdout = std::io::stdout().lock();
    loop {
        let into = buffer.as_mut_ptr();
        let size = buffer.len() as u32;
        match overlapped(port, &event, |request| unsafe { ReadFile(port.0, into, size, std::ptr::null_mut(), request) }) {
            Ok(0) => {} // a quiet second
            Ok(read) => {
                if stdout.write_all(&buffer[..read as usize]).and_then(|_| stdout.flush()).is_err() {
                    std::process::exit(0); // nobody is reading
                }
            }
            Err(_) if closing.load(Ordering::SeqCst) => return,
            Err(code) => closed(code),
        }
    }
}

/// Stdin to the port, each chunk written whole before the next, until end of stdin.
fn pump_in(port: &ComPort) {
    let event = Event::new();
    let mut buffer = vec![0u8; 16 * 1024];
    let mut stdin = std::io::stdin().lock();
    loop {
        let read = match stdin.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        let mut sent = 0;
        while sent < read {
            let chunk = &buffer[sent..read];
            match overlapped(port, &event, |request| unsafe {
                WriteFile(port.0, chunk.as_ptr(), chunk.len() as u32, std::ptr::null_mut(), request)
            }) {
                Ok(0) => closed(1167), // nothing taken: the device is not there
                Ok(written) => sent += written as usize,
                Err(code) => closed(code),
            }
        }
    }
}

fn open(name: &str) -> i32 {
    let port = match create(name) {
        Ok(port) => port,
        Err(code) => return refuse(code),
    };
    if let Err(why) = configure(&port) {
        eprintln!("error: {why}");
        return model::EXIT_CLOSED;
    }
    eprintln!("open");
    let port = Arc::new(port);
    let closing = Arc::new(AtomicBool::new(false));
    let reader = {
        let (port, closing) = (port.clone(), closing.clone());
        std::thread::spawn(move || pump_out(&port, &closing))
    };
    pump_in(&port);
    // End of stdin: the CLI closed the link. Stop the read in flight, then close the port.
    closing.store(true, Ordering::SeqCst);
    unsafe { CancelIoEx(port.0, std::ptr::null()) };
    let _ = reader.join();
    0
}

/// Whether another program holds the port: open it and close it at once, reading and writing nothing.
fn probe(name: &str) -> i32 {
    match create(name) {
        Ok(port) => {
            drop(port);
            0
        }
        Err(code) => match model::open_failure(code) {
            OpenFailure::Busy => model::EXIT_BUSY,
            OpenFailure::Gone => model::EXIT_GONE,
            OpenFailure::Other => {
                eprintln!("error: {}", describe(code));
                model::EXIT_CLOSED
            }
        },
    }
}
```

Notes for the implementer:
- `windows-sys` 0.59 names: `HANDLE`, `HWND` and `HKEY` are `*mut c_void`, `HDEVINFO` is `isize`, `INVALID_HANDLE_VALUE` is `-1 as HANDLE`. If a name moved (a feature or a module), keep the call and record the move in the commit body.
- `CancelIoEx` with a null `OVERLAPPED` cancels every request on the handle, the reader's included; the reader sees `ERROR_OPERATION_ABORTED` with `closing` set and returns.

- [ ] **Step 5: See it pass on Windows CI**

```bash
(cd serial && cargo test --locked)   # on the Mac: the model and the cli tests; windows.rs is not built here
git add serial/src/windows.rs serial/tests/windows.rs .github/workflows/windows.yml
git commit -m "feat(windows): harness-serial watches, opens and probes the dial's COM port" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-dial
gh run list --workflow windows.yml --branch feat/windows-dial --limit 1
gh run watch <run> --exit-status
```

Expected on both architectures: `Serial: Rust tests` passes `tests/windows.rs` (2), `tests/cli.rs` (2) and the model (8); `Collect the payload` lists `harness-serial.exe`.

Read a red job's log, fix, push once (AGENTS.md CI rules).

### Task E1.3: Measure on the test PC: opening the dial does not reset it

The one risk the spec names first (Risks, DTR/RTS). Nothing in E2 is built until this passes.

**Files:**
- Modify: `desktop/scripts/windows-e2e/desktop-e2e.sh` (`VM_ADMIN`, `put-admin`, the new tools in the lists), `desktop/scripts/windows-e2e/README.md`
- Create: `desktop/scripts/windows-e2e/serial-check.ps1`
- Create: `desktop/scripts/windows-e2e/evidence/dial-e1.3-serial-check.log` (redacted)
- Modify, only if the measurement fails: `serial/src/model.rs` (`DCB_RAW` and its comment, its test)

**Interfaces:**
- Consumes: E1.2's `harness-serial.exe` from the `harness-pty-windows-x64` artifact of the run on this branch's head.
- Produces:
  - `serial-check.ps1 -WatchOnly`: `session: <s>` and `console session: <bool>`, opening nothing;
  - `desktop-e2e.sh` honours `VM_ADMIN` (the administrator account, default `admin`) and has `put-admin <file>`, which copies one file into this run's admin scratch folder;
  - `serial-check.ps1 [-Port COM3] [-Seconds 10]`, run with `$D admin serial-check.ps1`, prints the lines E5.2 scenario 2 also reads.

- [ ] **Step 1: The kit takes the test PC's administrator account**

C's kit (`desktop/scripts/windows-e2e/desktop-e2e.sh`) is written for the ARM64 VM, whose administrator is `admin`. The test PC's is not. In `desktop-e2e.sh`:

```bash
host=${VM_HOST:-192.168.65.3}
# The administrator account the kit signs in as: `admin` on the ARM64 VM, the owner's account on the x64 test PC
# (sub-project E). Its name and the PC's address come from the environment, never from the repo.
admin=${VM_ADMIN:-admin}
```

Then make every use of the account name read `$admin`, and only those (the `admin)` subcommand, `admin_root`, `push_admin`, `admin_tools`, `sh-admin` and the messages keep their names):

```bash
sed -i '' -E 's/vm_ps admin([ >])/vm_ps "$admin"\1/; s/invoke admin /invoke "$admin" /; s/put_files admin /put_files "$admin" /; s/vm admin "/vm "$admin" "/' desktop/scripts/windows-e2e/desktop-e2e.sh
grep -n -E '(vm_ps|invoke|put_files|vm) admin\b' desktop/scripts/windows-e2e/desktop-e2e.sh   # expect no output
```

Add the subcommand beside `put)`:

```bash
  put-admin) f=${1:?file required}; [ -f "$f" ] || { echo "no file $f" >&2; exit 2; }; put_files "$admin" "$(admin_root)" "$f" ;;
```

and to the usage comment at the top: `put-admin file`. Add `serial-check.ps1` to `admin_tools`. In `README.md`, after the `VM_HOST` paragraph:

```markdown
`VM_ADMIN` names the administrator account (default `admin`, the ARM64 VM's). For the x64 test PC (sub-project E,
the dial) set `VM_HOST` and `VM_ADMIN` to the values the owner gives; they are never written in the repo.
`put-admin <file>` copies one file (`harness-serial.exe`) into this run's admin scratch folder.
```

Check: `shellcheck desktop/scripts/windows-e2e/desktop-e2e.sh` reports nothing new, and `python3 -I -m unittest desktop/scripts/windows-e2e/test_e2e_tools.py` passes.

- [ ] **Step 2: `serial-check.ps1`**

```powershell
# serial-check.ps1 [-Port COM3] [-Seconds 10] [-WatchOnly]: does opening the dial reset it? (plan E1.3, spec 1.2)
# harness-serial.exe from this folder: `watch` for the dial's attachment (session), `open` for -Seconds reading what
# the dial sends, then `watch` again. Opening must leave the session as it was (a reset that re-enumerates USB moves
# it), keep the port open (a re-enumeration also ends the open) and bring no ESP-ROM boot banner. Run as the
# administrator (desktop-e2e.sh admin) with nothing else holding the port. -WatchOnly prints the session and opens
# nothing, so it can run while a daemon holds the port (E5 scenarios 4 and 7). Prints no full serial number.
param([string]$Port = 'COM3', [int]$Seconds = 10, [switch]$WatchOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exe = Join-Path $PSScriptRoot 'harness-serial.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "no ${exe}: desktop-e2e.sh put-admin it first" }
if ($Port -notmatch '^COM[1-9][0-9]{0,2}$') { throw "not a COM port: $Port" }

function Start-Serial([string]$Arguments) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $exe
  $info.Arguments = $Arguments            # keywords and a COM name: nothing to quote
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.CreateNoWindow = $true
  [Diagnostics.Process]::Start($info)
}

function Get-Dial {
  $p = Start-Serial 'watch'
  $line = $p.StandardOutput.ReadLine()
  $p.StandardInput.Close()
  if (-not $p.WaitForExit(5000)) { $p.Kill(); throw 'watch did not end at end of stdin' }
  $state = $line | ConvertFrom-Json
  $dial = @($state.ports | Where-Object { $_.path -eq $Port })
  if ($dial.Count -ne 1) { throw "watch does not list $Port as a dial: $line" }
  [pscustomobject]@{ console = $state.console; session = $dial[0].session; serial = $dial[0].serialNumber }
}

$before = Get-Dial
if ($WatchOnly) { "session: $($before.session)"; "console session: $($before.console)"; exit 0 }
$p = Start-Serial "open $Port"
$first = $p.StandardError.ReadLine()
$bytes = New-Object IO.MemoryStream
$buffer = New-Object byte[] 65536
$stream = $p.StandardOutput.BaseStream
$deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
$read = $stream.ReadAsync($buffer, 0, $buffer.Length)
while ([DateTime]::UtcNow -lt $deadline -and -not $p.HasExited) {
  if ($read.Wait(200)) {
    if ($read.Result -eq 0) { break }
    $bytes.Write($buffer, 0, $read.Result)
    $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
  }
}
$stayedOpen = -not $p.HasExited
$p.StandardInput.Close()
$ended = $p.WaitForExit(5000)
$rest = $p.StandardError.ReadToEnd().Trim()
$after = Get-Dial
$text = [Text.Encoding]::ASCII.GetString($bytes.ToArray())
$short = if ($before.serial) { $before.serial.Substring(0, [Math]::Min(8, $before.serial.Length)) + '...' } else { '(none)' }
"dial: $Port, serial $short, console session: $($before.console)"
"opened: $($first -eq 'open') ($first)"
"stayed open for $Seconds s: $stayedOpen"
"bytes read: $($bytes.Length)"
"ESP-ROM banner seen: $($text.Contains('ESP-ROM:'))"
"exit at end of stdin: $(if ($ended) { $p.ExitCode } else { 'did not end' }) $rest"
"session unchanged: $($before.session -eq $after.session)"
```

Run `powershell -NoProfile -File serial-check.ps1` once through `parse-check.ps1` as the kit's other tools are (`$D admin parse-check.ps1`), or check it parses on the Mac with `pwsh -NoProfile -Command "[ScriptBlock]::Create((Get-Content -Raw desktop/scripts/windows-e2e/serial-check.ps1)) | Out-Null"` when `pwsh` is installed.

- [ ] **Step 3: Reach the test PC by key (owner's OK)**

Ask the owner before this step: it adds one line to the PC's `administrators_authorized_keys` (removed in E5.2's clean-up). Take the address, the account and its password from the owner; type them, never write them into a file:

```bash
read -r -p 'test PC address: ' VM_HOST; read -r -p 'its administrator account: ' VM_ADMIN; export VM_HOST VM_ADMIN
read -r -s -p 'its password: ' PC_PASSWORD; echo; export PC_PASSWORD
SCR=$(mktemp -d)
KEY=$(cat ~/.ssh/id_ed25519.pub)
PS='$f = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"; $k = "'"$KEY"'"; $had = Test-Path -LiteralPath $f; if (-not $had -or -not (Select-String -LiteralPath $f -SimpleMatch $k -Quiet)) { Add-Content -LiteralPath $f -Value $k -Encoding ascii }; icacls.exe $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null; "file existed before: $had"'
B64=$(printf '%s' "$PS" | iconv -t UTF-16LE | base64 | tr -d '\n')
cat > "$SCR/ssh.exp" <<'EXP'
set timeout 60
spawn ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive $env(VM_ADMIN)@$env(VM_HOST) [lindex $argv 0]
expect { -re "(?i)password:" { send "$env(PC_PASSWORD)\r"; exp_continue } eof }
EXP
expect "$SCR/ssh.exp" "powershell -NoProfile -EncodedCommand $B64" | grep 'file existed before'
unset PC_PASSWORD
ssh -o BatchMode=yes "$VM_ADMIN@$VM_HOST" whoami
```

Pass: `whoami` answers by key. Record `file existed before: <True|False>` in the evidence: it decides the clean-up (remove the line, or the file).

- [ ] **Step 4: The measurement**

Nothing else may hold COM3: no Harness is installed on the PC (record it), and nobody runs a serial monitor.

```bash
export E2E_WORK=$(mktemp -d)/dial-e1.3; D=desktop/scripts/windows-e2e/desktop-e2e.sh; EV=desktop/scripts/windows-e2e/evidence
$D preflight > "$E2E_WORK/preflight.log"
sha=$(git rev-parse HEAD)
run=$(gh run list --workflow windows.yml --branch feat/windows-dial --limit 5 --json databaseId,headSha --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -1)
gh run download "$run" -n harness-pty-windows-x64 -D "$E2E_WORK/payload"
$D put-admin "$E2E_WORK/payload/harness-serial.exe"
grep -c '"Name": *"harness' "$E2E_WORK/preflight.json" || true   # expect 0: no Harness process on the PC
$D admin serial-check.ps1 Port=COM3 Seconds=10 | tee "$EV/dial-e1.3-serial-check.log"
$D admin serial-check.ps1 Port=COM3 Seconds=10 | tee -a "$EV/dial-e1.3-serial-check.log"
```

Pass, both runs:
- `opened: True (open)`;
- `stayed open for 10 s: True`;
- `ESP-ROM banner seen: False`;
- `exit at end of stdin: 0`;
- `session unchanged: True`.

The dial's own screen shows no reboot (**Person**: ask the owner to watch it during the second run).

- [ ] **Step 5: If it resets**

If any line fails, the DTR/RTS choice is wrong for `usbser`. Ruling: try both lines released, which can never put RTS without DTR either, and measure again:

```rust
/// DCB's bit field for the dial: fBinary only; DTR and RTS released (DTR_CONTROL_DISABLE, RTS_CONTROL_DISABLE).
///
/// On ESP32-S3 USB-Serial/JTAG, RTS asserted while DTR is not resets the chip. Asserting both, as a macOS open
/// does, reset the dial under usbser (measured on the test PC, plan E1.3, <date>); releasing both does not.
pub const DCB_RAW: u32 = 1;
```

with the model test changed to `assert_eq!(DCB_RAW, 0x1)`. Push once, download the new artifact, run Step 4 again. If both fail, stop and tell the owner with the two logs: every next guess would be a guess (spec, Risks).

- [ ] **Step 6: Commit**

Redact the evidence (`$D` output is already scrubbed; check that no full serial or address is left), then:

```bash
git add desktop/scripts/windows-e2e/desktop-e2e.sh desktop/scripts/windows-e2e/README.md desktop/scripts/windows-e2e/serial-check.ps1 \
  desktop/scripts/windows-e2e/evidence/dial-e1.3-serial-check.log
git commit -m "test(windows): opening the dial's COM port does not reset it, measured on the x64 test PC" \
  -m "Two runs of serial-check.ps1: session unchanged, port open 10 s, no ESP-ROM banner. The E2E kit takes VM_ADMIN and put-admin." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(If Step 5 changed `DCB_RAW`, add `serial/src/model.rs` and name the measurement in the message.)

## Phase E2: The CLI

### Task E2.1: `windowsSerial.ts`: the binary, the watch, the link, the probe

**Files:**
- Create: `cli/src/cable/windowsSerial.ts`, `cli/src/cable/windowsSerial.spec.ts`, `cli/src/cable/__fixtures__/fakeHarnessSerial.mjs`

**Interfaces:**
- Consumes: E1's stdio contract (Global Constraints); `currentPtyVersion` (`cli/src/lib/ptyHost/launch.ts`); `DialPort`, `DIAL_VENDOR_ID`, `DIAL_PRODUCT_ID` (`cli/src/cable/serial.ts`).
- Produces (used by E2.2):
  - `SERIAL_EXE = 'harness-serial.exe'`;
  - `interface SerialCommand { file: string; args: string[] }`, `type CommandFor = (args: string[]) => SerialCommand | null`;
  - `harnessSerialBinary(options?: { env?, runtimeDir?, besideDir?, exists? }): string | null`, `windowsSerialCommand: CommandFor`;
  - `parseSerialState(line: string): { console: boolean; ports: DialPort[] } | null`;
  - `createWindowsDialWatch(deps: { command: CommandFor; spawn?; now?; log?; firstLineMs? }): WindowsDialWatch` with `ports(): Promise<DialPort[]>`, `console(): boolean`, `stop(): void`; `windowsDialWatch(): WindowsDialWatch` (the daemon's one);
  - `openWindowsPort(command: SerialCommand, deps?: { spawn?; openWaitMs?; closeWaitMs? }): Promise<Duplex>`; it rejects with `code` `EBUSY` (exit 3), `ENOENT` (exit 4), `ETIMEDOUT` (no `open` line in time) or `EIO`; the stream emits `error` with `code` = the child's last stderr line when the port fails;
  - `windowsPortInUse(port: string, command?: CommandFor, run?: typeof execFile): Promise<boolean>`.

- [ ] **Step 1: The stand-in**

`cli/src/cable/__fixtures__/fakeHarnessSerial.mjs`:

```js
// A stand-in for harness-serial.exe (serial/), speaking its stdio contract
// (docs/superpowers/specs/2026-10-19-windows-dial-design.md §1), so cable/windowsSerial.ts is tested on any OS.
// Run as `node fakeHarnessSerial.mjs <watch | open COMn | probe COMn>`; the environment picks its behaviour:
//   FAKE_SERIAL_LINES  watch: a JSON array of lines to print, 20 ms apart
//   FAKE_SERIAL_SPLIT  watch: print each line in two writes, 30 ms apart
//   FAKE_SERIAL_EXIT   watch: after the lines, say `error: enumeration failed` and exit with this code
//   FAKE_SERIAL_OPEN   open: echo (default) | busy | gone | silent | unplug:<ms>
//   FAKE_SERIAL_PROBE  probe: free (default) | busy | gone
// Every write that is followed by an exit waits for its callback: on a pipe a write can still be in flight.
const [mode] = process.argv.slice(2)
const env = process.env
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve))
const exitAtEndOfStdin = () => { process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)) }

if (mode === 'watch') {
  exitAtEndOfStdin()
  for (const line of JSON.parse(env.FAKE_SERIAL_LINES ?? '[]')) {
    if (env.FAKE_SERIAL_SPLIT) {
      const half = Math.floor(line.length / 2)
      await write(process.stdout, line.slice(0, half))
      await sleep(30)
      await write(process.stdout, `${line.slice(half)}\n`)
    } else {
      await write(process.stdout, `${line}\n`)
    }
    await sleep(20)
  }
  if (env.FAKE_SERIAL_EXIT) {
    await write(process.stderr, 'error: enumeration failed\n')
    process.exit(Number(env.FAKE_SERIAL_EXIT))
  }
} else if (mode === 'open') {
  const behaviour = env.FAKE_SERIAL_OPEN ?? 'echo'
  if (behaviour === 'busy') { await write(process.stderr, 'busy\n'); process.exit(3) }
  if (behaviour === 'gone') { await write(process.stderr, 'gone\n'); process.exit(4) }
  if (behaviour === 'silent') exitAtEndOfStdin()
  else {
    await write(process.stderr, 'open\n')
    process.stdin.on('data', (chunk) => process.stdout.write(chunk))
    process.stdin.on('end', () => process.exit(0))
    if (behaviour.startsWith('unplug:')) {
      await sleep(Number(behaviour.slice('unplug:'.length)))
      await write(process.stderr, 'closed: The device is not connected.\n')
      process.exit(5)
    }
  }
} else if (mode === 'probe') {
  process.exit({ busy: 3, gone: 4 }[env.FAKE_SERIAL_PROBE] ?? 0)
} else {
  await write(process.stderr, 'usage: harness-serial watch | open COMn | probe COMn | version\n')
  process.exit(2)
}
```

- [ ] **Step 2: Write the failing spec**

`cli/src/cable/windowsSerial.spec.ts`:

```ts
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowsDialWatch, harnessSerialBinary, openWindowsPort, parseSerialState, windowsPortInUse,
  type CommandFor, type WindowsDialWatch,
} from './windowsSerial.js'

const FAKE = fileURLToPath(new URL('./__fixtures__/fakeHarnessSerial.mjs', import.meta.url))
const fake: CommandFor = (args) => ({ file: process.execPath, args: [FAKE, ...args] })
const line = (value: unknown) => JSON.stringify(value)
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const eventually = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let watches: WindowsDialWatch[] = []
afterEach(() => { for (const watch of watches.splice(0)) watch.stop(); vi.unstubAllEnvs() })
const watchWith = (lines: string[], extra: Record<string, string> = {}, deps: Partial<Parameters<typeof createWindowsDialWatch>[0]> = {}) => {
  vi.stubEnv('FAKE_SERIAL_LINES', JSON.stringify(lines))
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value)
  const log = vi.fn()
  const watch = createWindowsDialWatch({ command: fake, log, ...deps })
  watches.push(watch)
  return { watch, log }
}

describe('finding harness-serial.exe', () => {
  const runtime = (name: string) => {
    const root = join(mkdtempSync(join(tmpdir(), 'serial-bin-')), name)
    mkdirSync(join(root, 'pty', '0.4.21'), { recursive: true })
    writeFileSync(join(root, 'pty', 'current-pty'), '0.4.21\n')
    return root
  }

  it('takes HARNESS_SERIAL_BIN as it is, then the installed host version, then the bundle', () => {
    const root = runtime('runtime')
    const installed = join(root, 'pty', '0.4.21', 'harness-serial.exe')
    const beside = join('/bundle', 'pty', 'harness-serial.exe')
    const exists = (file: string) => file === installed || file === beside
    expect(harnessSerialBinary({ env: { HARNESS_SERIAL_BIN: ' C:\\x\\harness-serial.exe ' }, runtimeDir: root, exists })).toBe('C:\\x\\harness-serial.exe')
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists })).toBe(installed)
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists: (file) => file === beside })).toBe(beside)
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists: () => false })).toBeNull()
  })

  // Review Focus 1: a profile whose name has spaces, an apostrophe, & and % and is not ASCII.
  it('finds it under a profile path a shell would mangle', () => {
    const root = runtime("Nguyễn Văn A' & 100%")
    const installed = join(root, 'pty', '0.4.21', 'harness-serial.exe')
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, exists: (file) => file === installed })).toBe(installed)
  })
})

describe('the watch line', () => {
  it('takes COM ports with the dial ids, and drops what is not a port', () => {
    expect(parseSerialState(line({ console: true, ports: [
      { path: 'COM9', serialNumber: '28:84:85:00:00:01', session: '133' },
      { path: 'COM10' },
      { path: 'NUL' }, { serialNumber: 'x' }, null,
    ] }))).toEqual({ console: true, ports: [
      { path: 'COM9', vendorId: 0x303a, productId: 0x1001, serialNumber: '28:84:85:00:00:01', session: '133' },
      { path: 'COM10', vendorId: 0x303a, productId: 0x1001 },
    ] })
    for (const bad of ['', 'not json', '{"ports":[]}', '{"console":"yes","ports":[]}', '{"console":true}', '[]']) {
      expect(parseSerialState(bad)).toBeNull()
    }
  })
})

describe('the daemon\'s watch', () => {
  it('waits for the first line, then serves the dials and whether this user is at the screen', async () => {
    // Review Focus 5: two dials at once.
    const { watch } = watchWith([line({ console: false, ports: [{ path: 'COM9', serialNumber: 'AA' }, { path: 'COM10', serialNumber: 'BB' }] })])
    expect(watch.console()).toBe(true) // unknown reads as at the screen: the first scan must reach ports()
    const ports = await watch.ports()
    expect(ports.map((port) => port.path)).toEqual(['COM9', 'COM10'])
    expect(watch.console()).toBe(false)
  })

  // Review Focus 4. The junk line comes first, so the first answer waits for the real one.
  it('reads a line split across two writes, and skips a line that is not a state', async () => {
    const { watch } = watchWith(['harness-serial 0.1.0 starting', line({ console: true, ports: [{ path: 'COM3' }] })], { FAKE_SERIAL_SPLIT: '1' })
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
  })

  it('follows the newest line', async () => {
    const { watch } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] }), line({ console: true, ports: [] })])
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
    expect(await eventually(() => watch.ports(), (ports) => ports.length === 0)).toEqual([])
  })

  it('forgets the dials when the watch ends, says why once, and starts it again no sooner than 5 s', async () => {
    let clock = 0
    const command = vi.fn(fake)
    const { watch, log } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] })], { FAKE_SERIAL_EXIT: '2' }, { command, now: () => clock })
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
    await until(() => log.mock.calls.some(([text]) => String(text).includes('error: enumeration failed')))
    expect(await watch.ports()).toEqual([])
    expect(command).toHaveBeenCalledTimes(1)
    clock = 4_999
    await watch.ports()
    expect(command).toHaveBeenCalledTimes(1)
    clock = 5_000
    await watch.ports()
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('says once that harness-serial is not installed, and finds no dial', async () => {
    let clock = 0
    const log = vi.fn()
    const watch = createWindowsDialWatch({ command: () => null, log, now: () => clock })
    for (let i = 0; i < 3; i++) { clock += 10_000; expect(await watch.ports()).toEqual([]) }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('harness-serial is not installed')
  })

  // Review Focus 3: the daemon killed outright. Its watch must end with it, or it would outlive every daemon.
  it('ends with a parent that is killed, because the pipe closes', async () => {
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, [${JSON.stringify(FAKE)}, 'watch'], { stdio: ['pipe', 'ignore', 'ignore'] })
      console.log(child.pid)
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk)))))
    parent.kill('SIGKILL')
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    await until(() => !alive(), 5_000)
  })
})

describe('the link to one dial', () => {
  it('carries bytes both ways, a frame larger than one pipe write included, and ends its child on close', async () => {
    const stream = await openWindowsPort(fake(['open', 'COM3'])!)
    const received: Buffer[] = []
    stream.on('data', (chunk: Buffer) => received.push(chunk))
    const big = Buffer.alloc(100_000, 7)
    await new Promise<void>((resolve, reject) => stream.write(Buffer.from([0, 255, 13, 10]), (error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => stream.write(big, (error) => error ? reject(error) : resolve()))
    await until(() => Buffer.concat(received).length === 4 + big.length)
    expect(Buffer.concat(received).subarray(0, 4)).toEqual(Buffer.from([0, 255, 13, 10]))
    const closed = new Promise((resolve) => stream.once('close', resolve))
    stream.destroy()
    await closed
  })

  it('refuses a port another program has, one that is gone, and one that never says open', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'busy')
    await expect(openWindowsPort(fake(['open', 'COM3'])!)).rejects.toMatchObject({ code: 'EBUSY' })
    vi.stubEnv('FAKE_SERIAL_OPEN', 'gone')
    await expect(openWindowsPort(fake(['open', 'COM3'])!)).rejects.toMatchObject({ code: 'ENOENT' })
    vi.stubEnv('FAKE_SERIAL_OPEN', 'silent')
    await expect(openWindowsPort(fake(['open', 'COM3'])!, { openWaitMs: 300 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('fails with the reason harness-serial gave when the dial is unplugged', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'unplug:100')
    const stream = await openWindowsPort(fake(['open', 'COM3'])!)
    // Both listeners first: 'close' follows 'error' at once.
    const closed = new Promise((resolve) => stream.once('close', resolve))
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => stream.once('error', resolve))
    expect(error.code).toBe('closed: The device is not connected.')
    await closed
  })
})

describe('is another program holding the port', () => {
  it('is busy only when harness-serial says busy; cannot tell reads as free', async () => {
    for (const [probe, held] of [['busy', true], ['free', false], ['gone', false]] as const) {
      vi.stubEnv('FAKE_SERIAL_PROBE', probe)
      expect(await windowsPortInUse('COM3', fake)).toBe(held)
    }
    expect(await windowsPortInUse('COM3', () => null)).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && npx vitest run src/cable/windowsSerial.spec.ts`
Expected: FAIL: `Cannot find module './windowsSerial.js'`.

- [ ] **Step 4: `cli/src/cable/windowsSerial.ts`**

```ts
// The Windows half of the dial's serial port (docs/superpowers/specs/2026-10-19-windows-dial-design.md §2).
//
// Node cannot do it alone: a read on a COM handle through `fs` blocks a libuv pool thread and cannot be cancelled,
// and portStream cannot wrap a COM handle. So harness-serial.exe (serial/, a small Rust program) does the port and
// this file runs it: one `watch` per daemon for the dials and whether this user is at the screen, one `open` per dial
// whose stdin and stdout are the link, and `probe` for "is another program holding it". No native module, as
// serial.ts's header says, and no shell: every spawn passes an argument array.
//
// Each child ends at end of its stdin. That is how it ends with the daemon, however the daemon ends: a crash or a
// TerminateProcess closes the pipe as surely as a clean exit does.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { env } from '../config/env.js'
import { currentPtyVersion } from '../lib/ptyHost/launch.js'
// serial.ts imports this file too. The two ids are read inside functions only, never while the modules load.
import { DIAL_PRODUCT_ID, DIAL_VENDOR_ID, type DialPort } from './serial.js'

export const SERIAL_EXE = 'harness-serial.exe'
/** How long a new watch has to print its first line before `ports()` answers with none. */
export const FIRST_LINE_MS = 2_000
/** A watch that ended is started again no sooner than this, so a broken one is not spawned every scan. */
export const WATCH_RESTART_MS = 5_000
/** How long `open` has to say `open`. */
export const OPEN_WAIT_MS = 5_000
/** How long a closed link's child has to end once its stdin is closed, before it is killed. */
export const CLOSE_WAIT_MS = 2_000
/** As `lsof`'s 5 s in portInUse, a little shorter: a probe opens and closes a port and nothing else. */
export const PROBE_TIMEOUT_MS = 3_000

const COM_NAME = /^COM[1-9]\d{0,2}$/

export interface SerialCommand { file: string; args: string[] }
export type CommandFor = (args: string[]) => SerialCommand | null

export interface SerialBinaryOptions {
  env?: NodeJS.ProcessEnv
  runtimeDir?: string
  /** The bundle's own directory (`dist/` in a release); the binary is looked for in its `pty/`. */
  besideDir?: string
  exists?: (file: string) => boolean
}

/**
 * The harness-serial.exe to run, or null when there is none, in ptyHostBinary's order (ptyHost/launch.ts):
 * 1. `HARNESS_SERIAL_BIN`, as it is (a wrong override should fail loudly, not fall back);
 * 2. `<runtime>/pty/<version>/harness-serial.exe` for the version `current-pty` names: it ships in the host's
 *    payload and installs beside it, per version, because Windows cannot overwrite a running .exe;
 * 3. in `pty/` beside the bundle, where ptyPayload.mjs puts it for local Windows testing.
 */
export function harnessSerialBinary(options: SerialBinaryOptions = {}): string | null {
  const override = (options.env ?? process.env).HARNESS_SERIAL_BIN?.trim()
  if (override) return override
  const exists = options.exists ?? ((file: string) => existsSync(file))
  const runtimeDir = options.runtimeDir ?? env.ADAPTER_RUNTIME_DIR
  const version = currentPtyVersion(runtimeDir)
  if (version) {
    const file = path.join(runtimeDir, 'pty', version, SERIAL_EXE)
    if (exists(file)) return file
  }
  const beside = path.join(options.besideDir ?? path.dirname(fileURLToPath(import.meta.url)), 'pty', SERIAL_EXE)
  return exists(beside) ? beside : null
}

export const windowsSerialCommand: CommandFor = (args) => {
  const file = harnessSerialBinary()
  return file ? { file, args } : null
}

export interface WindowsSerialState { console: boolean; ports: DialPort[] }

/** One `watch` line, or null when it is not one. Ports that are not `COMn` are dropped. */
export function parseSerialState(line: string): WindowsSerialState | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { console: atConsole, ports } = value as { console?: unknown; ports?: unknown }
  if (typeof atConsole !== 'boolean' || !Array.isArray(ports)) return null
  const dials: DialPort[] = []
  for (const port of ports) {
    if (!port || typeof port !== 'object') continue
    const { path: name, serialNumber, session } = port as Record<string, unknown>
    if (typeof name !== 'string' || !COM_NAME.test(name)) continue
    dials.push({
      path: name, vendorId: DIAL_VENDOR_ID, productId: DIAL_PRODUCT_ID,
      ...(typeof serialNumber === 'string' && serialNumber ? { serialNumber } : {}),
      ...(typeof session === 'string' && session ? { session } : {}),
    })
  }
  return { console: atConsole, ports: dials }
}

function lastLine(text: string): string | null {
  return text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1) ?? null
}

export interface WindowsDialWatch {
  /** The dials the watch last reported; starts the watch on the first call and waits for its first line. */
  ports(): Promise<DialPort[]>
  /** Whether this user is at the screen. Unknown (no line yet, no watch) reads as yes: see below. */
  console(): boolean
  stop(): void
}

export interface WatchDeps {
  command: CommandFor
  spawn?: typeof spawn
  now?: () => number
  log?: (line: string) => void
  firstLineMs?: number
}

export function createWindowsDialWatch(deps: WatchDeps): WindowsDialWatch {
  const run = deps.spawn ?? spawn
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const firstLineMs = deps.firstLineMs ?? FIRST_LINE_MS
  let child: ChildProcessWithoutNullStreams | null = null
  let state: WindowsSerialState | null = null
  let startedAt = -Infinity
  let said: string | null = null
  let waiting: Array<() => void> = []
  // The same trouble every scan is said once; a state in between lets it be said again.
  const say = (line: string): void => { if (line !== said) { said = line; log(line) } }
  const wake = (): void => { for (const resolve of waiting.splice(0)) resolve() }

  const start = (): void => {
    if (child || now() - startedAt < WATCH_RESTART_MS) return
    startedAt = now()
    const command = deps.command(['watch'])
    if (!command) { say('cable: harness-serial is not installed — no USB dial can be found'); return }
    const proc = run(command.file, command.args, { stdio: 'pipe', windowsHide: true })
    child = proc
    let pending = '', stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      pending += chunk
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const next = parseSerialState(pending.slice(0, end).trim())
        pending = pending.slice(end + 1)
        if (next) { state = next; said = null; wake() }
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-500) })
    proc.stdin.on('error', () => { /* the child is gone; 'close' says so */ })
    proc.on('error', (error) => {
      say(`cable: harness-serial watch could not start: ${error.message}`)
      if (child === proc && proc.pid === undefined) { child = null; wake() }
    })
    proc.on('close', (code) => {
      if (child !== proc) return
      child = null
      state = null
      say(`cable: harness-serial watch ended (${lastLine(stderr) ?? `exit ${code}`}) — it is started again on a later scan`)
      wake()
    })
    // The daemon's exit is what ends the watch, never the other way round: nothing here may keep it alive.
    proc.unref()
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) (stream as unknown as { unref?: () => void }).unref?.()
  }

  return {
    async ports() {
      start()
      if (!state && child) {
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); waiting = waiting.filter((other) => other !== done); resolve() }
          const timer = setTimeout(done, firstLineMs)
          waiting.push(done)
        })
      }
      return (state?.ports ?? []).map((port) => ({ ...port }))
    },
    // Unknown reads as at the screen. The fleet asks this before it looks for dials (cableFleet.ts reconcile), and
    // the look is what starts the watch, so "no" here would never look. The fleet's opener asks again before and
    // after it opens a port, by which time the watch has answered.
    console() {
      start()
      return state ? state.console : true
    },
    stop() {
      const proc = child
      child = null
      state = null
      proc?.stdin.end()
      wake()
    },
  }
}

let shared: WindowsDialWatch | null = null

/** The daemon's one watch, started by the fleet's first look. */
export function windowsDialWatch(): WindowsDialWatch {
  shared ??= createWindowsDialWatch({ command: windowsSerialCommand })
  return shared
}

export interface PortStreamDeps { spawn?: typeof spawn; openWaitMs?: number; closeWaitMs?: number }

function openError(code: number | null, stderr: string): NodeJS.ErrnoException {
  const why = lastLine(stderr)
  if (code === 3) return Object.assign(new Error(`${why ?? 'busy'}: another program has the port`), { code: 'EBUSY' })
  if (code === 4) return Object.assign(new Error(`${why ?? 'gone'}: the port is not there`), { code: 'ENOENT' })
  return Object.assign(new Error(why ?? `harness-serial exited ${code}`), { code: 'EIO' })
}

/**
 * `harness-serial open <COMn>` as a duplex stream: what is written goes to its stdin, what it prints is the dial's.
 * Resolves once it says `open` on stderr (stdout carries only the dial's bytes, so the signal cannot ride there).
 * Destroying the stream ends the child's stdin and waits for it to exit, killing it after CLOSE_WAIT_MS; a child that
 * ends by itself (an unplug) destroys the stream with its last stderr line as the error's code, which SerialLink
 * hands to the session as the reason.
 */
export function openWindowsPort(command: SerialCommand, deps: PortStreamDeps = {}): Promise<Duplex> {
  const run = deps.spawn ?? spawn
  const proc = run(command.file, command.args, { stdio: 'pipe', windowsHide: true })
  let stderr = ''
  proc.stderr.setEncoding('utf8')
  proc.stdin.on('error', () => { /* a write after the child ended fails in its own callback */ })
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('harness-serial did not open the port in time'), { code: 'ETIMEDOUT' }))
      proc.kill()
    }, deps.openWaitMs ?? OPEN_WAIT_MS)
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (settled || !/^open\r?$/m.test(stderr)) return
      settled = true
      clearTimeout(timer)
      resolve(childStream(proc, () => stderr, deps.closeWaitMs ?? CLOSE_WAIT_MS))
    })
    proc.on('error', fail)
    proc.on('close', (code) => fail(openError(code, stderr)))
  })
}

function childStream(proc: ChildProcessWithoutNullStreams, stderr: () => string, closeWaitMs: number): Duplex {
  let ended = false
  proc.once('close', () => { ended = true })
  const stream = new Duplex({
    read() { proc.stdout.resume() },
    write(chunk: Buffer, _encoding, done) { proc.stdin.write(chunk, done) },
    destroy(error, done) {
      if (ended) { done(error); return }
      const timer = setTimeout(() => proc.kill(), closeWaitMs)
      proc.once('close', () => { clearTimeout(timer); done(error) })
      proc.stdin.end()
    },
  })
  proc.stdout.on('data', (chunk: Buffer) => { if (!stream.push(chunk)) proc.stdout.pause() })
  proc.once('close', (code) => {
    if (stream.destroyed) return
    const why = lastLine(stderr()) ?? `harness-serial exited ${code}`
    stream.destroy(Object.assign(new Error(why), { code: why }))
  })
  return stream
}

/** Is another program holding [port]? Only harness-serial's `busy` says yes; as with lsof, cannot tell reads as free. */
export function windowsPortInUse(port: string, command: CommandFor = windowsSerialCommand, run: typeof execFile = execFile): Promise<boolean> {
  const probe = command(['probe', port])
  if (!probe) return Promise.resolve(false)
  return new Promise((resolve) => {
    run(probe.file, probe.args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error) => {
      resolve((error as { code?: unknown } | null)?.code === 3)
    })
  })
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `cd cli && npx vitest run src/cable/windowsSerial.spec.ts && npm run typecheck`
Expected: PASS, every case; typecheck clean.

Also run `npx vitest run src/architecture.spec.ts`. `cable/` importing `lib/ptyHost/launch.ts` is an edge folder using a `lib/` helper, which the rules allow; if the spec refuses it anyway, follow the exception process its header describes rather than copying `currentPtyVersion`, and record the ruling in the commit body.

- [ ] **Step 6: Commit**

```bash
git add cli/src/cable/windowsSerial.ts cli/src/cable/windowsSerial.spec.ts cli/src/cable/__fixtures__/fakeHarnessSerial.mjs
git commit -m "feat(windows): the CLI runs harness-serial for the dial: one watch, one link per dial, and a probe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E2.2: `serial.ts` on Windows, and the fleet's console rule

**Files:**
- Modify: `cli/src/cable/serial.ts` (`findDialPorts`, `portInUse`, `SerialLink`), `cli/src/cable/usbConsoleUser.ts`, `cli/src/cable/usbConsoleUser.spec.ts`, `cli/src/cable/cableFleet.ts` (one log line and one comment)
- Create: `cli/src/cable/serialWindows.spec.ts`
- Modify: `.github/workflows/windows.yml` (the two specs in the Windows CLI specs step, `HARNESS_SERIAL_BIN`)

**Interfaces:**
- Consumes: E2.1's `windowsDialWatch`, `windowsPortInUse`, `openWindowsPort`, `windowsSerialCommand`, `CommandFor`, `createWindowsDialWatch`. `serial.ts` reaches them through a dynamic import (Step 3 says why); `usbConsoleUser.ts` imports `windowsDialWatch` statically (the fleet already loads far more).
- Produces: `SerialLink.openWindows(path, onData, onClosed, command?: CommandFor): Promise<SerialLink>` (the default command is `windowsSerialCommand`); `isUsbConsoleUser({ platform, …, windowsConsole?: () => boolean })`. Every other export of `serial.ts` keeps its signature.

- [ ] **Step 1: Write the failing specs**

`cli/src/cable/serialWindows.spec.ts`:

```ts
import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SerialLink } from './serial.js'
import { createWindowsDialWatch, windowsPortInUse, windowsSerialCommand, type CommandFor } from './windowsSerial.js'

const FAKE = fileURLToPath(new URL('./__fixtures__/fakeHarnessSerial.mjs', import.meta.url))
const fake: CommandFor = (args) => ({ file: process.execPath, args: [FAKE, ...args] })
afterEach(() => { vi.unstubAllEnvs() })

describe('SerialLink over harness-serial (any OS, the stand-in)', () => {
  it('hands the dial\'s bytes to the session, writes frames whole and in order, and closes once', async () => {
    const received: Buffer[] = []
    const closed = vi.fn()
    const link = await SerialLink.openWindows('COM3', (chunk) => received.push(chunk), closed, fake)
    expect(link.isOpen).toBe(true)
    await Promise.all([link.write(Buffer.from('one|')), link.write(Buffer.alloc(50_000, 0x41)), link.write(Buffer.from('|two'))])
    await vi.waitFor(() => expect(Buffer.concat(received).length).toBe(4 + 50_000 + 4))
    const text = Buffer.concat(received).toString('latin1')
    expect(text.startsWith('one|') && text.endsWith('|two')).toBe(true)
    await link.close()
    await link.close()
    expect(closed).toHaveBeenCalledExactlyOnceWith('closed')
    expect(link.isOpen).toBe(false)
  })

  it('tells the session why when the dial is unplugged', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'unplug:100')
    const closed = vi.fn()
    await SerialLink.openWindows('COM3', () => {}, closed, fake)
    await vi.waitFor(() => expect(closed).toHaveBeenCalledExactlyOnceWith('closed: The device is not connected.'))
  })

  it('refuses a held port as busy, and says when harness-serial is not installed', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'busy')
    await expect(SerialLink.openWindows('COM3', () => {}, () => {}, fake)).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(SerialLink.openWindows('COM3', () => {}, () => {}, () => null)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// The real binary, on the Windows runners (windows.yml sets HARNESS_SERIAL_BIN). They have no dial.
describe.runIf(process.platform === 'win32' && !!process.env.HARNESS_SERIAL_BIN)('the real harness-serial.exe', () => {
  it('finds no dial on a runner, and says whether this session is at the screen', async () => {
    const watch = createWindowsDialWatch({ command: windowsSerialCommand, log: () => {} })
    try {
      expect(await watch.ports()).toEqual([])
      expect(typeof watch.console()).toBe('boolean')
    } finally {
      watch.stop()
    }
  })

  it('a port that is not there is gone for the link and free for the probe', async () => {
    await expect(SerialLink.openWindows('COM250', () => {}, () => {})).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await windowsPortInUse('COM250')).toBe(false)
  })

  // Review Focus 1.
  it('runs from a folder whose name a shell would mangle', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'serial-')), "Nguyễn Văn A' & 100%")
    mkdirSync(dir)
    const exe = join(dir, 'harness-serial.exe')
    copyFileSync(process.env.HARNESS_SERIAL_BIN!, exe)
    const { stdout } = await promisify(execFile)(exe, ['version'], { windowsHide: true })
    expect(JSON.parse(stdout)).toMatchObject({ protocol: 1 })
  })
})
```

In `cli/src/cable/usbConsoleUser.spec.ts`, add:

```ts
  it('follows harness-serial on Windows: the console session owns the dial', () => {
    expect(isUsbConsoleUser({ platform: 'win32', windowsConsole: () => true })).toBe(true)
    expect(isUsbConsoleUser({ platform: 'win32', windowsConsole: () => false })).toBe(false)
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/cable/serialWindows.spec.ts src/cable/usbConsoleUser.spec.ts`
Expected: FAIL: `SerialLink.openWindows is not a function`; `isUsbConsoleUser` returns true for `win32` with `windowsConsole: () => false`.

- [ ] **Step 3: `serial.ts`**

The Windows module is loaded on Windows only. A static import would pull the CLI's config (dotenv) and the host's
lookup into everything that imports `serial.ts`, and the real-port specs bundle fixtures from this file with esbuild:
measured while planning, all eight `serial.real.spec.ts` cases failed with `Dynamic require of "fs" is not supported`.

1. Imports: add

```ts
import type { Duplex } from 'node:stream'
import type { CommandFor } from './windowsSerial.js'

// The Windows half, loaded on Windows only: it brings the CLI's config and the host's lookup with it, which the
// macOS and Linux path, and the real-port fixtures bundled from this file, never need.
const windows = () => import('./windowsSerial.js')
```

2. The header's second paragraph gains one sentence after "…that is the whole of what this needs.":

```ts
// On Windows a COM port is neither, so harness-serial.exe (serial/) holds it and this file talks to its stdio
// (windowsSerial.ts): still no native module.
```

3. `findDialPorts`:

```ts
export async function findDialPorts(): Promise<DialPort[]> {
  if (process.platform === 'darwin') return findDarwin()
  if (process.platform === 'linux') return findLinux()
  if (process.platform === 'win32') return (await windows()).windowsDialWatch().ports()
  return []
}
```

4. `portInUse`, first line of the body:

```ts
  // Windows has no lsof, and needs none: a COM port is exclusive, so harness-serial's probe opening it is the answer.
  if (process.platform === 'win32') return (await windows()).windowsPortInUse(path)
```

5. `SerialLink`: the constructor's `stream` parameter becomes `private readonly stream: Duplex` (a `Socket` is one; nothing else in the class needs more). `open` begins with:

```ts
    if (process.platform === 'win32') return SerialLink.openWindows(path, onData, onClosed)
```

and the class gains, after `open`:

```ts
  /**
   * Windows: harness-serial.exe holds the port, and its stdio is the stream (windowsSerial.ts). There is no tty to
   * put in raw mode and no controlling terminal to refuse, so neither stty nor O_NOCTTY applies: the child sets the
   * DCB itself, and a COM port is exclusive without a claim. The write queue and close() below are the same.
   */
  static async openWindows(
    path: string,
    onData: (chunk: Buffer) => void,
    onClosed: (why: string) => void,
    command?: CommandFor,
  ): Promise<SerialLink> {
    const { openWindowsPort, windowsSerialCommand } = await windows()
    const open = (command ?? windowsSerialCommand)(['open', path])
    if (!open) throw Object.assign(new Error('harness-serial is not installed'), { code: 'ENOENT' })
    return new SerialLink(path, await openWindowsPort(open), onData, onClosed)
  }
```

- [ ] **Step 4: `usbConsoleUser.ts`**

```ts
import { statSync } from 'node:fs'
import { windowsDialWatch } from './windowsSerial.js'

/** A daemon left running by Fast User Switching must release the physical USB
 * device. macOS hides other users' descriptors from unprivileged lsof, so its
 * empty result cannot establish that the current desktop owns the port. Windows
 * has the same switch: harness-serial's watch says whether this daemon's session
 * is the console session (WTSGetActiveConsoleSessionId). */
export function isUsbConsoleUser({
  platform = process.platform,
  uid = process.getuid?.(),
  consoleUid = () => statSync('/dev/console').uid,
  windowsConsole = () => windowsDialWatch().console(),
}: { platform?: NodeJS.Platform; uid?: number; consoleUid?: () => number; windowsConsole?: () => boolean } = {}): boolean {
  if (platform === 'win32') return windowsConsole()
  if (platform !== 'darwin') return true
  try { return uid !== undefined && uid !== 0 && uid === consoleUid() }
  catch { return false }
}
```

- [ ] **Step 5: `cableFleet.ts`**

The comment on `canUseUsb` (line 25) and the log line in `reconcile` name macOS; on Windows they are as true:

```ts
  /** Only the account at the screen may automatically own physical USB (macOS: the console user; Windows: the console session). */
```

```ts
      if (!this.waitingForConsole) this.host.log('cable: USB belongs to the account at this computer\'s screen — releasing this connection')
```

Check no spec asserts the old text: `grep -rn "active macOS account" cli/src` returns only `usbConsoleUser.spec.ts`'s test name, which stays.

- [ ] **Step 6: The workflow runs both specs on Windows with the real binary**

In `windows.yml`'s `Contract suite against the real host, and the Windows CLI specs` step, add to `env`:

```yaml
          # serialWindows.spec.ts runs the real harness-serial.exe, placed beside the host by the payload step.
          HARNESS_SERIAL_BIN: ${{ github.workspace }}\pty\target\${{ matrix.target }}\release\harness-serial.exe
```

and add `'src/cable/windowsSerial.spec.ts', 'src/cable/serialWindows.spec.ts'` to `$paths`.

- [ ] **Step 7: Run everything the change touches**

Run on the Mac:

```bash
cd cli && npx vitest run src/cable src/devices src/lib/harnessDevices.spec.ts && npm run typecheck
```

Expected: PASS. `src/cable` includes the macOS/Linux serial and fleet specs and `serial.real.spec.ts` (real PTYs, bundled fixtures), which must be unchanged in result: 765 passed and 3 skipped (the Windows-only real-binary cases) when this plan was checked. Compare any red test by name against a clean worktree of this branch's base before calling it pre-existing (the suite has known base failures; never compare by count).

- [ ] **Step 8: Commit, push, and see Windows CI pass**

```bash
git add cli/src/cable/serial.ts cli/src/cable/usbConsoleUser.ts cli/src/cable/usbConsoleUser.spec.ts cli/src/cable/cableFleet.ts \
  cli/src/cable/serialWindows.spec.ts .github/workflows/windows.yml
git commit -m "feat(windows): the daemon finds, opens and releases the dial through harness-serial" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-dial
```

Watch the `windows.yml` run on the pushed head (`gh run watch <run> --exit-status`). Expected on x64 and arm64: `serialWindows.spec.ts` runs its three real-binary cases (not skipped: check the vitest output names them) and passes.

## Phase E3: Packaging

### Task E3.1: Six payload files: `install.ps1` lays `harness-serial.exe` down beside the host

**Files:**
- Modify: `cli/scripts/install.ps1` (`$HarnessPtyFiles`), `cli/scripts/windows-install-manifest.mjs` (`PTY_FILES`, header), `cli/scripts/publish-pty-payload.sh` (`FILES`, header), `cli/scripts/lib/ptyPayload.mjs`, `cli/scripts/windows-ci/check-install.ps1`, `.github/workflows/windows.yml` (header comment only; the collect step has the file since E1.2)
- Test: `cli/src/scripts/installPs1.spec.ts`, `cli/src/scripts/windowsInstallManifest.spec.ts`, `cli/src/scripts/publishPtyPayload.spec.ts`, `cli/src/scripts/windowsWorkflows.spec.ts`, `cli/src/ptyPayload.spec.ts`

**Interfaces:**
- Consumes: E1.2's payload artifact with `harness-serial.exe`; E2's lookup of `<runtime>/pty/<version>/harness-serial.exe`.
- Produces: one list, in this order, everywhere it is written: `harness-pty.exe`, `harness-launch.exe`, `harness.exe`, `conpty.dll`, `OpenConsole.exe`, `harness-serial.exe`. `install.ps1` refuses a payload without it (`Test-HarnessPtyFolder`).

- [ ] **Step 1: The pinned lists, first (they fail until the sources change)**

- `installPs1.spec.ts` line 37: the expected line becomes
  `"$HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe')"`.
  In `build()` (line 267 on), write the sixth file and zip it:

  ```ts
      for (const name of ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']) writeFileSync(join(dir, 'payload', name), name)
  ```

  ```ts
      spawnSync(tar, ['-a', '-cf', join(dir, 'pty.zip'), '-C', join(dir, 'payload'), 'harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])
  ```

  and add `'harness-serial.exe'` to the list checked under `runtime/pty/9.8.7` (line 359).
- `windowsInstallManifest.spec.ts` line 44: `expect(PTY_FILES).toEqual(['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])`. Where its fixtures write a payload folder, write `harness-serial.exe` too.
- `publishPtyPayload.spec.ts` line 12: `const FILES = ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']`; the first case's name says "six files"; `ships the same five files as the installer manifest and install.ps1` becomes `ships the same six files …` with `expect(FILES).toHaveLength(6)`. In `refuses a payload missing a file, …`, after the `OpenConsole.exe` assertions:

  ```ts
      const noSerial = payloads('harness-serial.exe')
      const withoutSerial = run(noSerial, ['1.2.3', join(noSerial, 'x64'), join(noSerial, 'arm64')])
      expect(withoutSerial.status).toBe(1)
      expect(withoutSerial.stderr).toContain('has no harness-serial.exe')
  ```
- `windowsWorkflows.spec.ts` line 14: add `'harness-serial.exe'` to the list.
- `ptyPayload.spec.ts`: a case for the sixth file, which comes from `serial/` beside `pty/`:

  ```ts
    it('copies harness-serial from serial/ beside pty/ when it was built', () => {
      const repo = repository([HOST, LAUNCHER, COMMAND, 'vendor/conpty/x64/conpty.dll', 'vendor/conpty/x64/OpenConsole.exe', '../serial/target/release/harness-serial.exe'])
      expect(copyPtyPayload({ ...repo, platform: 'win32', arch: 'x64' })).toEqual(['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])
    })
  ```

  (`repository()` writes each name under `pty/`, so `../serial/…` lands in `serial/` beside it.)

Run: `cd cli && npx vitest run src/scripts/windowsInstallManifest.spec.ts src/scripts/publishPtyPayload.spec.ts src/scripts/windowsWorkflows.spec.ts src/ptyPayload.spec.ts`
Expected: FAIL on the lists and the new cases. (`installPs1.spec.ts` runs on Windows only; it fails there until Step 2.)

- [ ] **Step 2: The sources**

- `install.ps1` line 32:

  ```powershell
  $HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe')
  ```

  and the comment above the payload step (line 379) names it: "…the host, the launcher, the harness command, ConPTY and harness-serial (the dial's port, sub-project E)…".
- `windows-install-manifest.mjs`: `PTY_FILES` as above; the header's payload list gains `harness-serial.exe`.
- `publish-pty-payload.sh`: `FILES=(harness-pty.exe harness-launch.exe harness.exe conpty.dll OpenConsole.exe harness-serial.exe)`; the header comment names it.
- `ptyPayload.mjs`:

  ```js
  /** The files to copy, from the repository's `pty/` folder: the release host, the launcher, the command, then the
   *  payload for [arch], then harness-serial from `serial/` beside it (sub-project E). */
  export function ptyPayloadSources(ptyDir, arch) {
    const release = join(ptyDir, 'target', 'release')
    const payload = join(ptyDir, 'vendor', 'conpty', arch === 'arm64' ? 'arm64' : 'x64')
    const serial = join(ptyDir, '..', 'serial', 'target', 'release', 'harness-serial.exe')
    return [join(release, 'harness-pty.exe'), join(release, 'harness-launch.exe'), join(release, 'harness.exe'), join(payload, 'conpty.dll'), join(payload, 'OpenConsole.exe'), serial]
  }
  ```

  and its header: "Releases publish the same six files…".
- `windows.yml` header comment: "The payload is the six files install.ps1 ($HarnessPtyFiles) installs: …, OpenConsole.exe and harness-serial.exe (serial/)."
- `check-install.ps1`, after the `harness-pty.exe` host check (around line 110), so CI proves the daemon really starts the dial's watch from this install's own folder (the devices start with the core, and the fleet's first look starts the watch; no dial is needed):

  ```powershell
  # The dial's watch (sub-project E): with no dial plugged in, the daemon still runs one harness-serial.exe watch from
  # this install's host folder, the same way a dial would be found. Only this install's: another user's has no
  # ExecutablePath here.
  $deadline = (Get-Date).AddSeconds(30)
  do { $watch = @(Processes "Name='harness-serial.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", 'OrdinalIgnoreCase') }); if ($watch.Count) { break }; Start-Sleep 1 } while ((Get-Date) -lt $deadline)
  if (-not $watch.Count) { Fail "no harness-serial.exe from $root runs 30 s after the daemon started" }
  if ($watch.Count -ne 1) { Fail "$($watch.Count) harness-serial.exe from $root run; one watch was expected" }
  Write-Host "ok   the dial watch runs: $($watch[0].CommandLine)"
  ```

The install job's uninstall half already fails if a file under the install root is left; a `harness-serial.exe` still running would hold its own file, so the existing check covers it ending with the daemon.

- [ ] **Step 3: Run the specs**

Run: `cd cli && npx vitest run src/scripts src/ptyPayload.spec.ts && npm run typecheck`
Expected: PASS (the Windows-only cases skip on the Mac).

- [ ] **Step 4: Commit, push, and see the install job pass**

```bash
git add cli/scripts/install.ps1 cli/scripts/windows-install-manifest.mjs cli/scripts/publish-pty-payload.sh cli/scripts/lib/ptyPayload.mjs \
  cli/scripts/windows-ci/check-install.ps1 .github/workflows/windows.yml \
  cli/src/scripts/installPs1.spec.ts cli/src/scripts/windowsInstallManifest.spec.ts cli/src/scripts/publishPtyPayload.spec.ts \
  cli/src/scripts/windowsWorkflows.spec.ts cli/src/ptyPayload.spec.ts
git commit -m "feat(windows): the payload's sixth file, harness-serial.exe, installs beside the host" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-dial
```

Expected in the `windows.yml` run, x64 and arm64: `installPs1.spec.ts` passes; the `install` job's `Check the install` prints `ok   the dial watch runs: …\runtime\pty\<v>\harness-serial.exe" watch`; the uninstall step leaves nothing.

## Phase E4: Re-flash

### Task E4.1: `flash-circle.ps1`, its route, and the test that keeps it equal to the bash flasher

**Files:**
- Create: `website/src/app/flash-circle.ps1/flash-circle.ps1`, `website/src/app/flash-circle.ps1/route.ts`, `website/src/app/flash-circle.ps1/flash-circle-ps1.spec.ts`
- Modify: `website/next.config.js` (`outputFileTracingIncludes`), `.github/workflows/windows.yml` (`Flasher: without a board`), `devices/harness-device/firmware/scripts/upload-flasher.sh` (the Windows asset), `devices/harness-device/firmware/RELEASE.md` (the Windows flasher)

**Interfaces:**
- Consumes: the bash flasher `website/src/app/flash-circle.sh/flash-circle.sh` (read only, by the test).
- Produces: `GET /flash-circle.ps1` serving the script, first line `# flash-circle.ps1`. Flags, environment and output lines as the bash flasher's (Global Constraints), plus:
  - the cancel file `<HARNESS_FLASHER_CACHE>\cancel` (E4.3 writes it): the run stops esptool, runs its `finally`, exits 130;
  - exit codes: 0 done, 1 any `error:`, 130 cancelled.

**What differs from bash, on purpose (spec §3.1):**
- esptool runs through `Diagnostics.Process` with its output copied byte for byte (its `\r` progress reaches the app), every run bounded and checking for a cancel, ended with `taskkill /T /F` (the standalone esptool is two processes).
- **Detecting while Harness runs.** A COM port is exclusive on Windows, so with the daemon holding the dial, `--detect-only` (which does not stop Harness, as in bash) cannot ask the chip. A busy port that is the dial by its USB id (`Enum\USB\VID_303A&PID_1001&MI_00\…\PortName`) is reported as the board: `   COM3 -> in use by Harness (a dial, by its USB id)`, then `>> board: COM3`. The flash run stops Harness first and asks the chip before writing anything, so an S3 check still guards every write. On macOS esptool opens a port the daemon holds; on Windows it cannot.
- No `python3`/ESP-IDF fallback: an `esptool.exe` on PATH is the last resort.

- [ ] **Step 1: Write the failing spec**

`website/src/app/flash-circle.ps1/flash-circle-ps1.spec.ts`:

```ts
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const app = join(process.cwd(), "src", "app");
const bash = readFileSync(join(app, "flash-circle.sh", "flash-circle.sh"), "utf8");
const ps1Bytes = readFileSync(join(app, "flash-circle.ps1", "flash-circle.ps1"));
const ps1 = ps1Bytes.toString("utf8");

/** A value as the bash flasher sets it: `NAME="v"` or `NAME="${NAME:-v}"`, alone or after `;`. */
function inBash(name: string): string {
  const match = new RegExp(`(?:^|;\\s*)${name}="(?:\\$\\{[A-Z_]+:-)?([^"}]*)\\}?"`, "m").exec(bash);
  if (!match) throw new Error(`flash-circle.sh does not set ${name}`);
  return match[1];
}

/** A value as the PowerShell flasher sets it: `$NAME = 'v'` or `$NAME = EnvOr 'ENV' 'v'`. */
function inPs1(name: string): string {
  const match = new RegExp(`\\$${name} = (?:\\[int\\]\\()?(?:EnvOr '[A-Z_]+' )?'([^']*)'`, "m").exec(ps1);
  if (!match) throw new Error(`flash-circle.ps1 does not set ${name}`);
  return match[1];
}

describe("/flash-circle.ps1, the Windows flasher", () => {
  it("starts with the marker harness flash checks, and is ASCII only", () => {
    expect(ps1.split(/\r?\n/)[0]).toBe("# flash-circle.ps1");
    // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page: one non-ASCII byte is mojibake.
    expect([...ps1Bytes].findIndex((byte) => byte > 0x7f)).toBe(-1);
  });

  it("writes with exactly the bash flasher's numbers", () => {
    for (const name of [
      "CHIP", "APP_OFFSET", "OTADATA_OFFSET", "OTADATA_SIZE", "NVS_OFFSET", "NVS_SIZE",
      "FLASH_MODE", "FLASH_FREQ", "FLASH_SIZE", "ESPTOOL_VERSION", "OTA_KEY", "METADATA_PATH",
      "FIRMWARE_PATH_PREFIX", "GCS_BUCKET", "FLASHER_VERSION", "PROBE_TIMEOUT",
    ]) {
      expect(inPs1(name), name).toBe(inBash(name));
    }
  });

  it("runs esptool with the bash flasher's reset and speed choices", () => {
    for (const [inBashForm, inPs1Form] of [
      ["--before default_reset --after hard_reset --connect-attempts 1 --no-stub chip_id",
        "'--before', 'default_reset', '--after', 'hard_reset', '--connect-attempts', '1', '--no-stub', 'chip_id'"],
      ['--before default_reset --after no_reset \\\n      erase_region "$OTADATA_OFFSET" "$OTADATA_SIZE"',
        "'--before', 'default_reset', '--after', 'no_reset', 'erase_region', $OTADATA_OFFSET, $OTADATA_SIZE"],
      ['erase_region "$NVS_OFFSET" "$NVS_SIZE"', "'erase_region', $NVS_OFFSET, $NVS_SIZE"],
      ['-b 460800 --before default_reset --after hard_reset \\\n      write_flash --flash_mode "$FLASH_MODE" --flash_size "$FLASH_SIZE" --flash_freq "$FLASH_FREQ"',
        "'-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '--flash_mode', $FLASH_MODE, '--flash_size', $FLASH_SIZE, '--flash_freq', $FLASH_FREQ"],
    ]) {
      expect(bash, inBashForm).toContain(inBashForm);
      expect(ps1, inPs1Form).toContain(inPs1Form);
    }
  });

  it("pins the Windows esptool by the vendor's own digest", () => {
    expect(ps1).toContain("'esptool-v5.3.1-windows-amd64.zip' { '2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3' }");
    expect(ps1).toContain('$ESPTOOL_ASSET = "esptool-v$ESPTOOL_VERSION-windows-amd64.zip"');
  });

  it("prints the lines the desktop app reads, as bash does", () => {
    // desktop/lib/flash/flasher.dart: `>> board: `, `more than one ESP32-S3`, `no permission`, `error: `.
    expect(bash).toContain('say ">> board: $PORT"');
    expect(ps1).toContain('Say ">> board: $($script:PORT)"');
    expect(bash).toContain('warn "more than one ESP32-S3 is connected:"');
    expect(ps1).toContain("Warn 'more than one ESP32-S3 is connected:'");
    expect(ps1).toContain('Warn "error: $Text"');
    expect(ps1).toContain("Say '>> detect-only: nothing was written.'");
  });

  it("stops Harness only to flash, and starts it again however the run ends", () => {
    expect(ps1).toContain("if (-not $script:DETECT_ONLY) { Stop-HarnessForFlash }");
    expect(ps1).toMatch(/finally \{\s*Stop-Child\s*Start-HarnessAfterFlash\s*\}/);
    // Only what this script stopped is started again.
    expect(ps1).toContain("if (-not $script:HarnessStopped) { return }");
    expect(ps1).toContain("Join-Path $CACHE_DIR 'flashing'");
  });

  it("is cancelled by a file, ends esptool's whole tree, and exits 130", () => {
    expect(ps1).toContain("$CANCEL_FILE = Join-Path $CACHE_DIR 'cancel'");
    expect(ps1).toContain("Die 'cancelled' 130");
    expect(ps1).toContain("taskkill.exe /PID $p.Id /T /F");
  });

  it("is served as text that no cache keeps", async () => {
    const { GET } = await import("./route");
    const response = GET();
    expect((await response.text()).startsWith("# flash-circle.ps1")).toBe(true);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
  });
});
```

Run: `cd website && npx vitest run src/app/flash-circle.ps1`
Expected: FAIL: `ENOENT … flash-circle.ps1`.

- [ ] **Step 2: The script**

`website/src/app/flash-circle.ps1/flash-circle.ps1` (ASCII only; `$Check`, `$Arrow`, `$Dash` and `$Ellipsis` are the characters bash prints literally):

```powershell
# flash-circle.ps1
# Harness CIRCLE flasher for Windows: the twin of flash-circle.sh, with the same steps, flags, numbers and output
# lines, for `harness flash` and the desktop app's Flash firmware on Windows
# (docs/superpowers/specs/2026-10-19-windows-dial-design.md section 3). It downloads a pinned standalone esptool and
# the firmware from the same public bucket, checks both against their published sha256, finds the board itself, and
# refuses to write to anything that is not an ESP32-S3.
#
#   irm https://harness.autonomous.ai/flash-circle.ps1 -OutFile flash-circle.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1
#
#   --detect-only     find the board and print what it is; write nothing
#   --no-flash        download + verify the firmware, then stop (prints the cached path)
#   --version X.Y.Z   flash a specific published version instead of the newest
#   --port COMn       skip auto-detection (needed when two boards are plugged in)
#   --yes             don't ask for confirmation (`harness flash` always passes it)
#   --erase-nvs       ALSO wipe pairing + saved WiFi. Off by default
#   --no-verify       don't reopen the port afterwards to confirm the running version
#   --version-info    print this tool's version and exit
#
# SCOPE: this UPDATES a board that already works (see flash-circle.sh). Anything but an ESP32-S3 is a hard stop.
#
# ASCII only, on purpose: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page. The numbers
# below must equal flash-circle.sh's; flash-circle-ps1.spec.ts reads both and fails on any difference.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Check = [char]0x2713; $Arrow = [char]0x2192; $Dash = [char]0x2014; $Ellipsis = [char]0x2026

function EnvOr([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { $value } else { $Default }
}

$FLASHER_VERSION = '1.2.0'

# --- Where things live (all overridable; names match scripts/upload-firmware.sh and flash-circle.sh) ---
$GCS_BUCKET = EnvOr 'GCS_BUCKET' 's3-autonomous-upgrade-3'
$GCS_PUBLIC_BASE_URL = EnvOr 'GCS_PUBLIC_BASE_URL' "https://storage.googleapis.com/$GCS_BUCKET"
$METADATA_PATH = EnvOr 'METADATA_PATH' 'harness/esp32/ota/metadata.json'
$OTA_KEY = EnvOr 'OTA_KEY' 'commander'
$FIRMWARE_PATH_PREFIX = EnvOr 'FIRMWARE_PATH_PREFIX' 'harness/esp32/bin'
$FLASHER_BASE = EnvOr 'FLASHER_BASE' "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/harness/flasher"
$ESPTOOL_VERSION = EnvOr 'ESPTOOL_VERSION' '5.3.1'
$ESPTOOL_RELEASE_BASE = EnvOr 'ESPTOOL_RELEASE_BASE' 'https://github.com/espressif/esptool/releases/download'
$CACHE_DIR = EnvOr 'HARNESS_FLASHER_CACHE' (Join-Path $env:USERPROFILE '.harness\flasher')
$PROBE_TIMEOUT = [int](EnvOr 'HARNESS_PROBE_TIMEOUT' '25')
$CANCEL_FILE = Join-Path $CACHE_DIR 'cancel'

# --- Flash geometry. Source of truth: apps/esp32-circle/partitions.csv (as flash-circle.sh) ---
$CHIP = 'esp32s3'
$APP_OFFSET = '0x20000'
$OTADATA_OFFSET = '0xf000'
$OTADATA_SIZE = '0x2000'
$NVS_OFFSET = '0x9000'
$NVS_SIZE = '0x6000'
$FLASH_MODE = 'dio'; $FLASH_FREQ = '80m'; $FLASH_SIZE = '16MB'

# Espressif publishes no arm64 Windows build; on arm64 Windows this x64 one runs emulated.
$ESPTOOL_ASSET = "esptool-v$ESPTOOL_VERSION-windows-amd64.zip"
function Get-PinnedEsptoolSha([string]$Asset) {
  # The vendor's own release digest. Bumping ESPTOOL_VERSION means replacing this, and flash-circle.sh's block:
  # upload-flasher.sh --mirror-esptool prints both.
  switch ($Asset) {
    'esptool-v5.3.1-windows-amd64.zip' { '2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3' }
    default { '' }
  }
}

$script:DETECT_ONLY = $false; $script:NO_FLASH = $false; $script:ASSUME_YES = $false
$script:ERASE_NVS = $false; $script:NO_VERIFY = $false; $script:Finished = $false
$script:WANT_VERSION = ''; $script:PORT = ''
$script:FW_VER = ''; $script:FW_URL = ''; $script:FW_SHA = ''; $script:FW_SIZE = ''; $script:FW_FILE = ''
$script:ESPTOOL = $null
$script:Child = $null
$script:HarnessStopped = $false
$script:ExitCode = 0
$StopMarker = 'flash-circle: stopped'

function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Warn([string]$Text) { [Console]::Error.WriteLine($Text) }
# Thrown, not `exit`: the outer finally starts Harness again on every way out.
function Die([string]$Text, [int]$Code = 1) { Warn "error: $Text"; $script:ExitCode = $Code; throw $StopMarker }

function Show-Usage {
  Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 1 -First 18 | ForEach-Object { $_ -replace '^# ?', '' }
}

function Read-Arguments([object[]]$Given) {
  $i = 0
  while ($i -lt $Given.Count) {
    $a = [string]$Given[$i]
    if ($a -eq '--detect-only') { $script:DETECT_ONLY = $true }
    elseif ($a -eq '--no-flash') { $script:NO_FLASH = $true }
    elseif ($a -eq '--yes' -or $a -eq '-y') { $script:ASSUME_YES = $true }
    elseif ($a -eq '--erase-nvs') { $script:ERASE_NVS = $true }
    elseif ($a -eq '--no-verify') { $script:NO_VERIFY = $true }
    elseif ($a -eq '--version-info') { Say "flash-circle $FLASHER_VERSION"; $script:Finished = $true; return }
    elseif ($a -like '--version=*') { $script:WANT_VERSION = $a.Substring('--version='.Length) }
    elseif ($a -like '--port=*') { $script:PORT = $a.Substring('--port='.Length) }
    elseif ($a -eq '--version') { $i++; if ($i -ge $Given.Count) { Die '--version needs X.Y.Z' }; $script:WANT_VERSION = [string]$Given[$i] }
    elseif ($a -eq '--port') { $i++; if ($i -ge $Given.Count) { Die '--port needs a device path' }; $script:PORT = [string]$Given[$i] }
    elseif ($a -eq '--help' -or $a -eq '-h') { Show-Usage; $script:Finished = $true; return }
    else { Die "unknown argument '$a' (try --help)" }
    $i++
  }
  if ($script:WANT_VERSION -and $script:WANT_VERSION -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Die '--version must look like X.Y.Z' }
  if ($script:PORT) {
    $script:PORT = $script:PORT.ToUpperInvariant()
    if ($script:PORT -notmatch '^COM[1-9][0-9]{0,2}$') { Die "--port needs a COM port such as COM3, not '$($script:PORT)'" }
  }
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Save-Url([string]$Url, [string]$OutFile) {
  for ($try = 0; $try -lt 3; $try++) {
    try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing; return $true } catch { Start-Sleep -Seconds 1 }
  }
  return $false
}

function Get-UrlText([string]$Url) {
  try {
    $content = (Invoke-WebRequest -Uri $Url -UseBasicParsing).Content
    if ($content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($content) } else { [string]$content }
  } catch { $null }
}

# Windows' own command-line rules (CommandLineToArgvW), so a firmware path under a profile with a space, an
# apostrophe, & or % reaches esptool as one argument. ProcessStartInfo takes one string, not a list.
function ConvertTo-ArgumentText([string[]]$Values) {
  ($Values | ForEach-Object {
    if ($_ -ne '' -and $_ -notmatch '[\s"]') { $_ }
    else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
  }) -join ' '
}

# --- esptool: the pinned mirror, then the vendor release, then one already on PATH ---
function Find-Esptool([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  $file = Get-ChildItem -LiteralPath $Dir -Recurse -Depth 2 -Filter 'esptool.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($file) { $file.FullName } else { $null }
}

function Install-EsptoolFrom([string]$Url, [string]$Want, [string]$Dir) {
  $zip = Join-Path $CACHE_DIR $ESPTOOL_ASSET
  if (-not (Save-Url $Url $zip)) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue; return $false }
  $got = Get-Sha256 $zip
  if ($got -ne $Want) {
    Warn "   sha256 mismatch from $Url (expected $Want, got $got) $Dash not installing"
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    return $false
  }
  if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $Dir -Force
  Remove-Item -LiteralPath $zip -Force
  $found = Find-Esptool $Dir
  if (-not $found) { return $false }
  $script:ESPTOOL = $found
  return $true
}

function Install-Esptool {
  $dir = Join-Path $CACHE_DIR "esptool\$ESPTOOL_VERSION"
  $found = Find-Esptool $dir
  if ($found) { $script:ESPTOOL = $found; return }
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  $pinned = Get-PinnedEsptoolSha $ESPTOOL_ASSET
  Say ">> installing esptool $ESPTOOL_VERSION ($ESPTOOL_ASSET)"
  # 1. Our mirror first: reachable from networks that block GitHub, and it serves its own .sha256.
  $mirror = "$($FLASHER_BASE.TrimEnd('/'))/esptool/$ESPTOOL_VERSION/$ESPTOOL_ASSET"
  $mirrorSha = ''
  $text = Get-UrlText "$mirror.sha256"
  if ($text) { $mirrorSha = ($text.Trim() -split '\s+')[0] }
  if (-not $mirrorSha) { $mirrorSha = $pinned }
  if ($mirrorSha -and (Install-EsptoolFrom $mirror $mirrorSha $dir)) { Say "   installed from the mirror $Check"; return }
  # 2. The vendor release, checked against the pin above.
  if ($pinned) {
    if (Install-EsptoolFrom "$ESPTOOL_RELEASE_BASE/v$ESPTOOL_VERSION/$ESPTOOL_ASSET" $pinned $dir) { Say "   installed from the esptool release $Check (sha256 pinned)"; return }
  } else {
    Warn "   (no pinned sha256 for esptool $ESPTOOL_VERSION $Dash refusing to install an unverified binary)"
  }
  Warn "   (mirror unavailable at $mirror $Dash falling back to a local esptool)"
  $local = Get-Command 'esptool.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local) { $script:ESPTOOL = $local.Source; return }
  Die "no esptool available. The tool installs a pinned esptool by itself; both the mirror and the vendor release were unreachable. Check the network, or put esptool.exe on PATH and re-run."
}

# --- running esptool: bounded, cancellable, its output copied byte for byte ---
function Stop-Child {
  $p = $script:Child
  if ($p -and -not $p.HasExited) {
    # The standalone esptool is two processes, its bootloader and the program: ending only the first leaves the
    # second holding the port. taskkill /T ends the tree.
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
    [void]$p.WaitForExit(5000)
  }
  $script:Child = $null
}

function Test-Cancel {
  if (Test-Path -LiteralPath $CANCEL_FILE) {
    Remove-Item -LiteralPath $CANCEL_FILE -Force -ErrorAction SilentlyContinue
    Stop-Child
    Die 'cancelled' 130
  }
}

# -Show all: esptool's output as it comes. errors: only what it prints on stderr. none: nothing (the probe).
function Invoke-Esptool([string[]]$Arguments, [int]$Seconds, [string]$Show = 'all') {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:ESPTOOL
  $info.Arguments = ConvertTo-ArgumentText $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($info)
  $script:Child = $p
  $captured = New-Object IO.MemoryStream
  $pumps = @(
    @{ From = $p.StandardOutput.BaseStream; To = [Console]::OpenStandardOutput(); Copy = ($Show -eq 'all'); Buffer = (New-Object byte[] 8192); Task = $null; Done = $false },
    @{ From = $p.StandardError.BaseStream; To = [Console]::OpenStandardError(); Copy = ($Show -ne 'none'); Buffer = (New-Object byte[] 8192); Task = $null; Done = $false }
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  try {
    while ($true) {
      $open = 0
      foreach ($pump in $pumps) {
        if ($pump.Done) { continue }
        $open++
        if ($null -eq $pump.Task) { $pump.Task = $pump.From.ReadAsync($pump.Buffer, 0, $pump.Buffer.Length) }
        if ($pump.Task.Wait(100)) {
          $read = $pump.Task.Result
          $pump.Task = $null
          if ($read -eq 0) { $pump.Done = $true; continue }
          $captured.Write($pump.Buffer, 0, $read)
          if ($pump.Copy) { $pump.To.Write($pump.Buffer, 0, $read); $pump.To.Flush() }
        }
      }
      if ($open -eq 0) { break }
      Test-Cancel
      if ([DateTime]::UtcNow -gt $deadline) {
        Stop-Child
        return @{ Code = 124; Text = [Text.Encoding]::UTF8.GetString($captured.ToArray()) }
      }
    }
    $p.WaitForExit()
    return @{ Code = $p.ExitCode; Text = [Text.Encoding]::UTF8.GetString($captured.ToArray()) }
  } finally {
    $script:Child = $null
  }
}

function Assert-Esptool($Result, [string]$Step) {
  if ($Result.Code -eq 124) { Die "esptool did not finish the $Step in time" }
  if ($Result.Code -ne 0) { Die "esptool failed during the $Step (exit $($Result.Code))" }
}

# --- finding the board ---
# The dial's COM ports by its USB id, the same id harness-serial matches (serial/src/model.rs): the registry keeps
# the PortName of every enumeration, present or not, so it only ever classifies a port that is present.
function Get-DialPortNames {
  @(Get-ChildItem -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB\VID_303A&PID_1001&MI_00' -ErrorAction SilentlyContinue | ForEach-Object {
    (Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'Device Parameters') -ErrorAction SilentlyContinue).PortName
  } | Where-Object { $_ })
}

# The detected chip's name, '' when none answered, or 'BUSY' when another program holds the port.
function Get-Chip([string]$Port) {
  $result = Invoke-Esptool @('--port', $Port, '--before', 'default_reset', '--after', 'hard_reset', '--connect-attempts', '1', '--no-stub', 'chip_id') $PROBE_TIMEOUT 'none'
  if ($result.Text -match '(?i)esp32-s3') { return 'ESP32-S3' }
  if ($result.Text -match '(?i)could not open|access is denied|permissionerror|port is busy') { return 'BUSY' }
  $match = [regex]::Match($result.Text, 'Detecting chip type\.*\s*([^\r\n]*)')
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

function Select-Port {
  if ($script:PORT) { Say ">> using port $($script:PORT) (given)"; return }
  $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Where-Object { $_ -match '^COM[1-9][0-9]{0,2}$' } | Sort-Object { [int]$_.Substring(3) } -Unique)
  if ($ports.Count -eq 0) { Die 'no USB serial device found. Plug the board in and check the cable carries data (some are charge-only).' }
  $dials = Get-DialPortNames
  Say ">> probing $($ports.Count) serial port(s)$Ellipsis"
  $found = @()
  foreach ($port in $ports) {
    $chip = Get-Chip $port
    if ($chip -like '*ESP32-S3*') { Say "   $port $Arrow ESP32-S3 $Check"; $found += $port }
    elseif ($chip -eq 'BUSY' -and $script:DETECT_ONLY -and $dials -contains $port) {
      # Harness holds its dial while it runs, and --detect-only does not stop it. A flash stops it first and asks
      # the chip before it writes anything.
      Say "   $port $Arrow in use by Harness (a dial, by its USB id)"; $found += $port
    }
    elseif ($chip -eq 'BUSY') { Say "   $port $Arrow in use by another program $Dash skipped" }
    elseif (-not $chip) { Say "   $port $Arrow no ESP chip answered $Dash skipped" }
    else { Say "   $port $Arrow $chip $Dash NOT a circle board, skipped" }
  }
  if ($found.Count -eq 0) { Die 'found no ESP32-S3. The circle board is esp32s3; the square board is esp32p4 and must NOT be flashed with this image.' }
  if ($found.Count -gt 1) {
    Warn 'more than one ESP32-S3 is connected:'
    foreach ($port in $found) { Warn "  $port" }
    Die 'pass --port <one of the above> so the right board is written'
  }
  $script:PORT = $found[0]
  Say ">> board: $($script:PORT)"
}

# --- the firmware ---
function Resolve-Release {
  $metaUrl = "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/$($METADATA_PATH.TrimStart('/'))"
  $text = Get-UrlText $metaUrl
  if (-not $text) { Die 'cannot read the release manifest (network? bucket?)' }
  $meta = $text | ConvertFrom-Json
  if ($script:WANT_VERSION) {
    $script:FW_VER = $script:WANT_VERSION
    $script:FW_URL = "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/$($FIRMWARE_PATH_PREFIX.TrimStart('/'))/$($script:FW_VER).bin"
    Warn 'note: --version bypasses the manifest, which is the only place a sha256 is published.'
    Warn '      The download can be checked for shape but NOT for authenticity.'
  } else {
    $entry = $meta.$OTA_KEY
    if (-not $entry -or -not $entry.version -or -not $entry.url) { Die "manifest has no usable '$OTA_KEY' entry" }
    $script:FW_VER = [string]$entry.version; $script:FW_URL = [string]$entry.url
    $script:FW_SHA = [string]$entry.sha256; $script:FW_SIZE = [string]$entry.size
  }
  Say ">> release: $OTA_KEY $($script:FW_VER)"
  Say "   $($script:FW_URL)"
}

function Get-Firmware {
  $dir = Join-Path $CACHE_DIR "firmware\$OTA_KEY"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $script:FW_FILE = Join-Path $dir "$($script:FW_VER).bin"
  if ((Test-Path -LiteralPath $script:FW_FILE) -and $script:FW_SHA -and (Get-Sha256 $script:FW_FILE) -eq $script:FW_SHA) {
    Say ">> cached: $($script:FW_FILE)"
  } else {
    Say ">> downloading$Ellipsis"
    $part = "$($script:FW_FILE).part"
    if (-not (Save-Url $script:FW_URL $part)) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; Die 'download failed' }
    Move-Item -LiteralPath $part -Destination $script:FW_FILE -Force
  }
  if ($script:FW_SHA) {
    $got = Get-Sha256 $script:FW_FILE
    if ($got -ne $script:FW_SHA) { Remove-Item -LiteralPath $script:FW_FILE -Force; Die "firmware sha256 mismatch (expected $($script:FW_SHA), got $got) $Dash refusing to flash" }
    Say "   sha256 $Check"
  }
  $length = (Get-Item -LiteralPath $script:FW_FILE).Length
  if ($script:FW_SIZE -and [string]$length -ne $script:FW_SIZE) { Die "firmware size mismatch (expected $($script:FW_SIZE), got $length)" }
  $stream = [IO.File]::OpenRead($script:FW_FILE)
  try { $magic = $stream.ReadByte() } finally { $stream.Close() }
  if ($magic -ne 0xE9) { Die ("'$($script:FW_FILE)' is not an ESP firmware image (first byte 0x{0:x2}, expected 0xe9)" -f $magic) }
  if (-not $script:FW_SHA) { Say "   shape $Check (unverified: no published sha256 for this version)" }
  Say "   $length bytes"
}

function Confirm-Flash {
  if ($script:ASSUME_YES) { return }
  if ([Console]::IsInputRedirected) { Die "not a terminal $Dash re-run with --yes if this is intentional" }
  [Console]::Out.Write("Flash $OTA_KEY $($script:FW_VER) to $($script:PORT)? [y/N] ")
  $reply = [Console]::ReadLine()
  if ($reply -notmatch '^(y|Y|yes|YES)$') { Die 'cancelled' }
}

# --- Harness: stopped to free the port, started again however the run ends ---
function Invoke-Harness([string]$Verb) {
  $harness = Get-Command 'harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $harness) { return $null }
  # A native command's stderr becomes an error record in Windows PowerShell 5.1, which 'Stop' would throw on.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $harness.Source $Verb *> $null; return $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
}

function Stop-HarnessForFlash {
  if (-not (Get-Command 'harness' -ErrorAction SilentlyContinue)) { return }
  Say ">> stopping Harness to release USB serial ports$Ellipsis"
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  Set-Content -LiteralPath (Join-Path $CACHE_DIR 'flashing') -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -Encoding ascii -ErrorAction SilentlyContinue
  if ((Invoke-Harness 'stop') -ne 0) { Die "could not stop Harness. Run 'harness stop', then retry the flash." }
  $script:HarnessStopped = $true
  # The daemon's harness-serial children end at the end of their stdin, a moment after it (spec section 1). Only
  # this session's: another user's are not this daemon's.
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline -and @(Get-Process -Name 'harness-serial' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count) {
    Start-Sleep -Milliseconds 200
  }
}

function Start-HarnessAfterFlash {
  if (-not $script:HarnessStopped) { return }
  $script:HarnessStopped = $false
  Remove-Item -LiteralPath (Join-Path $CACHE_DIR 'flashing') -Force -ErrorAction SilentlyContinue
  Say ">> starting Harness again$Ellipsis"
  if ((Invoke-Harness 'start') -ne 0) { Warn "could not start Harness $Dash run 'harness start' yourself." }
}

# --- writing, and reading back what runs ---
function Invoke-Flash {
  Say ''
  Say ">> flashing $($script:FW_VER) $Arrow $($script:PORT)"
  Say "   erase otadata ($OTADATA_OFFSET +$OTADATA_SIZE)"
  Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '--before', 'default_reset', '--after', 'no_reset', 'erase_region', $OTADATA_OFFSET, $OTADATA_SIZE) 120 'errors') 'otadata erase'
  if ($script:ERASE_NVS) {
    Warn "   erase NVS ($NVS_OFFSET +$NVS_SIZE) $Dash pairing and saved WiFi will be gone"
    Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '--before', 'default_reset', '--after', 'no_reset', 'erase_region', $NVS_OFFSET, $NVS_SIZE) 120 'errors') 'NVS erase'
  }
  Say "   write app ($APP_OFFSET)"
  Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '--flash_mode', $FLASH_MODE, '--flash_size', $FLASH_SIZE, '--flash_freq', $FLASH_FREQ, $APP_OFFSET, $script:FW_FILE) 600) 'app write'
  Say '>> flashed.'
}

function Confirm-Running {
  if ($script:NO_VERIFY) { return }
  Say ">> confirming the running version$Ellipsis"
  $text = New-Object Text.StringBuilder
  $port = $null
  try {
    $port = New-Object System.IO.Ports.SerialPort $script:PORT, 115200
    $port.ReadTimeout = 500
    $port.Open()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
      Test-Cancel
      try { [void]$text.Append($port.ReadExisting()) } catch { }
      Start-Sleep -Milliseconds 200
    }
  } catch {
    if ($_.Exception.Message -eq $StopMarker) { throw }
  } finally {
    if ($port) { $port.Dispose() }
  }
  $match = [regex]::Match($text.ToString(), 'App version:\s*([^\r\n]*)')
  $seen = if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
  if (-not $seen) {
    Warn "   could not read a version from the boot log (not fatal $Dash power-cycle and check the screen)"
  } elseif ($seen -eq $script:FW_VER) {
    Say "   running $seen $Check"
  } else {
    Warn "   running $seen but $($script:FW_VER) was flashed $Dash the board did not boot what we wrote"
    Warn '   (if this repeats, the app may be rolling back; report it with this output)'
  }
}

function Invoke-FlashCircle([object[]]$Given) {
  Read-Arguments $Given
  if ($script:Finished) { return }
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  # A cancel left from an earlier run must not cancel this one.
  Remove-Item -LiteralPath $CANCEL_FILE -Force -ErrorAction SilentlyContinue
  # esptool is only needed to TALK to a board; --no-flash is a pure download + verify.
  if (-not $script:NO_FLASH) {
    if (-not $script:DETECT_ONLY) { Stop-HarnessForFlash }
    Install-Esptool
    Select-Port
  }
  if ($script:DETECT_ONLY) { Say '>> detect-only: nothing was written.'; return }
  Resolve-Release
  Get-Firmware
  if ($script:NO_FLASH) { Say ">> --no-flash: stopping. Image at $($script:FW_FILE)"; return }
  Confirm-Flash
  Invoke-Flash
  Confirm-Running
  Say ''
  Say "Done. $OTA_KEY $($script:FW_VER) is on $($script:PORT)."
  if ($script:ERASE_NVS) { Say "NVS was erased $Dash the device will ask to be set up again." }
}

try {
  Invoke-FlashCircle $args
} catch {
  if ($_.Exception.Message -ne $StopMarker) { Warn "error: $($_.Exception.Message)"; $script:ExitCode = 1 }
} finally {
  Stop-Child
  Start-HarnessAfterFlash
}
exit $script:ExitCode
```

- [ ] **Step 3: The route and the build's file list**

`website/src/app/flash-circle.ps1/route.ts`:

```ts
/**
 * GET /flash-circle.ps1 — the Windows twin of /flash-circle.sh (see its route for the why of every choice here):
 * the script beside this file is the single source of truth, served from disk, never cached. `harness flash` on
 * Windows fetches it (cli/src/lib/flash.ts); docs/superpowers/specs/2026-10-19-windows-dial-design.md §3.
 *
 * text/plain, not a PowerShell type: browsers show it, PowerShell's Invoke-WebRequest saves it, and nothing runs it
 * by its type.
 */

import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT = readFileSync(join(process.cwd(), "src/app/flash-circle.ps1/flash-circle.ps1"), "utf8");

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
```

`website/next.config.js`, in `outputFileTracingIncludes` after the `.sh` line:

```js
    '/flash-circle.ps1': ['./src/app/flash-circle.ps1/flash-circle.ps1'],
```

- [ ] **Step 4: Run the spec**

Run: `cd website && npx vitest run src/app/flash-circle.ps1 src/app/flash-circle.sh`
Expected: PASS (the bash spec unchanged).

- [ ] **Step 5: The mirror script and the release notes**

`upload-flasher.sh`: add `"esptool-v${ESPTOOL_VER}-windows-amd64.zip"` as the last asset in the `for asset in` list, and after the existing paste line print the PowerShell form too:

```bash
echo ""
echo ">> paste into Get-PinnedEsptoolSha in flash-circle.ps1 (website/src/app/flash-circle.ps1/):"
win="esptool-v${ESPTOOL_VER}-windows-amd64.zip"
echo "    '${win}' { '$(awk '{print $1}' "$TMP/$win.sha256")' }"
```

Change the list's comment: "Every platform the two flashers can ask for: flash-circle.sh's esptool_asset() and flash-circle.ps1's `$ESPTOOL_ASSET`." `bash -n upload-flasher.sh` must pass; `DRY=1` (the script's own dry-run switch) must list six assets.

`RELEASE.md`, in "Shipping the flasher": one paragraph:

```markdown
**Windows.** `flash-circle.ps1` beside it (`website/src/app/flash-circle.ps1/`) is the same flasher for Windows
PowerShell 5.1: same steps, flags, numbers and output, so `harness flash` and the desktop app run it unchanged on
Windows. `flash-circle-ps1.spec.ts` fails if a number differs from the bash script's. Bumping `ESPTOOL_VERSION` means
both pins; `upload-flasher.sh` prints both blocks and mirrors the Windows zip with the rest.
```

- [ ] **Step 6: Windows CI runs it without a board**

In `windows.yml`'s `windows-pty` job, after the Windows CLI specs step:

```yaml
      # The Windows flasher (sub-project E), as Windows PowerShell 5.1 runs it, with no board: its version, a refused
      # port name, and a download and check of the newest published firmware into a cache folder whose name a shell
      # would mangle (Review Focus 1). It writes to no device and publishes nothing.
      - name: 'Flasher: without a board'
        if: ${{ !inputs.release }}
        shell: powershell
        run: |
          $ps1 = 'website\src\app\flash-circle.ps1\flash-circle.ps1'
          $said = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1 --version-info
          if ($said -notmatch '^flash-circle \d+\.\d+\.\d+$') { throw "--version-info said: $said" }
          $bad = Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps1, '--port', 'NUL' -Wait -PassThru -NoNewWindow
          if ($bad.ExitCode -ne 1) { throw "--port NUL exited $($bad.ExitCode), not 1" }
          # Built from [char] codes: this step's own source must not depend on how the runner encodes it.
          $odd = "Nguy$([char]0x1EC5)n V$([char]0x0103)n A' & 100%"
          $env:HARNESS_FLASHER_CACHE = Join-Path (Join-Path $env:RUNNER_TEMP $odd) 'flasher'
          powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1 --no-flash
          if ($LASTEXITCODE -ne 0) { throw "--no-flash exited $LASTEXITCODE" }
          $images = @(Get-ChildItem -LiteralPath (Join-Path $env:HARNESS_FLASHER_CACHE 'firmware\commander') -Filter '*.bin')
          if ($images.Count -ne 1 -or $images[0].Length -lt 100000) { throw "expected one firmware image, found $($images.Count)" }
          Write-Host "ok   $($images[0].Name), $($images[0].Length) bytes, checked against the manifest"
```

- [ ] **Step 7: Commit and push**

```bash
git add website/src/app/flash-circle.ps1 website/next.config.js .github/workflows/windows.yml \
  devices/harness-device/firmware/scripts/upload-flasher.sh devices/harness-device/firmware/RELEASE.md
git commit -m "feat(windows): flash-circle.ps1, the circle flasher for Windows, held to the bash flasher's numbers by a test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin feat/windows-dial
```

Expected in the `windows.yml` run, both architectures: `Flasher: without a board` prints `ok   <version>.bin, … bytes`. The website's own CI runs its spec (PR CI, the website component) once the PR is ready.

### Task E4.2: `harness flash` on Windows runs the PowerShell flasher

**Files:**
- Modify: `cli/src/lib/flash.ts`, `cli/src/lib/flash.spec.ts`

**Interfaces:**
- Consumes: E4.1's `/flash-circle.ps1` and its first line `# flash-circle.ps1`.
- Produces: `flasherScript(platform?: NodeJS.Platform): FlasherScript` with `name`, `looksRight(body)`, `command(scriptPath, args) -> { file, args }`, `byHand(url) -> string[]`, `missing`; `scriptUrl(platform?)`; `FlashDeps` gains `platform?: NodeJS.Platform`. `flashCommand(args, overrides)` keeps its signature and its macOS/Linux behaviour and messages.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/lib/flash.spec.ts`:

```ts
describe('harness flash — on Windows', () => {
  const PS1 = '# flash-circle.ps1\r\nWrite-Output flasher\r\n'

  it('fetches the PowerShell flasher, checks its first line, and caches it under its own name', async () => {
    const urls: string[] = []
    const { deps, calls } = harness({ fetchScript: async (url) => { urls.push(url); return PS1 } })
    expect(await flashCommand(['--detect-only'], { ...deps, platform: 'win32' })).toBe(0)
    expect(urls).toEqual([scriptUrl('win32')])
    expect(scriptUrl('win32')).toMatch(/\/flash-circle\.ps1$/)
    expect(calls.written).toEqual([PS1])
    expect(calls.args[0]).toEqual(['--yes', '--detect-only'])
  })

  it('refuses what is not the flasher, and falls back to the cached copy, loudly', async () => {
    const { deps, calls } = harness({ fetchScript: async () => '<html>captive portal</html>', cache: PS1 })
    expect(await flashCommand([], { ...deps, platform: 'win32' })).toBe(0)
    expect(calls.written).toEqual([])
    expect(calls.warns.join('\n')).toContain('not the PowerShell flasher')
    expect(calls.warns.join('\n')).toContain('CACHED')
  })

  it('runs it with Windows PowerShell, the arguments untouched, and no profile or prompt', () => {
    const script = flasherScript('win32')
    expect(script.command('C:\\Users\\Nguyễn Văn A\' & 100%\\.harness\\flasher\\flash-circle.ps1', ['--yes', '--port', 'COM3'])).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\Nguyễn Văn A\' & 100%\\.harness\\flasher\\flash-circle.ps1', '--yes', '--port', 'COM3'],
    })
    expect(flasherScript('darwin').command('/x/flash-circle.sh', ['--yes'])).toEqual({ file: 'bash', args: ['/x/flash-circle.sh', '--yes'] })
  })

  it('says how to run it by hand when there is no network and no cache, and when PowerShell is missing', async () => {
    const offline = harness({ fetchScript: async () => { throw new Error('offline') }, cache: null })
    await expect(flashCommand([], { ...offline.deps, platform: 'win32' })).rejects.toThrow(/irm .*flash-circle\.ps1 -OutFile flash-circle\.ps1/)
    const noShell = harness({ fetchScript: async () => PS1, run: async () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) } })
    await expect(flashCommand([], { ...noShell.deps, platform: 'win32' })).rejects.toThrow(/powershell\.exe\) was not found/)
  })
})
```

and add `flasherScript` to the import line at the top.

Run: `cd cli && npx vitest run src/lib/flash.spec.ts`
Expected: FAIL: `flasherScript` is not exported; `platform` is ignored.

- [ ] **Step 2: `cli/src/lib/flash.ts`**

Replace the file from the imports down with this. The header comment stays, with one paragraph added at its end:

```ts
 *
 * On Windows the flasher is `flash-circle.ps1`, the PowerShell twin of the shell script (same steps, flags, numbers
 * and output; a website test holds the numbers equal), run with Windows PowerShell 5.1, which every Windows 10/11
 * has. Which script and how to run it is `flasherScript`; nothing else here differs.
 */

import { spawn } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { env } from '../config/env.js'

/**
 * The script caches its own downloads (esptool, firmware) under `~/.harness/flasher` via
 * `HARNESS_FLASHER_CACHE`. Keeping our copy of the script in the same directory is deliberate: one
 * place holds everything the flasher owns, so "delete this folder" is a complete reset.
 */
const CACHE_DIR = process.env.HARNESS_FLASHER_CACHE || join(homedir(), '.harness', 'flasher')
const FETCH_TIMEOUT_MS = 20_000

export interface FlasherScript {
  /** Its name at `<WEB_URL>/` and in the cache folder. */
  name: string
  /** Whether a downloaded body is the script and not a captive portal's page. */
  looksRight(body: string): boolean
  /** What it is, for the message when it is not. */
  kind: string
  command(scriptPath: string, args: string[]): { file: string; args: string[] }
  /** How a person runs it by hand, line by line. */
  byHand(url: string): string[]
  /** What to say when its interpreter is missing. */
  missing: string
}

export function flasherScript(platform: NodeJS.Platform = process.platform): FlasherScript {
  if (platform === 'win32') {
    return {
      name: 'flash-circle.ps1',
      looksRight: (body) => body.startsWith('# flash-circle.ps1'),
      kind: 'the PowerShell flasher',
      // -ExecutionPolicy Bypass for this one process: a user's policy may refuse scripts. The file came from fetch,
      // which marks nothing as downloaded, so no SmartScreen or zone check is involved.
      command: (scriptPath, args) => ({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args] }),
      byHand: (url) => [`  irm ${url} -OutFile flash-circle.ps1`, '  powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1'],
      missing: 'Windows PowerShell (powershell.exe) was not found, and the flasher is a PowerShell script.\nRun it yourself from a PowerShell window:',
    }
  }
  return {
    name: 'flash-circle.sh',
    looksRight: (body) => body.startsWith('#!'),
    kind: 'a shell script',
    command: (scriptPath, args) => ({ file: 'bash', args: [scriptPath, ...args] }),
    byHand: (url) => [`  curl -fsSL ${url} -o flash-circle.sh`, '  bash flash-circle.sh'],
    missing: 'bash was not found on PATH, and the flasher is a bash script.\nInstall bash, or run it yourself on a machine that has one:',
  }
}

export interface FlashDeps {
  /** Overridden in tests; the real one is `fetch`. */
  fetchScript: (url: string) => Promise<string>
  readCache: () => string | null
  writeCache: (body: string) => void
  run: (scriptPath: string, args: string[]) => Promise<number>
  log: (line: string) => void
  warn: (line: string) => void
  /** Which flasher: overridden in tests; the real one is this machine's. */
  platform?: NodeJS.Platform
}

export function scriptUrl(platform: NodeJS.Platform = process.platform): string {
  return `${env.WEB_URL.replace(/\/+$/, '')}/${flasherScript(platform).name}`
}

async function realFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The server already answers `no-store` for a reason it states out loud: an operator must never be
    // handed a stale flasher after a fix has shipped. Say the same thing from this side so a proxy in
    // between cannot decide otherwise.
    headers: { 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.text()
}

function realRun(script: FlasherScript) {
  return (scriptPath: string, args: string[]): Promise<number> => new Promise((resolve, reject) => {
    const { file, args: argv } = script.command(scriptPath, args)
    // `inherit`, not a pipe. The script prints progress as it goes and asks for confirmation on the
    // terminal; capturing its output would hide the first and break the second.
    const child = spawn(file, argv, { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function defaultsFor(platform: NodeJS.Platform): { deps: FlashDeps; cached: string } {
  const script = flasherScript(platform)
  const cached = join(CACHE_DIR, script.name)
  return {
    cached,
    deps: {
      fetchScript: realFetch,
      readCache: () => {
        try { return readFileSync(cached, 'utf-8') } catch { return null }
      },
      writeCache: (body) => {
        mkdirSync(dirname(cached), { recursive: true })
        writeFileSync(cached, body, { mode: 0o755 })
      },
      run: realRun(script),
      log: (line) => console.log(line),
      warn: (line) => console.error(line),
      platform,
    },
  }
}

/**
 * Fetch-then-fall-back, and always say which one happened.
 *
 * The network copy wins whenever it can be had, because a flasher fix has to reach the person holding
 * the board. The cache exists only so a flash is still possible on a machine that is offline — which
 * is a real situation at a bench — and using it is reported, never silent.
 *
 * A captive portal or an error page returns 200 with HTML. Running that does nothing useful and reports it
 * confusingly, so the body is checked before it is ever written to disk, and a wrong one falls back as a
 * failed download does.
 */
async function resolveScript(deps: FlashDeps, script: FlasherScript, cached: string): Promise<{ body: string; source: 'fetched' | 'cached' }> {
  const url = scriptUrl(deps.platform)
  try {
    const body = await deps.fetchScript(url)
    if (!script.looksRight(body)) throw new Error(`response is not ${script.kind} (proxy or error page?)`)
    deps.writeCache(body)
    return { body, source: 'fetched' }
  } catch (err) {
    const fromCache = deps.readCache()
    const why = err instanceof Error ? err.message : String(err)
    if (fromCache === null) {
      throw new Error(
        `could not download the flasher from ${url} (${why}), and no cached copy exists.\n`
        + 'With a working connection you can always run it by hand:\n'
        + script.byHand(url).join('\n'),
      )
    }
    deps.warn(`!  could not reach ${url} (${why})`)
    deps.warn(`!  running the CACHED flasher from ${cached} — it may be out of date`)
    return { body: fromCache, source: 'cached' }
  }
}

/**
 * Run the published circle flasher with `args` passed straight through.
 *
 * Returns the script's own exit code so `harness flash --detect-only` is usable in a shell condition:
 * the script exits non-zero when it finds no board, and that has to survive the wrapper.
 */
export async function flashCommand(args: string[], overrides: Partial<FlashDeps> = {}): Promise<number> {
  const platform = overrides.platform ?? process.platform
  const { deps: defaults, cached } = defaultsFor(platform)
  const deps: FlashDeps = { ...defaults, ...overrides, platform }
  const script = flasherScript(platform)
  const { source } = await resolveScript(deps, script, cached)
  deps.log(`>> circle flasher (${source === 'fetched' ? scriptUrl(platform) : `cached: ${cached}`})`)
  try {
    // `--yes` FIRST, ALWAYS. The prompt in the script exists for the standalone `curl | bash` case, where
    // the operator may not know what is plugged in; it still guards that path. Reaching a board through
    // `harness flash` is a different situation — the person typed the product's own command at the
    // product's own device — and the check that actually prevents damage is the script's refusal to write
    // to anything that is not an ESP32-S3. A confirmation in front of a customer converting the device
    // they own is friction wearing the clothes of safety. The user's own flags follow and still win.
    return await deps.run(cached, ['--yes', ...args])
  } catch (err) {
    // The only way `spawn` itself fails here in practice: the script's interpreter is missing. Say what to do
    // instead of just failing.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`${script.missing}\n${script.byHand(scriptUrl(platform)).join('\n')}`)
    }
    throw err
  }
}
```

The bash path's messages are unchanged: `could not download …` with `curl -fsSL …` and `bash flash-circle.sh`; `bash was not found on PATH, and the flasher is a bash script.` followed by `Install bash, or run it yourself on a machine that has one:` and the two lines; `response is not a shell script (proxy or error page?)`.

- [ ] **Step 3: Run the specs**

Run: `cd cli && npx vitest run src/lib/flash.spec.ts && npm run typecheck`
Expected: PASS, the existing cases unchanged.

- [ ] **Step 4: Commit**

```bash
git add cli/src/lib/flash.ts cli/src/lib/flash.spec.ts
git commit -m "feat(windows): harness flash runs flash-circle.ps1 with Windows PowerShell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E4.3: The desktop cancels a flash on Windows by file, and names this computer

**Files:**
- Modify: `desktop/lib/flash/flasher.dart`, `desktop/lib/core/serial_port_lease.dart`, `desktop/lib/widgets/flash_firmware_dialog.dart`
- Test: `desktop/test/flasher_test.dart`, `desktop/test/serial_port_lease_test.dart`

**Interfaces:**
- Consumes: E4.1's cancel file `<flasher cache>\cancel`; `RuntimePlatform.isWindows` (`desktop/lib/core/runtime_platform.dart`).
- Produces:
  - `SerialPortLease.flasherDirectory({Map<String, String>? environment}) -> String`: `HARNESS_FLASHER_CACHE`, else `~/.harness/flasher` (what `heldByAnotherProcess` already reads; now one place);
  - `Flasher({startProcess, bool? windows, String? cancelDirectory, Duration killAfter = const Duration(seconds: 15), Future<void> Function(int pid)? killTree})`;
  - `flashHostName({bool? windows}) -> String`: `this computer` on Windows, `this Mac` elsewhere (today's copy).

- [ ] **Step 1: Write the failing tests**

In `desktop/test/flasher_test.dart`, beside `cancel asks with SIGTERM …`:

```dart
  test('on Windows, cancel asks the script by file and ends the tree only if it does not stop', () async {
    final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
    addTearDown(() => dir.deleteSync(recursive: true));
    late _FakeProcess spawned;
    final killed = <int>[];
    final flasher = Flasher(
      windows: true,
      cancelDirectory: dir.path,
      killAfter: const Duration(milliseconds: 50),
      killTree: (pid) async => killed.add(pid),
      startProcess: (_) async {
        spawned = _FakeProcess(out: ['>> flashing…'], code: 130, waitForKill: true);
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();
    // No signal: TerminateProcess would skip the script's finally, the one place that starts Harness again.
    expect(spawned.signals, isEmpty);
    expect(File('${dir.path}${Platform.pathSeparator}cancel').existsSync(), isTrue);
    expect(killed, isEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 120));
    expect(killed, [spawned.pid]);
    spawned.kill(); // the fake ends as the tree kill would end it
    final result = await run;
    expect(result.cancelled, isTrue);
  });

  test('on Windows, a script that stops in time is not killed', () async {
    final dir = Directory.systemTemp.createTempSync('flasher-cancel-');
    addTearDown(() => dir.deleteSync(recursive: true));
    late _FakeProcess spawned;
    final killed = <int>[];
    final flasher = Flasher(
      windows: true,
      cancelDirectory: dir.path,
      killAfter: const Duration(milliseconds: 200),
      killTree: (pid) async => killed.add(pid),
      startProcess: (_) async {
        spawned = _FakeProcess(out: const [], code: 130, waitForKill: true);
        return spawned;
      },
    );
    final run = flasher.flash();
    await Future<void>.delayed(Duration.zero);
    flasher.cancel();
    spawned.kill(); // the script saw the file and ended by itself
    await run;
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(killed, isEmpty);
  });

  test('the dialog names this computer on Windows and keeps "this Mac" elsewhere', () {
    expect(flashHostName(windows: true), 'this computer');
    expect(flashHostName(windows: false), 'this Mac');
  });
```

In `desktop/test/serial_port_lease_test.dart`:

```dart
  test('the flasher folder is HARNESS_FLASHER_CACHE, else ~/.harness/flasher', () {
    expect(SerialPortLease.flasherDirectory(environment: {'HARNESS_FLASHER_CACHE': '/x/f', 'HOME': '/h'}), '/x/f');
    expect(SerialPortLease.flasherDirectory(environment: {'HOME': '/h'}), HarnessFileStore.defaultDirectoryPath(environment: {'HOME': '/h'}, name: 'flasher'));
  });
```

(import `package:harness/core/harness_file_store.dart` there if the file does not yet.)

Run: `cd desktop && flutter test test/flasher_test.dart test/serial_port_lease_test.dart`
Expected: FAIL: the named parameters `windows`, `cancelDirectory`, `killAfter`, `killTree` do not exist; `flashHostName` and `flasherDirectory` are not defined.

- [ ] **Step 2: `serial_port_lease.dart`**

Add, and make `heldByAnotherProcess` call it for its `dir`:

```dart
  /// Where the flasher keeps its downloads, its `flashing` flag and, on Windows, the `cancel` file the app writes
  /// (flash-circle.ps1). Honours the same override the flasher script reads, so the two sides cannot end up
  /// looking in different places.
  static String flasherDirectory({Map<String, String>? environment}) {
    final env = environment ?? Platform.environment;
    return env['HARNESS_FLASHER_CACHE'] ??
        HarnessFileStore.defaultDirectoryPath(
          environment: environment,
          name: 'flasher',
        );
  }
```

In `heldByAnotherProcess`, replace the `env`/`dir` lines with `final dir = flasherDirectory(environment: environment);`.

- [ ] **Step 3: `flasher.dart`**

Imports: add `import '../core/runtime_platform.dart';`.

```dart
/// How the flash dialog names the computer the dial is plugged into.
String flashHostName({bool? windows}) =>
    (windows ?? RuntimePlatform.isWindows) ? 'this computer' : 'this Mac';
```

The class:

```dart
class Flasher {
  Flasher({
    this.startProcess = harnessCliStart,
    bool? windows,
    this.cancelDirectory,
    this.killAfter = const Duration(seconds: 15),
    Future<void> Function(int pid)? killTree,
  }) : _windows = windows ?? RuntimePlatform.isWindows,
       _killTree = killTree ?? _taskkillTree;

  /// Overridden in tests.
  final Future<Process> Function(List<String> arguments) startProcess;

  /// How long a cancelled flash on Windows has to stop by itself before its process tree is ended.
  final Duration killAfter;

  /// Where the Windows cancel file goes; the flasher's folder unless a test says otherwise.
  final String? cancelDirectory;
  final bool _windows;
  final Future<void> Function(int pid) _killTree;
  Timer? _killTimer;

  static Future<void> _taskkillTree(int pid) async {
    // `harness flash` runs PowerShell, which runs esptool: Process.kill ends only the first of them.
    await Process.run('taskkill', ['/PID', '$pid', '/T', '/F']);
  }
```

`cancel()`:

```dart
  /// Asks a running flash to stop, and lets it unwind.
  ///
  /// SIGTERM, never SIGKILL. The script arms
  /// `trap start_harness_after_flash EXIT INT TERM`, and that trap is the only
  /// thing that brings the Harness daemon back after the script stopped it to
  /// free the serial port. Killing it outright leaves the computer with no
  /// daemon and the dial dark — worse than never having flashed at all.
  ///
  /// Windows has no signal a script can trap: Process.kill is TerminateProcess,
  /// which skips flash-circle.ps1's `finally`, its one way of starting Harness
  /// again. So the app asks by file (the script looks every second), and ends
  /// the tree only if the script has not stopped within [killAfter]. Then the
  /// lease's release lets this app's own supervision start the daemon on its
  /// next tick.
  void cancel() {
    final process = _running;
    if (process == null) return;
    _cancelled = true;
    if (!_windows) {
      process.kill(ProcessSignal.sigterm);
      return;
    }
    try {
      final dir = Directory(
        cancelDirectory ?? SerialPortLease.flasherDirectory(),
      )..createSync(recursive: true);
      File(
        '${dir.path}${Platform.pathSeparator}cancel',
      ).writeAsStringSync('${DateTime.now().millisecondsSinceEpoch}');
    } catch (_) {
      unawaited(_killTree(process.pid));
      return;
    }
    _killTimer?.cancel();
    _killTimer = Timer(killAfter, () {
      if (identical(_running, process)) unawaited(_killTree(process.pid));
    });
  }
```

In `_run`'s `finally`, before `_running = null;`:

```dart
      _killTimer?.cancel();
      _killTimer = null;
```

- [ ] **Step 4: `flash_firmware_dialog.dart`**

The two lines that say "this Mac":

```dart
        'Checking the USB ports on ${flashHostName()}.',
```

```dart
            'Plug the dial into ${flashHostName()} with a USB cable, then look '
                'again.',
```

- [ ] **Step 5: Run the tests and the analyzer**

Run: `cd desktop && flutter test test/flasher_test.dart test/serial_port_lease_test.dart && flutter analyze lib/flash lib/core/serial_port_lease.dart lib/widgets/flash_firmware_dialog.dart test/flasher_test.dart test/serial_port_lease_test.dart`
Expected: PASS, `No issues found!`.

- [ ] **Step 6: Commit**

```bash
git add desktop/lib/flash/flasher.dart desktop/lib/core/serial_port_lease.dart desktop/lib/widgets/flash_firmware_dialog.dart \
  desktop/test/flasher_test.dart desktop/test/serial_port_lease_test.dart
git commit -m "feat(windows): the desktop cancels a flash by file on Windows, and its dialog names this computer" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Phase E5: End to end on the x64 test PC

### Task E5.1: The dial tools for the kit

**Files:**
- Create: `desktop/scripts/windows-e2e/dial-state.ps1`, `hold-port.ps1`, `install-build.ps1`, `harness-cli.ps1`
- Modify: `desktop/scripts/windows-e2e/desktop-e2e.sh` (`vm_tools`), `desktop/scripts/windows-e2e/README.md`

**Interfaces:**
- Consumes: C5.1's kit (`ownership.ps1`'s `Assert-OwnedUser`, `invoke.ps1`, `session-run.ps1`); E1.3's `VM_ADMIN`.
- Produces, each run as the owned test user (`$D ps <tool>` over SSH, or `$D run <tool>` in its desktop session):
  - `dial-state.ps1 [-Lines 8]`: `host <id…> online=… available=… devices=N`, then per device `device <id…> attached=… fw=… hw=… settings=<names> updating=…`; `harness-serial processes of this user: N`; the newest dial log's last `alive up=` lines and `cable:` lines;
  - `hold-port.ps1 [-Port COM3] [-Seconds 30]`: `holding COM3 for 30 s` … `released COM3`, or exit 3 `could not open …`;
  - `install-build.ps1 -Zip <path>`: unpacks a zipped manifest folder and runs its `install.ps1 -Manifest`; prints `install.ps1 exited 0` and `harness version`;
  - `harness-cli.ps1 -Arguments <array>` (`'Arguments=["stop"]'`, `'Arguments=["flash","--version","0.0.70"]'`): runs `harness start|stop|flash|uninstall …` in the desktop session, so the daemon it starts is at the console (a daemon started over SSH is in another session, and `watch` rightly says it is not at the screen); prints `harness <args> exited <code>` and the last lines.

- [ ] **Step 1: The tools**

`dial-state.ps1`:

```powershell
# dial-state.ps1 [-Lines 8]: the dial as this user's daemon sees it, read-only (plan E5). What `harness devices list`
# says of each owned computer, how many harness-serial processes this user runs (one watch, one link per open dial),
# and the newest dial log's last lines: the firmware's minute heartbeat (`alive up=<s>`, ui/habitat/display_habitat.c)
# and the daemon's `cable:` events. Machine ids and serials are shortened; nothing secret is printed.
param([int]$Lines = 8)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
function Short([string]$Text) { if ($Text -and $Text.Length -gt 8) { $Text.Substring(0, 8) + '...' } else { $Text } }
function Scrub([string]$Text) { $Text -replace '(?i)\b((?:[0-9a-f]{2}:){3})(?:[0-9a-f]{2}:){2}[0-9a-f]{2}\b', '$1...' }
$harness = Join-Path $env:USERPROFILE '.harness\bin\harness.exe'
$raw = (& $harness devices list --json 2>&1) -join "`n"
try {
  $doc = $raw | ConvertFrom-Json
  foreach ($h in @($doc.hosts)) {
    $devices = @($h.status.devices)
    if (-not $devices.Count -and $h.status) { $devices = @($h.status) }
    "host $(Short $h.machineId) online=$($h.online) available=$($h.available) devices=$($devices.Count)"
    foreach ($d in $devices) {
      $names = if ($d.settings) { ($d.settings.PSObject.Properties.Name | Sort-Object) -join ',' } else { '(none)' }
      "  device $(Short $d.id) attached=$($d.attached) fw=$($d.fw) hw=$($d.hw) settings=$names updating=$($d.updating)"
    }
  }
} catch { "devices list did not parse: $(Scrub (($raw -split "`n" | Select-Object -First 3) -join ' | '))" }
$serial = @(Get-Process -Name 'harness-serial' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$env:USERPROFILE\", 'OrdinalIgnoreCase') })
"harness-serial processes of this user: $($serial.Count)"
$logs = Join-Path $env:USERPROFILE '.harness\logs'
$log = Get-ChildItem -LiteralPath $logs -Filter 'dial-*.log' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $log) { 'dial log: (none yet)'; exit 0 }
"dial log: $($log.Directory.Name)\$($log.Name)" -replace 'usb-[^\\]+', 'usb-<id>'
$tail = Get-Content -LiteralPath $log.FullName -Tail 600
$tail | Select-String -Pattern 'alive up=' | Select-Object -Last 3 | ForEach-Object { '  ' + (Scrub $_.Line) }
$tail | Select-String -Pattern 'cable:' | Select-Object -Last $Lines | ForEach-Object { '  ' + (Scrub $_.Line) }
```

`hold-port.ps1`:

```powershell
# hold-port.ps1 [-Port COM3] [-Seconds 30]: hold a COM port as a serial monitor does, then let it go (plan E5,
# scenario 5: the daemon must leave a held port alone, and take the dial once it is free).
param([string]$Port = 'COM3', [int]$Seconds = 30)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
if ($Port -notmatch '^COM[1-9][0-9]{0,2}$') { throw "not a COM port: $Port" }
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200
try { $sp.Open() } catch { "could not open $Port`: $($_.Exception.Message)"; exit 3 }
try {
  "holding $Port for $Seconds s"
  Start-Sleep -Seconds $Seconds
} finally {
  $sp.Dispose()
}
"released $Port"
```

`install-build.ps1`:

```powershell
# install-build.ps1 -Zip <file>: install a CLI build made on the Mac (windows-install-manifest.mjs, zipped with this
# branch's install.ps1 beside it) into this user's own profile, as the Windows workflow's install job does:
# install.ps1 -Manifest. A relative -Zip is under the profile. Updates are off: the build under test stays.
param([Parameter(Mandatory)][string]$Zip)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
$zipPath = if ([IO.Path]::IsPathRooted($Zip)) { $Zip } else { Join-Path $env:USERPROFILE $Zip }
$dir = Join-Path $env:USERPROFILE 'e2e\dial-build'
if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $dir
[Environment]::SetEnvironmentVariable('ADAPTER_UPDATE_DISABLE', 'true', 'User')
$env:ADAPTER_UPDATE_DISABLE = 'true'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'install.ps1') -Manifest (Join-Path $dir 'install-manifest.json')
"install.ps1 exited $LASTEXITCODE"
& (Join-Path $env:USERPROFILE '.harness\bin\harness.exe') version
```

`harness-cli.ps1`:

```powershell
# harness-cli.ps1 -Arguments <array>: `harness <arguments>` in this user's desktop session (desktop-e2e.sh run), for
# start, stop, flash and uninstall. A daemon started over SSH runs in the SSH session, which is not the console, and
# must not take the dial (spec section 1); a flash must stop and start this session's daemon, not another.
param([Parameter(Mandatory)][string[]]$Arguments)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
if ($Arguments[0] -notin @('start', 'stop', 'flash', 'uninstall')) { throw "not a verb this tool runs: $($Arguments[0])" }
$out = & (Join-Path $env:USERPROFILE '.harness\bin\harness.exe') @Arguments 2>&1
"harness $($Arguments -join ' ') exited $LASTEXITCODE"
$out | Select-Object -Last 15
```

Add the four to `vm_tools` in `desktop-e2e.sh`, and to the README's tool list one line each, as the existing tools are listed.

- [ ] **Step 2: Check they parse, then commit**

```bash
for f in dial-state hold-port install-build harness-cli serial-check; do
  pwsh -NoProfile -Command "[ScriptBlock]::Create((Get-Content -Raw desktop/scripts/windows-e2e/$f.ps1)) | Out-Null" && echo "$f parses"
done
shellcheck desktop/scripts/windows-e2e/desktop-e2e.sh
git add desktop/scripts/windows-e2e/{dial-state,hold-port,install-build,harness-cli}.ps1 desktop/scripts/windows-e2e/desktop-e2e.sh desktop/scripts/windows-e2e/README.md
git commit -m "test(windows): the E2E kit's dial tools: its state, a held port, a CLI build install, harness start/stop at the desktop" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If `pwsh` is not on the Mac, run the kit's `parse-check.ps1` on the PC instead (`$D admin parse-check.ps1`, after adding the files to `admin_tools` for that one run, or `$D ps parse-check.ps1` once the test user exists).

### Task E5.2: The eleven scenarios on the test PC, and `docs/testing/windows-dial-e2e.md`

**Files:**
- Create: `docs/testing/windows-dial-e2e.md`
- Create: `desktop/scripts/windows-e2e/evidence/dial-<scenario>-*.log` and `.png` (redacted, every screenshot looked at and masked before commit)
- Modify: only through a fix found during the run. Each fix is its own commit with a test that fails without it, in the task that owns the file; then the scenario runs again.

**Interfaces:**
- Consumes: E1–E4 on this branch, pushed; the `windows.yml` run of the final head (its `harness-pty-windows-x64` artifact); C's staging desktop build (C5.2's version N1, already published with the owner's OK); E1.3's key access and `VM_HOST`/`VM_ADMIN`; E5.1's tools.
- Produces: the E2E doc: summary table, setup recipe, each scenario's steps, evidence, timings, fixes, findings, known limits, safety rules and clean-up.

**Who checks what**, as C5.2: **Script** (logs, files, process lists), **UIA** (`uia.ps1`, seen in a screenshot), **Person** (the owner at the PC: the dial's screen, a cable pulled by hand, a user switch). The executor asks, waits, and records what the person reports. Record wall-clock time at each step's start and end (`$D stamp`), and report implementation, validation, waiting and writing separately.

**Safety** (Global Constraints): the PC's own account and files are not touched; everything is the throwaway user's or the admin scratch folder's, and removed at the end. No publish of any kind.

- [ ] **Step 0: Preflight and the build**

```bash
export E2E_WORK=$(mktemp -d)/dial-e5; D=desktop/scripts/windows-e2e/desktop-e2e.sh; EV=desktop/scripts/windows-e2e/evidence
read -r -p 'test PC address: ' VM_HOST; read -r -p 'its administrator account: ' VM_ADMIN; export VM_HOST VM_ADMIN E2E_USER=hxdial
$D stamp "E5.2 start" | tee "$E2E_WORK/times.log"
$D preflight | tee "$EV/dial-preflight.log"
sha=$(git rev-parse HEAD)
run=$(gh run list --workflow windows.yml --branch feat/windows-dial --limit 5 --json databaseId,headSha --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -1)
gh run download "$run" -n harness-pty-windows-x64 -D "$E2E_WORK/payload"
V=0.9.0-dev.dial1
(cd cli && npm ci --silent && ADAPTER_VERSION=$V npm run bundle)
NODE=v22.23.2; zip=node-$NODE-win-x64.zip
curl -fsSL -o "$E2E_WORK/$zip" "https://nodejs.org/dist/$NODE/$zip"
want=$(curl -fsSL "https://nodejs.org/dist/$NODE/SHASUMS256.txt" | awk -v z="$zip" '$2 == z {print $1}')
[ "$(shasum -a 256 "$E2E_WORK/$zip" | awk '{print $1}')" = "$want" ] || { echo "node zip sha256 mismatch"; exit 1; }
PTYV=$(sed -n 's/^version = "\(.*\)"/\1/p' pty/Cargo.toml | head -1)
node cli/scripts/windows-install-manifest.mjs --out "$E2E_WORK/build" --cli-dir cli/dist --pty-dir "$E2E_WORK/payload" \
  --node-zip "$E2E_WORK/$zip" --version "$V" --pty-version "$PTYV"
cp cli/scripts/install.ps1 "$E2E_WORK/build/"
(cd "$E2E_WORK/build" && python3 -m zipfile -c "$E2E_WORK/dial-install.zip" .)
```

Pass: `dial-preflight.log` shows no `harness*` process; the payload has six files including `harness-serial.exe`. `$V` is a `-dev` version, which no updater replaces, and above C1.3's `kMinimumWindowsHarnessCliVersion`.

- [ ] **Step 1: The test user, at the PC's screen**

```bash
$D user-add | tee "$EV/dial-users.log"
```

**Person:** the owner signs in as `hxdial` at the PC with Windows' **Switch user** (the password is the last line of `$E2E_WORK/users.txt`; give it in person, never in a file that is committed). Then:

```bash
$D session-on | tee "$EV/dial-session.log"
$D put "$E2E_WORK/dial-install.zip"
$D ps install-build.ps1 'Zip=Downloads\dial-install.zip' | tee "$EV/dial-install.log"
```

Install C's staging desktop app the way a person does (C4.8, staging): `RUN_TIMEOUT=330 $D run start-app.ps1 'Path=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe' "ArgumentList=[\"-NoProfile\",\"-EncodedCommand\",\"<b64 of: irm https://cdn.autonomous.ai/harness/staging/desktop/install.ps1 | iex>\"]" WaitSec=300`, exactly as C5.2 Step 8b builds it. **Person:** sign in to Harness in the app (Google), as in C5.2.

Pass: `dial-users.log` shows `hxdial` in `Users`, not `Administrators`; `dial-install.log` ends with `install.ps1 exited 0` and `0.9.0-dev.dial1`; the app shows the workspace (screenshot `dial-signed-in`).

**Order.** The app restarts a daemon it finds gone within 5 s, and that daemon takes the dial. So the scenarios that stop
the daemon or hold the port run with the app quit (Steps 5 to 8); the numbering stays the spec's.

- [ ] **Step 2: Scenario 1, plug in with the daemon running**

The dial must arrive after the daemon. **Person:** unplug the dial. Then:

```bash
$D stamp "s1 unplugged" | tee -a "$E2E_WORK/times.log"
$D ps dial-state.ps1 | tee "$EV/dial-s1-before.log"
```

**Person:** plug it in, and say when. `$D stamp "s1 plugged"`; then `$D ps dial-state.ps1` every 2 s, for up to 20 s, until a device shows `attached=True`; `$D stamp "s1 attached"`, and keep that last output as `dial-s1-after.log`. Open the Devices tab (`$D run uia.ps1 Find=Devices Do=Invoke`, else **Person**) and `$D shot dial-s1-devices`. **Person:** photograph the dial showing this PC's agents.

Pass:
- before: no attached device, and `harness-serial processes of this user: 1` (the watch);
- after: `attached=True fw=<v>`, `processes: 2`, at most 5 s after `s1 plugged`; the Devices tab lists the dial as Connected;
- a second dial, if one is at hand: `devices=2`, `processes: 3` (Review Focus 5); else the doc says "not run: one dial".

- [ ] **Step 3: Scenario 3, the Devices tab**

In the Devices tab, change one setting the dial reports (its brightness or its face) and apply a pet: **UIA** where the controls have names, else **Person**. Then `$D ps dial-state.ps1 | tee "$EV/dial-s3.log"` and `$D shot dial-s3-devices`.

Pass: the dial's screen shows the change and the pet (**Person**); `dial-s3.log` still shows `attached=True` and the same `settings=` names; `dial-s3-devices.png` shows the tab with no Mac wording.

- [ ] **Step 4: Quit the app**

**Person** (or **UIA**, as C5.2 drives the tray): quit Harness from its tray icon. The daemon keeps running; `$D ps dial-state.ps1` still shows `attached=True`.

- [ ] **Step 5: Scenario 2, opening does not reset**

E1.3 measured an open with no daemon. Now across two daemon restarts in the desktop session:

```bash
$D ps dial-state.ps1 | tee "$EV/dial-s2.log"
for i in 1 2; do
  $D run harness-cli.ps1 'Arguments=["stop"]' | tee -a "$EV/dial-s2.log"; sleep 5
  $D run harness-cli.ps1 'Arguments=["start"]' | tee -a "$EV/dial-s2.log"; sleep 75
  $D ps dial-state.ps1 | tee -a "$EV/dial-s2.log"
done
```

Pass: the `alive up=<s>` values only grow, across both restarts; each restart reattaches (`attached=True`).

- [ ] **Step 6: Scenario 4, unplug and replug**

```bash
session() { $D admin serial-check.ps1 WatchOnly=true | grep '^session:'; }
session | tee "$EV/dial-s4.log"
$D sh-admin 'pnputil /enum-devices /connected' | grep -i -B2 -A4 'VID_303A&PID_1001' | sed -E 's/(28:84:85):[0-9A-F:]+/\1:.../' | tee -a "$EV/dial-s4.log"
```

Restart the composite device by its instance id from that listing (`USB\VID_303A&PID_1001\<serial>`): `$D sh-admin 'pnputil /restart-device "<id>"'`. Poll `dial-state.ps1` every 2 s until `attached=True`, then `session | tee -a`. Then **Person:** pull the cable by hand, wait 5 s, plug it back; the same polling, then `session | tee -a`.

Pass: after the restart and after the hand replug, the dial is back within 5 s and `session` differs from the one before; the daemon answers throughout. (That a reset or a reflash leaves `session` as it was is checked in Step 9, around the app's flash.)

- [ ] **Step 7: Scenario 5, a port another program holds**

```bash
$D run harness-cli.ps1 'Arguments=["stop"]'
NO_WAIT=1 $D run hold-port.ps1 Port=COM3 Seconds=40
sleep 3
$D run harness-cli.ps1 'Arguments=["start"]'
sleep 20; $D ps dial-state.ps1 | tee "$EV/dial-s5-held.log"
sleep 30; $D ps dial-state.ps1 | tee "$EV/dial-s5-free.log"
```

Pass: while held, no attached device, and one (only one) `cable: COM3 is in use by another program — leaving it alone`; once released, `attached=True` within 10 s.

- [ ] **Step 8: Scenario 6, firmware over the cable**

Pick the release before the newest: list the firmware bucket the flasher downloads from (`gcloud storage ls gs://s3-autonomous-upgrade-3/harness/esp32/bin/`, read only) and take the newest name below the manifest's `commander` version. Then, in the session (the flasher stops and starts this session's daemon):

```bash
$D ps dial-state.ps1 | tee "$EV/dial-s6.log"
RUN_TIMEOUT=600 $D run harness-cli.ps1 'Arguments=["flash","--version","<older>"]' | tee -a "$EV/dial-s6.log"
```

The `--version` note ("bypasses the manifest …") is expected. Then `dial-state.ps1` every 10 s for up to 5 minutes, appended.

Pass: `fw=<older>`, then `updating=<newest>`, then `fw=<newest>` with `attached=True`; the dial log has the transfer's `cable:` lines; the dial shows the update (**Person**).

- [ ] **Step 9: Scenario 7, flash from the app**

Start the app again (`$D run start-app.ps1 'Path=%LOCALAPPDATA%\Programs\Harness\Harness.exe'`). `session | tee "$EV/dial-s7.log"`. Open Flash firmware (the in-window menu, or About's Flash button) by **UIA**, else **Person**; `$D shot dial-s7-probe`. Press Flash; `$D shot dial-s7-flashing` during `write app` and `$D shot dial-s7-done` after. `session | tee -a "$EV/dial-s7.log"`.

Pass:
- the probe finds COM3 by `in use by Harness (a dial, by its USB id)`, since the daemon holds it;
- the run stops Harness, asks the chip (`COM3 → ESP32-S3`), writes, and prints `running <newest> ✓`;
- the daemon is back with `attached=True` within 15 s;
- the dialog says "this computer", not "this Mac";
- `session` is the same before and after: a reset and a reflash leave the attachment as it was.

- [ ] **Step 10: Scenario 8, cancel a flash**

Start Flash again and press Cancel during `write app`; `$D shot dial-s8-cancelled`; then `dial-state.ps1` every 2 s for 20 s.

Pass: the run ends within 2 s of Cancel with the cancelled message; 15 s later no `esptool` and only the daemon's `harness-serial` processes of this user run; the daemon is back (`attached=True`) within 10 s. A cancelled write can leave the dial without an app image: flash it once more from the app; that must succeed and the dial must run the newest release.

- [ ] **Step 11: Scenario 9, two users**

```bash
E2E_USER=hxdial2 $D user-add | tee -a "$EV/dial-users.log"
```

**Person:** Switch user to `hxdial2` (its password from `users.txt`). As `hxdial2`: `$D put` and `install-build.ps1` (Step 0's zip) and `harness-cli.ps1 'Arguments=["start"]'` in its session. Then `E2E_USER=hxdial $D ps dial-state.ps1` and `E2E_USER=hxdial2 $D ps dial-state.ps1` into `dial-s9-second.log`. **Person:** switch back to `hxdial`; the same two reads into `dial-s9-back.log`.

Pass: with `hxdial2` at the screen, its daemon has `attached=True` and `hxdial`'s has none, with one `cable: USB belongs to the account at this computer's screen — releasing this connection`; after switching back, the reverse; each within 10 s.

- [ ] **Step 12: Scenario 10, the cost at rest**

As `hxdial`, at the screen, with the app quit (as Step 4): read CPU time and working set of this user's `node` (the daemon) and `harness-serial` at the start and after 10 minutes with the dial plugged in, then again with it unplugged (**Person**):

```bash
$D sh "powershell -NoProfile -Command \"Get-Process node,harness-serial -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like (\$env:USERPROFILE + '\\*') } | Select-Object Name,Id,CPU,WS | Format-Table -AutoSize\"" | tee -a "$EV/dial-s10.log"
```

Pass: recorded for both runs: CPU seconds used over the 10 minutes and the working set, per process. No threshold (spec, Testing); a number that looks wrong is a finding, looked into before E5 ends.

- [ ] **Step 13: Scenario 11, uninstall**

For each test user: `$D run harness-cli.ps1 'Arguments=["uninstall","--yes"]'`, then `$D ps dial-state.ps1`, then `$D sh "powershell -NoProfile -Command \"@(Get-ChildItem \$env:USERPROFILE\.harness -Recurse -Filter harness-serial.exe -ErrorAction SilentlyContinue).Count\""`.

Pass: `uninstall … exited 0`; `harness-serial processes of this user: 0`; `0` files; the dial goes back to its waiting screen (**Person**).

- [ ] **Step 14: Clean up, and the doc**

```bash
$D cleanup hxdial2 | tee "$EV/dial-cleanup.log"
$D cleanup hxdial | tee -a "$EV/dial-cleanup.log"
```

Remove E1.3's key line (or the file, if E1.3 recorded `file existed before: False`), by the same `expect` route E1.3 used, with the owner's password typed again:

```powershell
$f = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$k = '<the Mac key line>'
if (Test-Path -LiteralPath $f) { $rest = @(Get-Content -LiteralPath $f | Where-Object { $_ -ne $k }); if ($rest.Count) { Set-Content -LiteralPath $f -Value $rest -Encoding ascii } else { Remove-Item -LiteralPath $f } }
```

(remove the file only if E1.3 created it). Then `ssh -o BatchMode=yes "$VM_ADMIN@$VM_HOST" whoami` must fail.

Write `docs/testing/windows-dial-e2e.md` with the sections in **Produces**, a row per scenario in the summary table (pass, or what failed and the fix's commit), and the timings. Shorten every serial to `28:84:85:…`; no address, account or password.

```bash
git add docs/testing/windows-dial-e2e.md desktop/scripts/windows-e2e/evidence/dial-*
git commit -m "test(windows): the dial on Windows, eleven scenarios on the x64 test PC" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task E5.3: The spec's status and the CLI's guide

**Files:**
- Modify: `docs/superpowers/specs/2026-10-19-windows-dial-design.md` (Status, findings, any limit E5 found), `cli/AGENTS.md` (the devices row)

- [ ] **Step 1: Write it**

- Spec: `Status: implemented on feat/windows-dial; E2E in docs/testing/windows-dial-e2e.md; ships in combined Windows PR (feat/windows-desktop → main)`. Under Known limits, add each limit E5 found that was not fixed, one line each.
- `cli/AGENTS.md`, the processes table's `devices` row, the Runs column: "…, the Wi-Fi device; on Windows the dial's port through `harness-serial.exe` (`cable/windowsSerial.ts`)".

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-19-windows-dial-design.md cli/AGENTS.md
git commit -m "docs(windows): the dial on Windows is implemented; its E2E and limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## After E

E ships in the combined Windows PR, `feat/windows-desktop` → `main`, per the owner's 2026-10-20 update. When E5.2, E5.3 and the final review are done, report back; the owner's session will merge `feat/windows-dial` into `feat/windows-desktop`. Do not perform that merge yourself. F takes only E1.3's immutable, test-tooling-only kit commit `7ee856dd9` by cherry-pick; no rebase onto E is assumed.

- The combined Windows PR owns its TEMPORARY trigger cleanup under its handoff's "Shipping Windows" instructions, including E's workflow triggers.
- The final whole-branch review before reporting E ready for the owner's merge weighs E's seams: `serial.ts` ↔ `windowsSerial.ts` ↔ `harness-serial`, the payload's sixth file, and `flash-circle.ps1` ↔ `flash-circle.sh`.
- After the combined Windows PR merges, at the owner's go: promote E's CLI payload carrying `harness-serial.exe`, deploy the website (so `/flash-circle.ps1` is live), and optionally run `upload-flasher.sh` for the Windows esptool zip. These are E's release steps for the combined Windows release.
