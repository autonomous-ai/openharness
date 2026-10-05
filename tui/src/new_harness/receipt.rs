//! Creation receipts distinguish a refused launch from a lost answer. Follow the
//! same contract as desktop's AgentCreationAttempt and daemon AgentCreationReceipts.
use crate::daemon::RpcError;
use serde_json::Value;

#[derive(Clone)]
pub(crate) struct Creation {
    pub id: String,
    pub machine: String,
    pub session: u32,
    pub target: Option<crate::input::LaunchTarget>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Created,
    Failed {
        message: String,
        prepared_folder: Option<String>,
    },
    Uncertain(String),
}

fn uncertain() -> Outcome {
    Outcome::Uncertain("Launch not confirmed. Check status before starting another.".into())
}
fn failed(code: &str, detail: Option<&str>, prepared_folder: Option<String>) -> Outcome {
    Outcome::Failed {
        message: format!(
            "Could not start it: {}",
            detail.filter(|s| !s.is_empty()).unwrap_or(code)
        ),
        prepared_folder,
    }
}

pub fn outcome(id: &str, reply: &Result<Value, RpcError>, checking: bool) -> Outcome {
    let value = match reply {
        Ok(value) => value,
        Err(error) => {
            // Only explicit refusals before launch can unlock the form. An error
            // from a status check says nothing about the original launch.
            if !checking
                && matches!(
                    error.code.as_str(),
                    "INVALID_PROJECT_SOURCE"
                        | "INVALID_REPOSITORY"
                        | "PROJECT_EXISTS"
                        | "CWD_NOT_FOUND"
                        | "INVALID_CWD"
                        | "INVALID_ENGINE"
                        | "INVALID_GRID"
                        | "GRID_UNAVAILABLE"
                        | "INVALID_CODEX_HOME"
                        | "INVALID_DSH"
                        | "PROMPT_UNSUPPORTED"
                        | "PROMPT_TOO_LONG"
                        | "INVALID_PROMPT"
                        | "AGENT_UNSUPPORTED"
                        | "INVALID_AGENT"
                        | "INVALID_PERMISSION_MODE"
                        | "TMUX_UNAVAILABLE"
                        | "CODEX_CLI_TOO_OLD"
                        | "TMUX_TOO_OLD_FOR_GRID"
                        | "GRID_CONFIG_FAILED"
                        | "UNSUPPORTED_ON_REMOTE"
                        | "UNSUPPORTED"
                        | "SESSION_OPEN_ELSEWHERE"
                        | "SESSION_IN_HARNESS"
                        | "SESSION_NOT_FOUND"
                        | "SESSION_FOLDER_GONE"
                        | "SESSION_OPEN_IN_TERMINAL"
                        | "SESSION_BUSY_IN_TERMINAL"
                        | "SESSION_STOP_FAILED"
                        | "INVALID_SESSION"
                )
            {
                return failed(&error.code, Some(&error.detail), None);
            }
            return uncertain();
        }
    };
    if (checking || value.get("creationId").is_some() || value.get("state").is_some())
        && value["creationId"].as_str() != Some(id)
    {
        return uncertain();
    }
    match value["state"].as_str() {
        Some("failed") => {
            let Some(code) = value
                .pointer("/failure/code")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return uncertain();
            };
            let prepared_folder = match value.get("preparedFolder") {
                None => None,
                Some(Value::String(path))
                    if path.starts_with('/') && !path.chars().any(char::is_control) =>
                {
                    Some(path.clone())
                }
                _ => return uncertain(),
            };
            failed(
                code,
                value.pointer("/failure/detail").and_then(Value::as_str),
                prepared_folder,
            )
        }
        Some("pending") => {
            Outcome::Uncertain("Still starting your harness. Check again in a moment.".into())
        }
        Some("missing") => {
            Outcome::Uncertain("No record of this launch. Use Open Harness to look for it.".into())
        }
        Some("unconfirmed") => {
            Outcome::Uncertain("Launch outcome unknown. Use Open Harness to look for it.".into())
        }
        Some("unavailable") => Outcome::Failed {
            message: "This harness started but is no longer available. You can start a new one."
                .into(),
            prepared_folder: None,
        },
        Some("created") | None
            if value
                .pointer("/agent/id")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()) =>
        {
            Outcome::Created
        }
        _ => uncertain(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn confirmed_refusal_unlocks_retry_and_keeps_the_prepared_folder() {
        let reply = Ok(
            json!({"creationId":"intent", "state":"failed", "failure":{"code":"ENGINE_UNAVAILABLE", "detail":"Sign in first"}, "preparedFolder":"/projects/prepared"}),
        );
        assert_eq!(
            outcome("intent", &reply, false),
            Outcome::Failed {
                message: "Could not start it: Sign in first".into(),
                prepared_folder: Some("/projects/prepared".into())
            }
        );
        // The same persisted failure discovered after reconnect is also definitive.
        assert_eq!(
            outcome("intent", &reply, true),
            outcome("intent", &reply, false)
        );
        assert!(matches!(
            outcome(
                "intent",
                &Err(RpcError::new("INVALID_DSH", "Install first")),
                false
            ),
            Outcome::Failed { .. }
        ));
    }

    #[test]
    fn ambiguous_results_never_allow_a_fresh_launch() {
        for state in ["missing", "pending", "unconfirmed", "unexpected"] {
            assert!(matches!(
                outcome(
                    "intent",
                    &Ok(json!({"creationId":"intent", "state":state})),
                    true
                ),
                Outcome::Uncertain(_)
            ));
        }
        for code in [
            "TIMEOUT",
            "DISCONNECTED",
            "INTERNAL",
            "SPAWN_FAILED",
            "REGISTRATION_FAILED",
            "CREATION_STORAGE_FAILED",
        ] {
            assert!(matches!(
                outcome("intent", &Err(RpcError::new(code, "")), false),
                Outcome::Uncertain(_)
            ));
        }
        assert!(matches!(
            outcome("intent", &Err(RpcError::new("INVALID_DSH", "")), true),
            Outcome::Uncertain(_)
        ));
    }

    #[test]
    fn recovery_requires_the_original_receipt_and_an_agent() {
        let created = json!({"creationId":"intent", "state":"created", "agent":{"id":"one"}});
        assert_eq!(
            outcome("intent", &Ok(created.clone()), true),
            Outcome::Created
        );
        assert!(matches!(
            outcome("another", &Ok(created), true),
            Outcome::Uncertain(_)
        ));
        assert!(matches!(
            outcome(
                "intent",
                &Ok(json!({"creationId":"intent", "state":"created"})),
                false
            ),
            Outcome::Uncertain(_)
        ));
        assert!(matches!(
            outcome(
                "intent",
                &Ok(json!({"creationId":"intent", "state":"failed"})),
                false
            ),
            Outcome::Uncertain(_)
        ));
        // Older daemons can answer an initial create without receipts, but a status
        // answer must always identify the request it describes.
        let legacy = Ok(json!({"agent":{"id":"one"}}));
        assert_eq!(outcome("intent", &legacy, false), Outcome::Created);
        assert!(matches!(
            outcome("intent", &legacy, true),
            Outcome::Uncertain(_)
        ));
    }
}
