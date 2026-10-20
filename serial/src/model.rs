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
        Some(n) => {
            (1..=3).contains(&n.len())
                && !n.starts_with('0')
                && n.bytes().all(|b| b.is_ascii_digit())
        }
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
        serde_json::to_string(&State {
            console: self.console,
            ports,
        })
        .expect("a state serializes")
    }
}

fn com_number(path: &str) -> u32 {
    path.get(3..)
        .and_then(|n| n.parse().ok())
        .unwrap_or(u32::MAX)
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

/// DCB's bit field for the dial: fBinary only; DTR_CONTROL_DISABLE and RTS_CONTROL_DISABLE release both lines.
///
/// E1.3 on the test PC (2026-10-20): asserted lines (0x1011) received ESP-ROM on two opens. The first released-lines
/// read also contained ESP-ROM; the next three did not, including the final consecutive pair. All held 10 s and
/// kept their USB attachment session. These observations select the planned fallback without identifying the
/// reset edge or the first banner's origin; screen observation and heartbeat checks remain for E5.
pub const DCB_RAW: u32 = 1;

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
        assert_eq!(
            parse(&args(&["open", "com3"])),
            Ok(Command::Open("COM3".into()))
        );
        assert_eq!(
            parse(&args(&["probe", "COM12"])),
            Ok(Command::Probe("COM12".into()))
        );
        for bad in [
            &[][..],
            &["open"][..],
            &["open", "COM3", "x"][..],
            &["open", r"\\.\COM3"][..],
            &["open", "NUL"][..],
            &["serve"][..],
        ] {
            assert_eq!(parse(&args(bad)), Err(USAGE.to_string()), "{bad:?}");
        }
    }

    #[test]
    fn a_com_name_is_com_and_one_to_three_digits_without_a_leading_zero() {
        for good in ["COM1", "com9", "COM10", "COM256"] {
            assert!(is_com_name(good), "{good}");
        }
        for bad in [
            "COM", "COM0", "COM01", "COM1000", "COM1a", "LPT1", "COM3:", "C:\\COM3", "",
        ] {
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
        assert!(is_dial_interface(
            r"USB\VID_303A&PID_1001&MI_00\6&106766F5&0&0000"
        ));
        assert!(is_dial_interface(r"usb\vid_303a&pid_1001&mi_00\6&1&0&0000"));
        assert!(!is_dial_interface(
            r"USB\VID_303A&PID_1001&MI_02\6&106766F5&0&0002"
        )); // the JTAG interface
        assert!(!is_dial_interface(
            r"USB\VID_303A&PID_1001\28:84:85:00:00:01"
        )); // the composite device
        assert!(!is_dial_interface(r"USB\VID_10C4&PID_EA60\0001")); // another USB-serial chip
        assert_eq!(
            serial_from_parent(r"USB\VID_303A&PID_1001\28:84:85:00:00:01"),
            Some("28:84:85:00:00:01".into())
        );
        // Windows makes up an id with `&` for a device that reports no serial number.
        assert_eq!(
            serial_from_parent(r"USB\VID_303A&PID_1001\6&2F1A9C&0&1"),
            None
        );
        assert_eq!(serial_from_parent(r"USB\VID_303A&PID_1001\"), None);
        assert_eq!(serial_from_parent(r"USB\ROOT_HUB30\4&1&0&0"), None);
    }

    // Review Focus 5 and 2: two dials in one line, COM9 before COM10, unknown fields left out.
    #[test]
    fn the_state_line_lists_ports_in_com_number_order_and_omits_what_is_unknown() {
        let state = State {
            console: true,
            ports: vec![
                Port {
                    path: "COM10".into(),
                    serial_number: Some("28:84:85:00:00:02".into()),
                    session: Some("2".into()),
                },
                Port {
                    path: "COM9".into(),
                    serial_number: None,
                    session: None,
                },
            ],
        };
        assert_eq!(
            state.line(),
            r#"{"console":true,"ports":[{"path":"COM9"},{"path":"COM10","serialNumber":"28:84:85:00:00:02","session":"2"}]}"#
        );
        assert_eq!(
            State {
                console: false,
                ports: vec![]
            }
            .line(),
            r#"{"console":false,"ports":[]}"#
        );
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
    fn the_dcb_is_binary_with_dtr_and_rts_released_and_no_flow_control() {
        // fBinary (bit 0) only: DTR/RTS disabled, with no parity check, CTS/DSR/XON flow control or abort on error.
        assert_eq!(DCB_RAW, 0x1);
    }

    #[test]
    fn version_names_the_protocol() {
        assert_eq!(
            version_line(),
            format!(r#"{{"version":"{VERSION}","protocol":1}}"#)
        );
    }
}
