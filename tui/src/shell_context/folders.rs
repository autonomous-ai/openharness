//! Recursive candidates for the shell's fzf-style folder picker. Walk on the
//! selected computer through its existing, permission-fenced directory API.
//! Queries filter the growing catalog locally; typing never restarts the walk.
use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct Snapshot {
    pub root: Option<String>,
    pub paths: Vec<String>,
    pub notice: String,
    pub revision: u64,
}

#[derive(Clone, Copy)]
struct Limits {
    paths: usize,
    bytes: usize,
    time: Duration,
    concurrency: usize,
}
impl Default for Limits {
    fn default() -> Self {
        // Bound the retained catalog and traversal work. composition::folder_items
        // separately bounds each wire reply without cutting off later matches.
        Self {
            paths: 10_000,
            bytes: 1024 * 1024,
            time: Duration::from_secs(10),
            concurrency: 6,
        }
    }
}

pub(super) struct Scan {
    state: Arc<Mutex<Snapshot>>,
    task: tokio::task::JoinHandle<()>,
    started: Instant,
}
impl Drop for Scan {
    fn drop(&mut self) {
        // Changing folder/computer or account discards every in-flight read.
        self.task.abort();
    }
}
impl Scan {
    pub fn new(link: crate::daemon::Link, root: String, home: Option<String>) -> Self {
        Self::start(root, home, Limits::default(), move |path| {
            let link = link.clone();
            async move {
                link.rpc("fs_list_dir", json!({"path":path}), Duration::from_secs(5))
                    .await
                    .map_err(|_| ())
            }
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap().clone()
    }
    pub fn expired(&self) -> bool {
        self.started.elapsed() > Duration::from_secs(30) && self.task.is_finished()
    }

    fn start<F, Fut>(root: String, home: Option<String>, limits: Limits, read: F) -> Self
    where
        F: Fn(String) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value, ()>> + Send + 'static,
    {
        let state = Arc::new(Mutex::new(Snapshot {
            root: None,
            paths: Vec::new(),
            notice: "Searching folders…".into(),
            revision: 0,
        }));
        let output = state.clone();
        let task = tokio::spawn(async move {
            let mut walk = Walk::new(limits, home);
            let mut queue = VecDeque::from([root]);
            let mut active = FuturesUnordered::new();
            let deadline = tokio::time::Instant::now() + limits.time;
            loop {
                while active.len() < limits.concurrency {
                    let Some(path) = queue.pop_front() else { break };
                    let reading = read(path.clone());
                    active.push(async move { (path, reading.await) });
                }
                if active.is_empty() {
                    break;
                }
                let next = tokio::time::timeout_at(deadline, active.next()).await;
                let Ok(Some((requested, value))) = next else {
                    walk.limited = true;
                    break;
                };
                let mut snapshot = output.lock().unwrap();
                walk.add(&requested, value, &mut snapshot, &mut queue);
                snapshot.revision += 1;
                if walk.full {
                    break;
                }
            }
            let mut snapshot = output.lock().unwrap();
            snapshot.notice = if snapshot.root.is_none() {
                "Could not read that folder. Alt+Up goes back."
            } else if walk.limited {
                "Search limited. Enter a folder to narrow it."
            } else if walk.unreadable {
                "Some folders could not be read."
            } else {
                ""
            }
            .into();
            snapshot.revision += 1;
        });
        Self {
            state,
            task,
            started: Instant::now(),
        }
    }
}

struct Walk {
    limits: Limits,
    home: Option<String>,
    seen: HashSet<String>,
    bytes: usize,
    full: bool,
    limited: bool,
    unreadable: bool,
}
impl Walk {
    fn new(limits: Limits, home: Option<String>) -> Self {
        Self {
            limits,
            home,
            seen: HashSet::new(),
            bytes: 0,
            full: false,
            limited: false,
            unreadable: false,
        }
    }
    fn insert(&mut self, path: String, snapshot: &mut Snapshot) -> bool {
        if self.seen.contains(&path) {
            return false;
        }
        if snapshot.paths.len() >= self.limits.paths || self.bytes + path.len() > self.limits.bytes
        {
            self.full = true;
            self.limited = true;
            return false;
        }
        self.bytes += path.len();
        self.seen.insert(path.clone());
        snapshot.paths.push(path);
        true
    }
    fn add(
        &mut self,
        requested: &str,
        value: Result<Value, ()>,
        snapshot: &mut Snapshot,
        queue: &mut VecDeque<String>,
    ) {
        let Ok(value) = value else {
            self.unreadable = true;
            return;
        };
        let Some(path) = value["path"].as_str().filter(|s| valid_path(s)) else {
            self.unreadable = true;
            return;
        };
        if snapshot.root.is_none() {
            snapshot.root = Some(path.into());
            self.insert(path.into(), snapshot);
        } else if path != requested {
            // A reply must describe the folder asked for, never another tree.
            self.unreadable = true;
            return;
        }
        self.limited |= value["truncated"] == true;
        for name in value["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry["isDir"] == true)
            .filter_map(|entry| entry["name"].as_str())
            .filter(|name| valid_name(name))
        {
            let child = format!("{}/{name}", path.trim_end_matches('/'));
            if !valid_path(&child) {
                self.limited = true;
                continue;
            }
            if self.insert(child.clone(), snapshot) && descend(name, &child, self.home.as_deref()) {
                queue.push_back(child);
            }
            if self.full {
                break;
            }
        }
    }
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() <= 4096 && !path.chars().any(char::is_control)
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.chars().any(char::is_control)
}
fn descend(name: &str, path: &str, home: Option<&str>) -> bool {
    // Show these folders, but only walk their contents when explicitly entered.
    // Otherwise dependency/build trees and macOS app data bury actual projects.
    ![
        "node_modules",
        "target",
        "dist",
        "build",
        "vendor",
        "venv",
        "__pycache__",
    ]
    .contains(&name)
        && ![".app", ".framework", ".bundle", ".photoslibrary"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        && !(name == "Library"
            && home.is_some_and(|home| path == format!("{}/Library", home.trim_end_matches('/'))))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn listing(path: &str, names: &[&str]) -> Result<Value, ()> {
        Ok(
            json!({"path":path,"entries":names.iter().map(|name|json!({"name":name,"isDir":true})).collect::<Vec<_>>()}),
        )
    }
    async fn complete(scan: &Scan) -> Snapshot {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !scan.task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        scan.snapshot()
    }
    #[tokio::test]
    async fn discovers_unvisited_nested_projects_and_streams_before_a_slow_child() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let reader_gate = gate.clone();
        let scan = Scan::start(
            "/home/me".into(),
            Some("/home/me".into()),
            Limits::default(),
            move |path| {
                let gate = reader_gate.clone();
                async move {
                    match path.as_str() {
                        "/home/me" => listing(&path, &["code", "slow"]),
                        "/home/me/code" => listing(&path, &["work"]),
                        "/home/me/code/work" => {
                            listing(&path, &["autonomous-harness", "client 日本"])
                        }
                        "/home/me/slow" => {
                            gate.notified().await;
                            listing(&path, &[])
                        }
                        _ => listing(&path, &[]),
                    }
                }
            },
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while !scan
                .snapshot()
                .paths
                .iter()
                .any(|p| p.ends_with("autonomous-harness"))
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!scan.task.is_finished());
        assert!(scan.snapshot().notice.ends_with('…'));
        gate.notify_one();
        let done = complete(&scan).await;
        assert_eq!(done.paths.len(), 6);
        assert!(done.notice.is_empty());
    }
    #[tokio::test]
    async fn pruning_keeps_folder_selectable_and_explicit_roots_can_be_searched() {
        let scan = Scan::start(
            "/home/me".into(),
            Some("/home/me".into()),
            Limits::default(),
            |path| async move {
                assert_eq!(path, "/home/me", "a pruned child was read");
                listing(
                    &path,
                    &[
                        "node_modules",
                        "Library",
                        "target",
                        "Tool.app",
                        ".git",
                        "../escape",
                        "bad\nname",
                        "node_modules",
                    ],
                )
            },
        );
        let done = complete(&scan).await;
        assert_eq!(done.paths.len(), 5);
        assert!(done.notice.is_empty());
        let scan = Scan::start(
            "/home/me/Library".into(),
            Some("/home/me".into()),
            Limits::default(),
            |path| async move {
                listing(
                    &path,
                    if path.ends_with("Library") {
                        &["my-project"]
                    } else {
                        &[]
                    },
                )
            },
        );
        assert_eq!(complete(&scan).await.paths.len(), 2);
    }
    #[tokio::test]
    async fn failures_and_limits_are_honest_and_preserve_usable_results() {
        let scan = Scan::start(
            "/home/me".into(),
            None,
            Limits {
                paths: 3,
                ..Limits::default()
            },
            |path| async move { listing(&path, &["a", "b", "c"]) },
        );
        let done = complete(&scan).await;
        assert_eq!(done.paths, ["/home/me", "/home/me/a", "/home/me/b"]);
        assert!(done.notice.starts_with("Search limited"));
        let scan = Scan::start(
            "/home/me".into(),
            None,
            Limits::default(),
            |path| async move {
                if path == "/home/me" {
                    listing(&path, &["denied"])
                } else {
                    Ok(json!({"error":"PERMISSION_DENIED"}))
                }
            },
        );
        let done = complete(&scan).await;
        assert_eq!(done.paths.len(), 2);
        assert_eq!(done.notice, "Some folders could not be read.");
        let scan = Scan::start("/missing".into(), None, Limits::default(), |_| async {
            Err(())
        });
        let done = complete(&scan).await;
        assert!(done.paths.is_empty());
        assert!(done.notice.starts_with("Could not read"));
    }
    #[tokio::test]
    async fn deadline_finishes_and_dropping_a_scan_cancels_pending_reads() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Reading(Arc<AtomicUsize>);
        impl Drop for Reading {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let count = Arc::new(AtomicUsize::new(0));
        for deadline in [true, false] {
            let reader_count = count.clone();
            let scan = Scan::start(
                "/home/me".into(),
                None,
                Limits {
                    time: if deadline {
                        Duration::from_millis(30)
                    } else {
                        Duration::from_secs(10)
                    },
                    ..Limits::default()
                },
                move |path| {
                    let count = reader_count.clone();
                    async move {
                        if path == "/home/me" {
                            return listing(&path, &["slow"]);
                        }
                        count.fetch_add(1, Ordering::SeqCst);
                        let _reading = Reading(count);
                        std::future::pending().await
                    }
                },
            );
            tokio::time::timeout(Duration::from_secs(1), async {
                while count.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            if deadline {
                assert!(complete(&scan).await.notice.starts_with("Search limited"));
            }
            drop(scan);
            tokio::time::timeout(Duration::from_secs(1), async {
                while count.load(Ordering::SeqCst) != 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
}
