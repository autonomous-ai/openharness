//! Work evidence has a finite lease. A daemon heartbeat is not, by itself,
//! evidence that its engine is still working.
use std::{collections::HashSet, time::{Duration, Instant}};
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct Activity {
    epoch: Option<String>,
    revision: u64,
    retired: HashSet<String>,
    pub unknown: bool,
    pub until: Option<Instant>,
    pub legacy_heartbeat_seen: bool,
}

impl Activity {
    pub fn reported(&self) -> bool { self.epoch.is_some() }
    pub fn older(&self, value: &Value) -> bool {
        let (Some(epoch), Some(revision)) = (value["epoch"].as_str(), value["revision"].as_u64()) else { return false };
        self.retired.contains(epoch) || (self.epoch.as_deref() == Some(epoch) && revision < self.revision)
    }
    /// None means malformed, duplicate or out of order. Some(bool) is the
    /// accepted working state; unknown does not mean a turn just completed.
    pub fn accept(&mut self, value: &Value, now: Instant) -> Option<bool> {
        let state = value["state"].as_str()?;
        if !matches!(state, "working" | "idle" | "unknown") { return None }
        let epoch = value["epoch"].as_str().filter(|s| !s.is_empty())?;
        let revision = value["revision"].as_u64()?;
        let ms = value["validForMs"].as_f64().filter(|v| v.is_finite() && *v >= 0.0)?.min(30_000.0) as u64;
        if self.retired.contains(epoch) { return None }
        if let Some(prior) = &self.epoch {
            if prior == epoch && revision <= self.revision { return None }
            if prior != epoch { self.retired.insert(prior.clone()); }
        }
        self.epoch = Some(epoch.into()); self.revision = revision;
        let working = state == "working" && ms > 0;
        self.until = working.then(|| now + Duration::from_millis(ms));
        self.unknown = state == "unknown" || (state == "working" && ms == 0);
        Some(working)
    }
    pub fn expired(&mut self, now: Instant) -> bool {
        if self.until.is_some_and(|end| now >= end) {
            self.until = None; self.unknown = true; return true
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn reading(state: &str, epoch: &str, revision: u64) -> Value {
        json!({"state":state,"epoch":epoch,"revision":revision,"validForMs":1000})
    }
    #[test]
    fn repeated_packets_cannot_renew_work_or_invent_completion() {
        let mut activity = Activity::default(); let now = Instant::now();
        let work = reading("working", "daemon", 1);
        assert_eq!(activity.accept(&work, now), Some(true));
        assert_eq!(activity.accept(&work, now + Duration::from_millis(900)), None);
        assert!(activity.expired(now + Duration::from_millis(1000))); assert!(activity.unknown);
        assert_eq!(activity.accept(&reading("working", "daemon", 2), now), Some(true));
        assert!(!activity.unknown);
    }
    #[test]
    fn old_ends_and_retired_daemons_cannot_replace_current_activity() {
        let mut activity = Activity::default(); let now = Instant::now();
        assert_eq!(activity.accept(&reading("working", "daemon", 9), now), Some(true));
        assert_eq!(activity.accept(&reading("idle", "daemon", 8), now), None);
        assert_eq!(activity.accept(&reading("unknown", "restart", 1), now), Some(false));
        assert_eq!(activity.accept(&reading("working", "daemon", 999), now), None);
        assert!(activity.unknown);
    }
    #[test]
    fn malformed_or_excessive_leases_cannot_hold_work_forever() {
        let mut activity = Activity::default(); let now = Instant::now();
        let mut value = reading("working", "daemon", 1);
        value["validForMs"] = json!(999999);
        assert_eq!(activity.accept(&value, now), Some(true));
        assert!(activity.expired(now + Duration::from_secs(30)));
        assert_eq!(activity.accept(&json!({"state":"working"}), now), None);
    }
}
