//! The desktop New Harness launch choices, using the same daemon contracts.
use super::{Draft, Project};
use crate::{picker::Row, theme};
use serde_json::{Value, json};

pub fn modes(engine: &str) -> &'static [(&'static str, &'static str)] {
    match engine {
        "claude" => &[
            ("auto", "Auto-approve"),
            ("acceptEdits", "Accept edits"),
            ("plan", "Plan first"),
            ("ask", "Ask first"),
            ("full", "Skip all checks"),
        ],
        "codex" => &[
            ("readOnly", "Read only"),
            ("ask", "Ask first"),
            ("auto", "Auto-approve"),
            ("full", "Full access"),
        ],
        "cursor" | "opencode" => &[("auto", "Auto-approve"), ("ask", "Ask first")],
        _ => &[],
    }
}
pub fn mode_label(engine: &str, mode: &str) -> String {
    modes(engine)
        .iter()
        .find(|(id, _)| *id == mode)
        .map(|(_, label)| *label)
        .unwrap_or(mode)
        .into()
}
pub fn subscription(engine: &str) -> &str {
    match engine {
        "codex" => "OpenAI",
        "claude" => "Anthropic",
        _ => theme::engine_label(engine),
    }
}
pub fn branches(info: &Value) -> &[Value] {
    info["branches"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
pub fn git(info: &Value) -> bool {
    info["isGit"].as_bool() == Some(true)
}
pub fn branch_ref(draft: &Draft, info: &Value) -> Option<String> {
    if let Some(r) = &draft.branch {
        return Some(r.clone());
    }
    let refs: Vec<_> = branches(info)
        .iter()
        .filter_map(|b| b["ref"].as_str())
        .collect();
    if draft.worktree.unwrap_or(git(info)) {
        ["refs/heads/main", "refs/remotes/origin/main"]
            .into_iter()
            .find(|r| refs.contains(r))
            .map(str::to_string)
    } else {
        info["branch"]
            .as_str()
            .map(|b| format!("refs/heads/{b}"))
            .filter(|r| refs.contains(&r.as_str()))
    }
}
pub fn branch_name(reference: &str) -> &str {
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/remotes/"))
        .unwrap_or(reference)
}
pub fn valid_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains([' ', '\t', '\n', '\\', '~', '^', ':', '?', '*', '['])
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && name
            .split('/')
            .all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
        && name != "@"
}
pub fn branch_rows(info: &Value, worktree: bool, query: &str) -> Vec<Row> {
    let locals: Vec<_> = branches(info)
        .iter()
        .filter(|b| b["remote"] != true)
        .filter_map(|b| b["name"].as_str())
        .collect();
    let mut rows = Vec::new();
    for branch in branches(info) {
        let (Some(reference), Some(name)) = (branch["ref"].as_str(), branch["name"].as_str())
        else {
            continue;
        };
        if branch["remote"] == true
            && (!worktree
                || name
                    .split_once('/')
                    .is_some_and(|(_, short)| locals.contains(&short)))
        {
            continue;
        }
        let mut row = Row::new(reference, name).extra(reference);
        if branch["worktree"].is_string() && info["branch"].as_str() != Some(name) {
            row.label.push_str(" · in its worktree");
        }
        rows.push(row);
    }
    let query = query.trim();
    if valid_branch(query) && !locals.contains(&query) {
        rows.push(Row::new(
            format!("new:{query}"),
            format!("Create branch {query}"),
        ));
    }
    rows
}

/// Prepare only a request. The daemon owns branch/worktree creation, and does it only at Start.
pub fn project_payload(d: &Draft, info: &Value) -> Result<(Option<String>, Value), String> {
    let mut extra = json!({});
    let folder = match &d.project {
        Project::New(name) => {
            extra["projectSource"] = json!("new");
            if !name.is_empty() {
                extra["projectName"] = json!(name);
            }
            return Ok((None, extra));
        }
        Project::Clone(url) => {
            extra["projectSource"] = json!("remote");
            extra["repositoryUrl"] = json!(url);
            return Ok((None, extra));
        }
        Project::Folder(folder) if folder.starts_with('/') => folder,
        _ => return Err("Choose a project folder first".into()),
    };
    if d.what.engine == "terminal" || !git(info) {
        return Ok((Some(folder.clone()), extra));
    }
    let worktree = d.worktree.unwrap_or(true);
    let reference = branch_ref(d, info);
    if worktree && reference.is_none() {
        return Err("Choose a branch, or turn Worktree off".into());
    }
    let Some(reference) = reference else {
        return Ok((Some(folder.clone()), extra));
    };
    extra["projectSource"] = json!(if worktree { "worktree" } else { "branch" });
    extra["gitSource"] = json!(folder);
    extra["branchRef"] = json!(reference);
    if let Some(name) = &d.new_branch {
        if !valid_branch(name) {
            return Err("Choose a valid branch name".into());
        }
        extra["branchName"] = json!(name);
        if !worktree {
            extra["branchRef"] = json!(format!("refs/heads/{name}"));
        }
    } else if worktree {
        let name = branch_name(&reference);
        let is_default = name == "main"
            || name == "origin/main"
            || info["defaultRef"].as_str() == Some(&reference)
            || info["defaultRef"]
                .as_str()
                .and_then(|r| r.strip_prefix("refs/remotes/"))
                .and_then(|r| r.split_once('/'))
                .is_some_and(|(_, short)| short == name);
        let local_name = reference
            .strip_prefix("refs/heads/")
            .or_else(|| name.split_once('/').map(|(_, n)| n));
        let local = branches(info)
            .iter()
            .find(|b| b["remote"] != true && b["name"].as_str() == local_name);
        if !is_default {
            if let Some(local) = local {
                if local["name"] != info["branch"] {
                    extra["branchRef"] = local["ref"].clone();
                    if local["worktree"].is_string() {
                        extra["projectSource"] = json!("branch");
                    } else {
                        extra["branchName"] = local["name"].clone();
                        extra["branchMode"] = json!("existing");
                    }
                }
            } else if let Some(name) = local_name {
                extra["branchName"] = json!(name);
            }
        }
    }
    Ok((None, extra))
}

pub fn supports_models(catalog: &Value, engine: &str) -> bool {
    catalog["supportsModelLaunch"] == true
        && catalog["localModelEngines"]
            .as_array()
            .map(|a| a.iter().any(|e| e.as_str() == Some(engine)))
            .unwrap_or(true)
}
pub fn model_rows(catalog: &Value, engine: &str) -> Vec<Row> {
    let mut rows = vec![Row::new("subscription", subscription(engine)).group("Subscription")];
    if supports_models(catalog, engine) {
        for grid in catalog["grids"].as_array().into_iter().flatten() {
            let Some(grid_name) = grid["name"].as_str() else {
                continue;
            };
            for model in grid["models"].as_array().into_iter().flatten() {
                let Some(id) = model["id"].as_str() else {
                    continue;
                };
                let node = model["node"].as_str().unwrap_or("");
                let label = format!("{id}{}{}", if node.is_empty() { "" } else { " · " }, node);
                let mut row = Row::new(json!([grid_name, id]).to_string(), label)
                    .extra(grid_name)
                    .group(if grid["own"] == true {
                        "On your machines".into()
                    } else {
                        format!("Shared · {grid_name}")
                    });
                row.disabled = model["unavailable"].is_object()
                    || model["unavailable"].as_bool() == Some(true);
                if row.disabled {
                    row.label.push_str(" · offline");
                }
                rows.push(row);
            }
        }
    }
    rows.push(Row::new("refresh", "Refresh models"));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft() -> Draft {
        Draft {
            machine: "local".into(),
            what: crate::modal::What {
                engine: "codex".into(),
                dsh: None,
                label: "Codex".into(),
            },
            project: Project::Folder("/home/dev/repo".into()),
            task: String::new(),
            permission: "auto".into(),
            worktree: None,
            branch: None,
            new_branch: None,
            model: None,
            profile: None,
        }
    }
    fn info() -> Value {
        json!({"isGit":true,"branch":"main","branches":[{"name":"main","ref":"refs/heads/main","remote":false},{"name":"feature","ref":"refs/heads/feature","remote":false},{"name":"open","ref":"refs/heads/open","remote":false,"worktree":"/home/dev/open"}]})
    }
    #[test]
    fn launch_matches_the_desktop_git_choices() {
        let mut d = draft();
        let i = info();
        assert_eq!(
            project_payload(&d, &i).unwrap().1,
            json!({"projectSource":"worktree","gitSource":"/home/dev/repo","branchRef":"refs/heads/main"})
        );
        d.branch = Some("refs/heads/feature".into());
        assert_eq!(project_payload(&d, &i).unwrap().1["branchMode"], "existing");
        d.branch = Some("refs/heads/open".into());
        assert_eq!(
            project_payload(&d, &i).unwrap().1["projectSource"],
            "branch"
        );
        d.worktree = Some(false);
        d.new_branch = Some("new-feature".into());
        assert_eq!(
            project_payload(&d, &i).unwrap().1["branchRef"],
            "refs/heads/new-feature"
        );
        d = draft();
        assert!(project_payload(&d, &json!({"isGit":true,"branches":[]})).is_err());
        d.worktree = Some(false);
        assert!(project_payload(&d, &json!({"isGit":true,"branches":[]})).is_ok());
        d.what.engine = "terminal".into();
        assert_eq!(
            project_payload(&d, &i).unwrap().0.as_deref(),
            Some("/home/dev/repo")
        );
        assert!(!modes("codex").iter().any(|(m, _)| *m == "plan"));
        assert!(modes("claude").iter().any(|(m, _)| *m == "plan"));
        assert!(modes("terminal").is_empty());
    }
    #[test]
    fn models_retain_grid_identity_and_do_not_offer_offline_routes() {
        let catalog = json!({"supportsModelLaunch":true,"localModelEngines":["codex"],"grids":[{"name":"one","models":[{"id":"same","node":"local"}]},{"name":"two","models":[{"id":"same","node":"remote","unavailable":{"machine":"remote"}}]}]});
        let rows = model_rows(&catalog, "codex");
        assert_ne!(rows[1].id, rows[2].id);
        assert!(rows[2].disabled);
        assert_eq!(model_rows(&catalog, "cursor").len(), 2);
    }
}
