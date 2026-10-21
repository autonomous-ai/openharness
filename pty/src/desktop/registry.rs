//! The keys an install writes under `HKEY_CURRENT_USER\<root>`, where `<root>` is `Software` (or the tests'
//! `HARNESS_DESKTOP_REGISTRY_ROOT`): the `harness://` scheme and the Settings ▸ Apps entry. Here they are data;
//! win.rs writes them.
//!
//! Paths go in as the OS strings they are, never through `display()` or a re-parse, and each one that a command line
//! carries is between double quotes, which a Windows path cannot contain (Review Focus 1). The shell substitutes
//! `%1` in the open command; a profile folder whose name holds `%` followed by a digit, `*` or `~` would be read as
//! another argument by Explorer, which has no escape for it (a known limit).

use std::ffi::OsString;
use std::path::Path;

use super::{DISPLAY_NAME, PUBLISHER};

pub const SCHEME: &str = "harness";
pub const UNINSTALL_KEY: &str = r"Microsoft\Windows\CurrentVersion\Uninstall\Harness";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// REG_SZ.
    Text(OsString),
    /// REG_DWORD.
    Number(u32),
}

/// A key, relative to the registry root, and its values; the name "" is the key's default value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub path: String,
    pub values: Vec<(String, Value)>,
}

pub fn protocol_key(scheme: &str) -> String {
    format!(r"Classes\{scheme}")
}

pub fn protocol_command_key(scheme: &str) -> String {
    format!(r"Classes\{scheme}\shell\open\command")
}

fn quoted(path: &Path) -> OsString {
    let mut text = OsString::from("\"");
    text.push(path.as_os_str());
    text.push("\"");
    text
}

fn text(value: impl Into<OsString>) -> Value {
    Value::Text(value.into())
}

/// `"<launcher>" "%1"`: the link as the launcher's one argument.
pub fn open_command(launcher: &Path) -> OsString {
    let mut command = quoted(launcher);
    command.push(" \"%1\"");
    command
}

/// `<scheme>://` opening [launcher]. The tests register a scheme of their own; the app's is [SCHEME].
pub fn protocol_keys(scheme: &str, launcher: &Path) -> Vec<Key> {
    vec![
        Key {
            path: protocol_key(scheme),
            values: vec![
                (String::new(), text(format!("URL:{DISPLAY_NAME}"))),
                ("URL Protocol".to_owned(), text("")),
            ],
        },
        Key {
            path: protocol_command_key(scheme),
            values: vec![(String::new(), Value::Text(open_command(launcher)))],
        },
    ]
}

/// The Settings ▸ Apps entry for the install at [install], showing [icon].
pub fn uninstall_keys(install: &Path, version: &str, icon: &Path) -> Vec<Key> {
    let mut uninstall = quoted(&install.join(super::LAUNCHER_EXE));
    uninstall.push(" --uninstall");
    let mut display_icon = icon.as_os_str().to_owned();
    display_icon.push(",0");
    vec![Key {
        path: UNINSTALL_KEY.to_owned(),
        values: vec![
            ("DisplayName".to_owned(), text(DISPLAY_NAME)),
            ("DisplayVersion".to_owned(), text(version)),
            ("Publisher".to_owned(), text(PUBLISHER)),
            ("InstallLocation".to_owned(), text(install.as_os_str())),
            ("DisplayIcon".to_owned(), Value::Text(display_icon)),
            ("UninstallString".to_owned(), Value::Text(uninstall)),
            ("NoModify".to_owned(), Value::Number(1)),
            ("NoRepair".to_owned(), Value::Number(1)),
        ],
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Review Focus 1: a profile with a space, an apostrophe, `&`, `%`, `!` and letters outside ASCII.
    const PROFILE: &str = "/Users/Nguyễn Văn A' & 100% !x";

    fn value<'a>(keys: &'a [Key], path: &str, name: &str) -> &'a Value {
        let key = keys.iter().find(|key| key.path == path).unwrap();
        &key.values.iter().find(|(n, _)| n == name).unwrap().1
    }

    #[test]
    fn the_harness_scheme_opens_the_launcher_with_the_link_as_one_argument() {
        let launcher = PathBuf::from(format!("{PROFILE}/Programs/Harness/Harness.exe"));
        let keys = protocol_keys(SCHEME, &launcher);
        assert_eq!(value(&keys, r"Classes\harness", "URL Protocol"), &text(""));
        assert_eq!(value(&keys, r"Classes\harness", ""), &text("URL:Harness"));
        assert_eq!(
            value(&keys, r"Classes\harness\shell\open\command", ""),
            &text(format!("\"{PROFILE}/Programs/Harness/Harness.exe\" \"%1\""))
        );
    }

    #[test]
    fn the_uninstall_entry_has_every_value_settings_reads() {
        let install = PathBuf::from(format!("{PROFILE}/Programs/Harness"));
        let icon = install.join("Harness.ico");
        let keys = uninstall_keys(&install, "1.2.3", &icon);
        let at = |name| value(&keys, UNINSTALL_KEY, name);
        assert_eq!(at("DisplayName"), &text("Harness"));
        assert_eq!(at("DisplayVersion"), &text("1.2.3"));
        assert_eq!(at("Publisher"), &text("Autonomous"));
        assert_eq!(
            at("InstallLocation"),
            &text(format!("{PROFILE}/Programs/Harness"))
        );
        assert_eq!(at("DisplayIcon"), &text(format!("{},0", icon.display())));
        let launcher = install.join("Harness.exe");
        assert_eq!(
            at("UninstallString"),
            &text(format!("\"{}\" --uninstall", launcher.display()))
        );
        assert_eq!(at("NoModify"), &Value::Number(1));
        assert_eq!(at("NoRepair"), &Value::Number(1));
        assert_eq!(keys[0].values.len(), 8);
    }
}
