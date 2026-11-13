#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn a_status_line_needs_attached() {
        let status: DialStatus =
            serde_json::from_str(r#"{"attached":true,"fw":"0.0.95","settings":{}}"#).unwrap();
        assert_eq!(
            status,
            DialStatus {
                attached: true,
                fw: Some("0.0.95".into()),
                hw: None,
                board: None,
                updating: None,
                problem: None,
            }
        );
        for line in [r#"{}"#, r#"{"error":"x"}"#, r#"{"attached":"yes"}"#] {
            assert!(serde_json::from_str::<DialStatus>(line).is_err(), "{line}");
        }
    }

    #[test]
    fn a_view_is_the_json_the_window_reads() {
        let view = View { screen: Screen::SignIn, phase: Phase::Browser, lines: vec!["Waiting".into()] };
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            json!({"screen":"sign_in","phase":"browser","lines":["Waiting"]})
        );
    }

    #[test]
    fn the_window_may_ask_six_things() {
        let asks = [
            ("retry", Action::Retry),
            ("sign_in", Action::SignIn),
            ("later", Action::Later),
            ("cancel", Action::Cancel),
            ("turn_on", Action::TurnOn),
            ("not_now", Action::NotNow),
        ];
        for (name, action) in asks {
            assert_eq!(serde_json::from_value::<Action>(json!(name)).unwrap(), action);
        }
        for other in [json!("quit"), json!("sh -c x"), json!(1), Value::Null] {
            assert!(serde_json::from_value::<Action>(other.clone()).is_err(), "{other}");
        }
    }

    #[test]
    fn state_json_keys() {
        let keys = json!({"version":1,"cliSeen":false,"askedSignIn":false,"askedClaude":false,"loginItem":false});
        assert_eq!(serde_json::to_value(Saved::default()).unwrap(), keys);
        assert_eq!(serde_json::from_value::<Saved>(keys).unwrap(), Saved::default());
    }

    #[test]
    fn claude_status_reads_camel_case() {
        let status: ClaudeStatus = serde_json::from_str(
            r#"{"supported":true,"installed":true,"enabled":false,"claudeVersion":"2.1.0"}"#,
        )
        .unwrap();
        assert_eq!(
            status,
            ClaudeStatus { supported: true, installed: true, enabled: false, claude_version: Some("2.1.0".into()) }
        );
        assert_eq!(serde_json::from_str::<ClaudeStatus>("{}").unwrap(), ClaudeStatus::default());
    }

    #[test]
    fn the_window_is_small_fixed_and_hidden() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], "ai.autonomous.harness.device");
        assert_eq!(config["productName"], "Harness Device");
        assert_eq!(config["build"]["frontendDist"], "../ui/dist");
        assert_eq!(config["app"]["security"]["csp"], "default-src 'self'; connect-src ipc: http://ipc.localhost");
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        let window = &windows[0];
        assert_eq!(window["label"], "main");
        assert_eq!(window["title"], "Harness Device");
        assert_eq!((window["width"].as_f64(), window["height"].as_f64()), (Some(420.0), Some(320.0)));
        assert_eq!(window["resizable"], false);
        assert_eq!(window["center"], true);
        assert_eq!(window["visible"], false);
    }

    #[test]
    fn the_webview_may_call_two_commands() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(
            capability["permissions"],
            json!(["core:event:allow-listen", "core:event:allow-unlisten", "allow-view", "allow-act"])
        );
        assert!(!include_str!("../Cargo.toml").contains("tauri-plugin"));
    }

    #[test]
    fn the_bundle_asks_for_the_local_network() {
        // One line per tag, so the plist's indentation does not matter.
        let plist: String = include_str!("../Info.plist").lines().map(str::trim).collect();
        for entry in [
            "<key>NSLocalNetworkUsageDescription</key>\
             <string>Harness finds and connects to Autonomous robots on your local network.</string>",
            "<key>NSBonjourServices</key><array><string>_autonomous._tcp</string></array>",
            "<key>LSUIElement</key><true/>",
        ] {
            assert!(plist.contains(entry), "{entry}");
        }
    }
}
