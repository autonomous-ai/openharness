//! `tests/fixtures/ops.json` is one request per op, with every field set to a value that is not
//! its default. `cli/src/lib/ptyHost/protocol.spec.ts` checks the same file against the
//! TypeScript `PtyOp`, so the two sides cannot drift apart on an op or field name.

use std::collections::{BTreeSet, HashMap};

use harness_pty::protocol::{AfterExit, Op, Request};
use serde_json::Value;

fn fixture() -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ops.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn env(v: &Value) -> HashMap<String, String> {
    serde_json::from_value(v.clone()).unwrap()
}

fn after_exit(v: &Value) -> Option<AfterExit> {
    Some(AfterExit {
        command: serde_json::from_value(v["command"].clone()).unwrap(),
        env: env(&v["env"]),
    })
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

/// serde skips a field it does not know, so a misspelt optional field would parse as `None` or
/// as its default: compare every optional or defaulted field with the fixture.
fn assert_every_field_read(op: &Op, v: &Value) {
    match op {
        Op::Create { cwd, env: e, label, after_exit: after, clear_inherited, seed, .. } => {
            assert_eq!(seed.clone(), str_of(&v["seed"]));
            assert_eq!(*after, after_exit(&v["afterExit"]));
            let cleared: Vec<String> = serde_json::from_value(v["clearInherited"].clone()).unwrap();
            assert_eq!(*clear_inherited, cleared);
            assert_eq!(cwd.clone(), str_of(&v["cwd"]));
            assert_eq!(*e, env(&v["env"]));
            assert_eq!(label.clone(), str_of(&v["label"]));
        }
        Op::Kill { grace_ms, .. } => assert_eq!(Some(*grace_ms), v["graceMs"].as_u64()),
        Op::Capture { history_lines, .. } => {
            assert_eq!(history_lines.map(u64::from), v["historyLines"].as_u64())
        }
        Op::Respawn { cwd, env: e, expected_held_token, clear_env, clear_inherited, after_exit: after, .. } => {
            assert_eq!(*after, after_exit(&v["afterExit"]));
            let inherited: Vec<String> = serde_json::from_value(v["clearInherited"].clone()).unwrap();
            assert_eq!(*clear_inherited, inherited);
            assert_eq!(cwd.clone(), str_of(&v["cwd"]));
            assert_eq!(*e, env(&v["env"]));
            assert_eq!(expected_held_token.clone(), str_of(&v["expectedHeldToken"]));
            let cleared: Vec<String> = serde_json::from_value(v["clearEnv"].clone()).unwrap();
            assert_eq!(*clear_env, cleared);
        }
        _ => {}
    }
}

#[test]
fn every_fixture_request_parses_with_every_field() {
    let entries = fixture();
    let mut seen = BTreeSet::new();
    for v in &entries {
        let r: Request = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{v}: {e}"));
        assert_eq!(Some(r.id), v["id"].as_u64());
        assert_every_field_read(&r.op, v);
        seen.insert(v["op"].as_str().unwrap().to_owned());
    }
    let all: BTreeSet<String> = [
        "create", "kill", "inventory", "titles", "paneState", "paneInfo", "capture", "write",
        "paste", "key", "setTitle", "holdOpen", "releaseHold", "respawn", "jobPids", "processes",
        "setEngineExit", "shutdown",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(seen, all, "the fixture has one request per op");
}
