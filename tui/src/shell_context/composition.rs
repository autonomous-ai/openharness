//! Composer catalogs and launch validation on the selected computer.
use super::*;
use crate::shell_composer::{Launch, command, engine, has_native_model};
use serde_json::Value;

pub(super) struct Catalog {
    key: String,
    rows: Vec<Row>,
    notice: String,
    folder: Option<String>,
    scan: Option<super::folders::Scan>,
    scan_revision: u64,
    seed: Vec<Row>,
    revision: String,
}
/// A composed command's computer, when the list says it is up and hn has no link to it (one that dropped while it
/// read offline, an error, or never dialled), is dialled now: `launch` then waits for it as for one still connecting.
/// It answered "That computer is offline" while it was up (a shared Mac, 2026-10-22). A dial already pending or in
/// its backoff is left to it (`dial_if_idle`): the waiting command asks again every 100 ms.
fn wake(app: &mut App, name: &str) {
    let mut found = app.fleet.machines.iter()
        .filter(|m| !m.shared && (m.id == name || m.name.eq_ignore_ascii_case(name)));
    let (Some(m), None) = (found.next(), found.next()) else { return };
    if m.online() && matches!(m.reach, crate::fleet::Reach::Unknown | crate::fleet::Reach::Offline | crate::fleet::Reach::Error(_)) {
        let id = m.id.clone();
        app.dial_if_idle(&id);
    }
}

fn host(app: &App, source: &str, name: Option<&str>, connecting: bool) -> Result<String, String> {
    let Some(name) = name else {
        return Ok(source.into());
    };
    if name == "local" {
        return Ok(crate::input::shell_machine(app, None));
    }
    let matches: Vec<_> = app
        .fleet
        .machines
        .iter()
        .filter(|m| !m.shared && (m.id == name || m.name.eq_ignore_ascii_case(name)))
        .collect();
    if matches.len() != 1 {
        return Err("Computer is missing or ambiguous. Choose it again with Ctrl+P @.".into());
    }
    if !matches[0].usable()
        && !(connecting && matches[0].online() && matches[0].reach == crate::fleet::Reach::Connecting)
    {
        return Err("That computer is offline. The command was not started.".into());
    }
    Ok(matches[0].id.clone())
}
fn short(app: &App, machine: &str, path: &str) -> String {
    app.homes
        .get(machine)
        .and_then(|h| path.strip_prefix(h))
        .filter(|p| p.is_empty() || p.starts_with('/'))
        .map(|p| format!("~{p}"))
        .unwrap_or_else(|| path.into())
}
fn data(app: &mut App, request: &Request, rows: Vec<Row>, notice: String) {
    let mut picker = Picker::new("", "");
    picker.search_extra = true;
    picker.set_rows(rows);
    picker.status = notice;
    let args = serde_json::from_str::<Value>(&request.query).unwrap_or_default();
    let mut items = if args["kind"] == "folder" {
        folder_items(&mut picker, args["query"].as_str().unwrap_or(""))
    } else { crate::shell_picker::Items::from_picker(&picker) };
    if args["kind"] == "host" {
        let source = app.panes.get(&request.pane).map(|p| p.machine_id.as_str()).unwrap_or("");
        items.machine = host(app, source, args["compose"]["host"].as_str(), false).ok();
    }
    if args["kind"] == "folder" {
        if let Some(catalog) = &app.shell_context.composition {
            items.folder = catalog.folder.clone();
            // Large catalogs are filtered before transport; the same scan can
            // therefore produce a different response for each query.
            items.revision = format!("{}:{}:{}", catalog.revision, catalog.scan_revision, args["query"].as_str().unwrap_or(""));
            if args["revision"].as_str() == Some(items.revision.as_str()) {
                return catalog_reply(app, request, json!({"unchanged":true,"revision":items.revision}));
            }
        }
    }
    if let Ok(data) = serde_json::to_value(items) { catalog_reply(app, request, data); }
}

fn folder_items(picker: &mut Picker, query: &str) -> crate::shell_picker::Items {
    // The local socket caps JSON frames at 512 KiB. Leave room for the RPC and
    // encrypted remote envelope; keeping an 8 MiB FIFO file limit is not enough.
    const BUDGET: usize = 192 * 1024;
    let mut items = crate::shell_picker::Items::from_picker(picker);
    if serde_json::to_vec(&items).is_ok_and(|v| v.len() <= BUDGET) { return items }
    picker.query = format!(":{query}");
    picker.prefixed = true;
    crate::shell_picker::folder_filter(picker, true);
    let all = std::mem::take(&mut items.rows);
    items.total_rows = Some(all.len());
    let mut size = serde_json::to_vec(&items).map(|v| v.len()).unwrap_or(BUDGET);
    for (index, _) in &picker.visible {
        let row = &all[*index];
        let bytes = serde_json::to_vec(row).map(|v| v.len() + 1).unwrap_or(BUDGET);
        if size + bytes > BUDGET { break }
        size += bytes;
        items.rows.push(row.clone());
    }
    items
}

/// A name searches the computer's home, including projects outside the shell's
/// current subtree. An explicit relative path still starts at the shell's cwd.
fn folder_parent(query: &str, cwd: &str, home: Option<&str>) -> Result<String, String> {
    let Some(parent) = crate::shell_picker::folder_parts(query).0 else {
        return home.filter(|h| h.starts_with('/')).map(str::to_string)
            .ok_or_else(|| "Computer details are still loading. Try again.".into());
    };
    if parent == "~" || parent.starts_with("~/") {
        let home = home.ok_or("Computer details are still loading. Try again.")?;
        Ok(format!("{home}{}", &parent[1..]))
    } else if parent.starts_with('/') {
        Ok(parent.into())
    } else if cwd.starts_with('/') {
        Ok(format!("{}/{parent}", cwd.trim_end_matches('/')))
    } else {
        Err("Computer details are still loading. Try again.".into())
    }
}

fn folder_rows(
    snapshot: &super::folders::Snapshot,
    home: Option<&str>,
    browsing: bool,
) -> Vec<Row> {
    let Some(root) = snapshot.root.as_deref() else {
        return vec![];
    };
    let shorten = |path: &str| {
        home.and_then(|h| path.strip_prefix(h))
            .filter(|p| p.is_empty() || p.starts_with('/'))
            .map(|p| format!("~{p}"))
            .unwrap_or_else(|| path.into())
    };
    snapshot
        .paths
        .iter()
        .map(|path| {
            let value = shorten(path);
            let relative = path
                .strip_prefix(root.trim_end_matches('/'))
                .unwrap_or(path)
                .trim_start_matches('/');
            if relative.is_empty() {
                Row::new(&value, if browsing { "." } else { &value }).right("this folder")
            } else if browsing {
                // Match all descendants relative to this root, not their shared parent.
                Row::new(value, format!("{relative}/"))
            } else {
                Row::new(&value, &value)
            }
        })
        .collect()
}
pub(super) fn list(app: &mut App, request: Request) {
    let Ok(args) = serde_json::from_str::<Value>(&request.query) else {
        return reply(app, &request, 1, "Invalid completion request.");
    };
    let kind = args["kind"].as_str().unwrap_or("");
    let query = args["query"].as_str().unwrap_or("");
    if query.len() > 4096 || query.chars().any(char::is_control) {
        return reply(app, &request, 1, "Search is too long.");
    }
    let source = app
        .panes
        .get(&request.pane)
        .map(|p| p.machine_id.clone())
        .unwrap_or_default();
    let agent = args["compose"]["engine"].as_str().unwrap_or("");
    if kind == "part" {
        return data(
            app,
            &request,
            vec![
                Row::new("&", "Agent"),
                Row::new("@", "Computer"),
                Row::new(":", "Project folder"),
                Row::new("%", "Model"),
            ],
            String::new(),
        );
    }
    if kind == "agent" {
        return data(
            app,
            &request,
            crate::modal::ENGINES
                .iter()
                .filter(|e| **e != "terminal")
                .map(|e| Row::new(command(e), crate::theme::engine_label(e)).extra(command(e)))
                .collect(),
            String::new(),
        );
    }
    if kind == "host" {
        let rows = host_rows(app);
        return data(app, &request, rows, String::new());
    }
    if !["folder", "model"].contains(&kind) {
        return reply(app, &request, 1, "Unknown completion.");
    }
    let machine = match host(app, &source, args["compose"]["host"].as_str(), false) {
        Ok(m) => m,
        Err(e) => return data(app, &request, vec![], e),
    };
    let cwd = args["compose"]["cwd"]
        .as_str()
        .filter(|_| machine == source)
        .map(str::to_string)
        .or_else(|| app.homes.get(&machine).cloned())
        .unwrap_or_default();
    // Another computer's home is read when its folders are first asked for. Nothing else did here
    // (only New Harness read it), so its folders stayed "still loading" and only its agents'
    // scratch folders were offered.
    if kind == "folder" && !app.homes.contains_key(&machine) && app.shell_context.homes_asked.insert(machine.clone()) {
        crate::input::load_dsh(app, machine.clone(), false);
    }
    let browsing = kind == "folder" && crate::shell_picker::folder_parts(query).0.is_some();
    let parent = if kind == "folder" {
        match folder_parent(query, &cwd, app.homes.get(&machine).map(String::as_str)) {
            Ok(path) => path,
            Err(e) => return data(app, &request, vec![], e),
        }
    } else {
        cwd.clone()
    };
    let key = format!(
        "{}|{}|{kind}|{machine}|{agent}|{parent}|{browsing}",
        request.token, request.pane
    );
    if app
        .shell_context
        .composition
        .as_ref()
        .is_none_or(|c| c.key != key || c.scan.as_ref().is_some_and(|s| s.expired()))
    {
        let mut rows = Vec::new();
        if kind == "folder" && !browsing {
            let mut recent: Vec<_> = app
                .fleet
                .agents
                .values()
                .filter(|a| a.machine_id == machine && !a.cwd.is_empty())
                .filter(|a| !super::scratch_folder(&a.cwd))
                .collect();
            recent.sort_by_key(|a| std::cmp::Reverse(a.recency()));
            let mut seen = HashSet::new();
            for path in std::iter::once(cwd.as_str())
                .filter(|s| !s.is_empty())
                .chain(recent.into_iter().map(|a| a.cwd.as_str()))
            {
                if seen.insert(path.to_string()) {
                    let value = short(app, &machine, path);
                    rows.push(Row::new(&value, &value).extra(path));
                }
                if rows.len() >= 50 {
                    break;
                }
            }
        } else if kind == "model" {
            rows.push(Row::new("default", "Use agent default"));
            if agent == "claude" {
                for name in ["sonnet", "opus", "haiku"] {
                    rows.push(Row::new(name, name).right("agent alias"));
                }
            }
        }
        let folder = (kind == "folder").then(|| short(app, &machine, &parent));
        app.shell_context.composition = Some(Catalog {
            key: key.clone(),
            seed: rows.clone(),
            rows,
            notice: "Loading…".into(),
            folder,
            scan: None,
            scan_revision: u64::MAX,
            revision: uuid::Uuid::new_v4().to_string(),
        });
        if let Some(link) = app.link(&machine) {
            if kind == "folder" {
                app.shell_context.composition.as_mut().unwrap().scan =
                    Some(super::folders::Scan::new(
                        link,
                        parent.clone(),
                        app.homes.get(&machine).cloned(),
                    ));
            } else {
                let epoch = app.account_epoch;
                let next_key = key.clone();
                let current_agent = agent.to_string();
                app.spawn(
                    async move {
                        let (grid, native) = tokio::join!(
                            link.rpc(
                                "grid_models_list",
                                json!({"rowState":true}),
                                Duration::from_secs(20)
                            ),
                            link.rpc("models_list", json!({}), Duration::from_secs(20))
                        );
                        (grid, native)
                    },
                    move |app, (first, second)| {
                        if app.account_epoch != epoch
                            || app
                                .shell_context
                                .composition
                                .as_ref()
                                .is_none_or(|c| c.key != next_key)
                        {
                            return;
                        }
                        let mut rows = Vec::new();
                        let mut notice = String::new();
                        if ["", "codex", "claude"].contains(&current_agent.as_str()) {
                            if let Ok(v) = &first {
                                for r in routes(v) {
                                    rows.push(
                                        Row::new(format!("{}::{}", r.grid, r.model), &r.model)
                                            .right(r.label),
                                    );
                                }
                            }
                        }
                        if let Ok(v) = second {
                            let mut seen = HashSet::new();
                            for model in v["models"].as_array().into_iter().flatten() {
                                if let Some(id) = model["id"].as_str() {
                                    let parts: Vec<_> = id.splitn(4, ':').collect();
                                    if parts.len() == 4
                                        && parts[0] == "runtime-v1"
                                        && parts[2] == current_agent
                                    {
                                        if let Some((name, _)) = parts[3].rsplit_once('@') {
                                            if let Some(name) = decode(name) {
                                                if seen.insert(name.clone()) {
                                                    rows.push(
                                                        Row::new(&name, &name).right("agent model"),
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if first.is_err() {
                            notice =
                                "Model routes unavailable; native model names still work.".into();
                        }
                        let catalog = app.shell_context.composition.as_mut().unwrap();
                        for row in rows {
                            if !catalog.rows.iter().any(|r| r.id == row.id) {
                                catalog.rows.push(row);
                            }
                        }
                        catalog.notice = notice;
                    },
                );
            }
        } else {
            app.shell_context.composition.as_mut().unwrap().notice =
                "Computer is not connected.".into();
        }
    }
    if kind == "folder" {
        let catalog = app.shell_context.composition.as_mut().unwrap();
        if let Some(scan) = &catalog.scan {
            let snapshot = scan.snapshot();
            if catalog.scan_revision != snapshot.revision {
                let home = app.homes.get(&machine).map(String::as_str);
                if let Some(path) = &snapshot.root {
                    catalog.folder = Some(
                        home.and_then(|h| path.strip_prefix(h))
                            .filter(|s| s.is_empty() || s.starts_with('/'))
                            .map(|s| format!("~{s}"))
                            .unwrap_or_else(|| path.clone()),
                    );
                }
                let mut rows = folder_rows(&snapshot, home, browsing);
                let mut seen: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
                // Preserve recent destinations outside this tree, without
                // copying the absolute parent into every candidate's match text.
                for row in &catalog.seed {
                    if seen.insert(row.id.clone()) {
                        rows.push(row.clone());
                    }
                }
                catalog.rows = rows;
                catalog.notice = snapshot.notice;
                catalog.scan_revision = snapshot.revision;
            }
        }
    }
    let catalog = app.shell_context.composition.as_ref().unwrap();
    let mut rows = catalog.rows.clone();
    let notice = catalog.notice.clone();
    if kind == "model"
        && !query.is_empty()
        && native_model_flag(agent).is_some()
        && !query.contains("::")
        && !rows.iter().any(|r| r.id == query)
    {
        rows.push(
            Row::new(query, query)
                .right("use native model name")
                .tier(1),
        );
    }
    data(app, &request, rows, notice);
}
fn decode(raw: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        out.push(if b == b'%' {
            ((bytes.next()? as char).to_digit(16)? * 16 + (bytes.next()? as char).to_digit(16)?)
                as u8
        } else {
            b
        });
    }
    String::from_utf8(out).ok()
}
// These engines already use --model in the repository's native launch contracts.
fn native_model_flag(engine: &str) -> Option<&'static str> {
    match engine {
        "codex" | "claude" | "opencode" | "pi" | "cursor" => Some("--model"),
        _ => None,
    }
}
fn model_args(
    launch: &Launch,
    route: Option<Route>,
) -> Result<(Vec<String>, Option<Route>), String> {
    let mut args = launch.args.clone();
    let mut route = route;
    if let Some(model) = &launch.model {
        if has_native_model(&launch.engine, &args) {
            return Err("Choose either %model or native model/profile options.".into());
        }
        if model == "default" {
            route = None;
        } else if let Some((grid, model)) = model.split_once("::") {
            if !["codex", "claude"].contains(&launch.engine.as_str()) {
                return Err(
                    "This agent cannot use a model route. Use its native model options.".into(),
                );
            }
            if grid.is_empty() || model.is_empty() {
                return Err("Invalid model route.".into());
            }
            route = Some(Route {
                grid: grid.into(),
                model: model.into(),
                label: grid.into(),
            });
        } else {
            let flag = native_model_flag(&launch.engine).ok_or(
                "This agent uses its own model controls; omit %model and use its native options.",
            )?;
            if launch.engine != "claude" && ["sonnet", "opus", "haiku"].contains(&model.as_str()) {
                return Err(
                    "That is a Claude model. Choose a model for the selected agent.".into(),
                );
            }
            args.splice(0..0, [flag.into(), model.clone()]);
            route = None;
        }
    } else if has_native_model(&launch.engine, &args) {
        route = None;
    }
    if route.is_some() && !["codex", "claude"].contains(&launch.engine.as_str()) {
        return Err(
            "This agent cannot use the selected cm route. Use %default for its own settings."
                .into(),
        );
    }
    Ok((args, route))
}
pub(super) fn launch(app: &mut App, request: Request) {
    let Ok(launch) = serde_json::from_str::<Launch>(&request.query) else {
        return reply(app, &request, 1, "Invalid command.");
    };
    if engine(&launch.engine).is_none()
        || request.query.len() > 48000
        || launch.args.len() > 256
        || launch.args.iter().any(|s| s.contains('\0'))
    {
        return reply(app, &request, 1, "Invalid command.");
    }
    let Some(source) = app
        .panes
        .get(&request.pane)
        .map(|p| (p.machine_id.clone(), p.agent_id.clone()))
    else {
        return;
    };
    if let Some(name) = launch.host.as_deref() { wake(app, name) }
    let machine = match host(app, &source.0, launch.host.as_deref(), true) {
        Ok(m) => m,
        Err(e) => return reply(app, &request, 1, &e),
    };
    if app.fleet.machines.iter().any(|m| m.id == machine && m.reach == crate::fleet::Reach::Connecting) {
        // The October 6 remote-composer E2E reached the prompt before machine_select
        // finished. Wait for that connection before issuing any launch RPC; a
        // cancelled command must not start later when the computer becomes ready.
        if request.at.elapsed() >= Duration::from_secs(25) {
            return reply(app, &request, 1, "Could not connect to that computer. The command was not started.");
        }
        app.shell_context.pending = Some(request.clone());
        let epoch = app.account_epoch;
        app.spawn(async { tokio::time::sleep(Duration::from_millis(100)).await }, move |app, ()| {
            if app.account_epoch != epoch || app.shell_context.pending.as_ref()
                .is_none_or(|r| r.id != request.id || r.token != request.token) { return }
            if app.panes.get(&request.pane)
                .is_none_or(|p| p.machine_id != source.0 || p.agent_id != source.1) {
                return cancel(app);
            }
            app.shell_context.pending = None;
            self::launch(app, request);
        });
        return;
    }
    let route = app
        .shell_context
        .contexts
        .get(&request.token)
        .and_then(|c| c.route.clone());
    let (args, route) = match model_args(&launch, route) {
        Ok(v) => v,
        Err(e) => return reply(app, &request, 1, &e),
    };
    let path = launch.path.clone().unwrap_or_else(|| {
        if machine == source.0 {
            launch.cwd.clone()
        } else {
            "~".into()
        }
    });
    let path = if path.starts_with('/') || path.starts_with('~') {
        path
    } else if machine == source.0 {
        format!("{}/{path}", launch.cwd.trim_end_matches('/'))
    } else {
        return reply(
            app,
            &request,
            1,
            "Use an absolute path or ~/folder on another computer.",
        );
    };
    let Some(link) = app.link(&machine) else {
        return reply(app, &request, 1, "That computer is unavailable.");
    };
    if machine == source.0 {
        let mut plan = json!({"cwd":path,"args":args});
        if let Some(r) = route {
            plan["grid"] = json!(r.grid);
            plan["model"] = json!(r.model);
        }
        reply_data(app, &request, 0, "", Some(plan));
        return;
    }
    let path = if path == "~" || path.starts_with("~/") {
        let Some(home) = app.homes.get(&machine) else {
            return reply(
                app,
                &request,
                1,
                "Computer details are still loading. Try again.",
            );
        };
        format!("{home}{}", &path[1..])
    } else {
        path
    };
    // A computer shared with this account (guest sharing): its owner's daemon answers a guest only what
    // cli core/guestPolicy.ts lists, which is not fs_list_dir, shell_capabilities or the terminal that runs
    // shell-launch, so a composed command there was refused GUEST_NOT_ALLOWED. Start it as New Harness does there,
    // and Desktop: Claude Code or Codex in that folder, on the owner's plans (a model route stays behind).
    if app.fleet.shares.contains_key(&machine) {
        if launch.model.is_some() {
            return reply(app, &request, 1, "On a computer shared with you, the harness runs on its owner's plans: leave the model out.");
        }
        if !guest_folder(&path, app.homes.get(&machine).map(String::as_str), app.guest_folders.get(&machine)) {
            return reply(app, &request, 1, "On a computer shared with you, start in your workspace (~) or a folder its owner shares.");
        }
        let mode = guest_mode(&launch.engine, app.options.get("@hn-permission-mode", "", None));
        let payload = match guest_launch(&launch.engine, &path, &args, &mode) {
            Ok(p) => p,
            Err(e) => return reply(app, &request, 1, &e),
        };
        app.shell_context.pending = Some(request.clone());
        let epoch = app.account_epoch;
        let source_cwd = Some(launch.cwd.clone());
        let creation = payload["creationId"].clone();
        app.spawn(async move {
            // A lost answer is not a launch that failed: the receipt says whether it started (as shell_open_status
            // does for the remote shell), and `started` closes one this command no longer waits for.
            match link.rpc("agent_create", payload, Duration::from_secs(180)).await {
                Err(error) => match link.rpc("agent_create_status", json!({"creationId":creation}), Duration::from_secs(15)).await {
                    Ok(reply) if reply["state"] == "created" => Ok(reply),
                    _ => Err(error),
                },
                other => other,
            }
        }, move |app, result| {
            if app.account_epoch != epoch { return }
            // A refusal recorded on the receipt is `failure`, as New Harness reads it.
            let result = result.and_then(|v| match v["failure"]["code"].as_str() {
                Some(code) => Err(crate::daemon::RpcError::new(code, v["failure"]["detail"].as_str().unwrap_or(""))),
                None => Ok(v),
            });
            started(app, request, machine, source, source_cwd, result);
        });
        return;
    }
    app.shell_context.pending = Some(request.clone());
    let epoch = app.account_epoch;
    let local = machine == source.0;
    let link2 = link.clone();
    app.spawn(async move {
        let folder=link.rpc("fs_list_dir",json!({"path":path}),Duration::from_secs(20)).await?;
        if !local {
            let capabilities=link.rpc("shell_capabilities",json!({}),Duration::from_secs(30)).await.map_err(|error| {
                if error.code == "UNSUPPORTED" { crate::daemon::RpcError::new("UPDATE_REQUIRED", "Update the CLI on that computer before using composed commands.") } else { error }
            })?;
            if capabilities["protocol"]!=1 {return Err(crate::daemon::RpcError::new("UPDATE_REQUIRED","Update the CLI on that computer before using composed commands."))}
        }
        Ok(folder)
    },move |app,result| {
        if app.account_epoch!=epoch || app.shell_context.pending.as_ref().is_none_or(|r|r.id!=request.id){return}
        let cwd=match result {Ok(v)=>match v["path"].as_str(){Some(p)=>p.to_string(),None=>return finish(app,1,"That folder is unavailable on the selected computer.")},Err(e)=>return finish(app,1,&format!("Could not start: {e}"))};
        if local {
            app.shell_context.pending=None;
            let mut plan=json!({"cwd":cwd,"args":args});if let Some(r)=route {plan["grid"]=json!(r.grid);plan["model"]=json!(r.model);}
            reply_data(app,&request,0,"",Some(plan));return
        }
        let creation=uuid::Uuid::new_v4().to_string();
        let mut argv = vec!["harness".to_string(), "shell-launch".into(), launch.engine.clone()];
        if let Some(r) = route { argv.extend([r.grid, r.model, "--".into()]); }
        else { argv.extend(["--native".into(), "--".into()]); }
        argv.extend(args);
        let payload=json!({"argv":argv,"cwd":cwd,"creationId":creation});
        let source_cwd=Some(launch.cwd.clone());
        app.spawn(async move {
            open_shell(&link2, payload).await
        },move |app,result| {
            if app.account_epoch!=epoch {return}
            started(app, request, machine, source, source_cwd, result);
        });
    });
}

/// A composed command's agent, created on [machine]: it replaces the shell's view, which it returns to on exit.
fn started(app: &mut App, request: Request, machine: String, source: (String, String), source_cwd: Option<String>,
    result: Result<Value, crate::daemon::RpcError>) {
    let current=app.shell_context.pending.as_ref().is_some_and(|r|r.id==request.id);
    match result {
        Ok(v)=>if let Some(id)=v.pointer("/agent/id").and_then(Value::as_str) {
            app.fleet.agents.insert((machine.clone(),id.into()),crate::fleet::agent_from(&machine,&v["agent"],None));
            if !current {if let Some(link)=app.link(&machine){link.send("agent_delete",json!({"agentId":id}));}return}
            app.shell_context.pending=None;
            if app.focused()!=Some(request.pane) {
                reply_data(app,&request,0,"",Some(json!({"attached":true,"message":"Agent started. Open it with Ctrl+B s."})));return
            }
            reply_data(app,&request,0,"",Some(json!({"attached":true})));
            let shell=app.shells.remove(&source);app.open_agent(&machine,id,Placement::Replace);if shell{app.shells.insert(source.clone());}
            visiting_shell_launch(app,&source,source_cwd,&machine,id);app.save_sessions();
        }else{finish(app,1,"The computer did not create the agent.")},
        Err(e)=>finish(app,1,&format!("Could not start: {e}")),
    }
}

/// The permission mode a guest's harness asks: @hn-permission-mode when [engine] has it (as New Harness reads it), or
/// auto. One setting serves every engine, and the owner's daemon refuses a mode the engine lacks.
fn guest_mode(engine: &str, option: Option<String>) -> String {
    option.filter(|m| crate::new_harness::data::modes(engine).iter().any(|(id, _)| id == m)).unwrap_or_else(|| "auto".into())
}

/// Whether a guest may start in [path]: its workspace ([home]) or a folder the owner shares, or below one. The owner's
/// daemon starts anything else in the workspace without saying so. Not loaded yet ([shared] none): its daemon decides.
fn guest_folder(path: &str, home: Option<&str>, shared: Option<&Vec<(String, bool)>>) -> bool {
    let Some(shared) = shared else { return true };
    if path.split('/').any(|part| part == "..") { return false }
    let under = |root: &str| { let root = root.trim_end_matches('/'); path == root || path.starts_with(&format!("{root}/")) };
    home.is_some_and(under) || shared.iter().any(|(folder, _)| under(folder))
}

/// What a composed command starts on a computer shared with this account: Claude Code or Codex in [cwd], on its
/// owner's plans, as New Harness starts it there. A task typed after the command is its first message; the
/// engine's own options are not for a guest's harness (cli core/agents/guestCreate.ts builds its command).
fn guest_launch(engine: &str, cwd: &str, args: &[String], permission_mode: &str) -> Result<Value, String> {
    if !["claude", "codex"].contains(&engine) { return Err("On a computer shared with you, start Claude Code or Codex.".into()) }
    if args.iter().any(|a| a.starts_with('-')) {
        return Err("On a computer shared with you, start it without options: it runs on its owner's plans.".into())
    }
    let mut payload = json!({ "engine": engine, "cwd": cwd, "creationId": uuid::Uuid::new_v4().to_string(),
        "bypassPermission": true, "permissionMode": permission_mode });
    let task = args.join(" ");
    if !task.trim().is_empty() { payload["prompt"] = json!(task.trim()) }
    Ok(payload)
}

/// The composer's `@ computer` rows.
fn host_rows(app: &App) -> Vec<Row> {
    // "This computer" stands in for this computer only until it has its own name: once the
    // daemon has registered it, that row is the same computer a second time.
    let named = app.fleet.registered_local_machine().is_some();
    app.fleet
        .machines
        .iter()
        .filter(|m| !m.shared && !(named && crate::local::is_local(&m.id)))
        .map(|m| {
            let unique = app
                .fleet
                .machines
                .iter()
                .filter(|other| other.name.eq_ignore_ascii_case(&m.name))
                .count()
                == 1
                && !m.name.contains(':');
            let id = if unique {
                m.name.as_str()
            } else {
                m.id.as_str()
            };
            // An offline computer stays a row the arrows reach (disabled, the list stood still
            // on the one connected computer), dim and after the connected ones a search finds;
            // choosing it says why it cannot be used.
            let mut row = Row::new(id, &m.name).extra(&m.id).right(if m.usable() { "connected" } else { crate::shell_picker::OFFLINE });
            if !m.usable() { row.label_dim = m.name.chars().count(); row.tier = 1 }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_composed_command_on_a_computer_shared_with_you_starts_claude_code_or_codex_as_new_harness_does() {
        // `claude @<shared computer> :<shared folder>`: one agent_create a guest may send, never shell-launch.
        let p = guest_launch("claude", "/Users/dee/projects/app", &[], "auto").unwrap();
        assert_eq!(p["engine"], "claude");
        assert_eq!(p["cwd"], "/Users/dee/projects/app");
        assert_eq!(p["permissionMode"], "auto");
        assert!(uuid::Uuid::parse_str(p["creationId"].as_str().unwrap()).is_ok());
        for key in ["argv", "grid", "model", "apiConnection", "dsh", "agent"] { assert!(p.get(key).is_none(), "{key} is not for a guest") }
        // A task typed after it is its first message.
        assert_eq!(guest_launch("codex", "/w", &["fix the login test".into()], "auto").unwrap()["prompt"], "fix the login test");
        // Its own options, and other agents, are refused with why.
        assert!(guest_launch("claude", "/w", &["--model".into(), "opus".into()], "auto").unwrap_err().contains("without options"));
        assert!(guest_launch("gemini", "/w", &[], "auto").unwrap_err().contains("Claude Code or Codex"));
    }

    #[test]
    fn a_guest_launch_asks_only_what_its_engine_has_in_a_folder_it_may_use() {
        // @hn-permission-mode is one setting for every engine; the daemon refuses a mode its engine lacks.
        assert_eq!(guest_mode("codex", Some("plan".into())), "auto");
        assert_eq!(guest_mode("claude", Some("plan".into())), "plan");
        assert_eq!(guest_mode("claude", None), "auto");
        // Its workspace or a folder the owner shares (and below them); the owner's daemon would start anything
        // else in the workspace without saying so.
        let shared = vec![("/Users/dee/code/app".to_string(), true)];
        let home = Some("/Users/Shared/HarnessGuests/hg_1/work");
        for ok in ["/Users/Shared/HarnessGuests/hg_1/work", "/Users/Shared/HarnessGuests/hg_1/work/sub", "/Users/dee/code/app", "/Users/dee/code/app/src"] {
            assert!(guest_folder(ok, home, Some(&shared)), "{ok}");
        }
        for no in ["/Users/dee", "/Users/dee/code/application", "/Users/dee/code/app/../secret", "/etc"] {
            assert!(!guest_folder(no, home, Some(&shared)), "{no}");
        }
        // Not loaded yet: the owner's daemon decides.
        assert!(guest_folder("/Users/dee", home, None));
    }

    #[test]
    fn offline_computers_are_listed_dim_after_the_connected_ones_never_disabled() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19449, sink, (100, 35));
        for (id, name, reach) in [("m1", "Mac Auto", crate::fleet::Reach::Ready), ("m2", "grid-dev", crate::fleet::Reach::Offline)] {
            app.fleet.machines.push(crate::fleet::Machine { id: id.into(), name: name.into(), shared: false, local: false,
                status: if reach == crate::fleet::Reach::Ready { "running" } else { "offline" }.into(), reach });
        }
        let rows = host_rows(&app);
        let row = |name: &str| rows.iter().find(|r| r.label == name).unwrap();
        assert!(rows.iter().all(|r| !r.disabled), "every computer is reachable");
        assert_eq!((row("Mac Auto").right.as_str(), row("Mac Auto").label_dim, row("Mac Auto").tier), ("connected", 0, 0));
        assert_eq!((row("grid-dev").right.as_str(), row("grid-dev").label_dim, row("grid-dev").tier), (crate::shell_picker::OFFLINE, 8, 1));
    }

    /// `claude @<computer>` on a computer the list says is up, which hn has no link to (dropped while it read
    /// offline, or never dialled), answered "That computer is offline". It is dialled now, and the launch
    /// waits for it as for one still connecting; one the list says is down is still offline.
    #[tokio::test]
    async fn a_composed_command_dials_a_computer_that_is_up_but_not_linked_yet() {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19449, sink, (100, 35));
        use crate::fleet::Reach;
        for (id, name, status, reach) in [("m1", "MacBooks-MacBook-Pro-9.local", "online", Reach::Offline), ("m2", "grid-dev", "online", Reach::Error("DISCONNECTED".into())),
            ("m3", "lab", "offline", Reach::Offline), ("m4", "air", "online", Reach::Ready)] {
            app.fleet.machines.push(crate::fleet::Machine { id: id.into(), name: name.into(), shared: false, local: false, status: status.into(), reach });
        }
        for name in ["MacBooks-MacBook-Pro-9.local", "grid-dev"] {
            wake(&mut app, name);
            let id = app.fleet.machines.iter().find(|m| m.name == name).unwrap().id.clone();
            assert_eq!(app.fleet.machine(&id).unwrap().reach, Reach::Connecting, "{name} is dialled");
            assert!(host(&app, "m4", Some(name), true).is_ok(), "{name}: the launch waits for it");
        }
        wake(&mut app, "lab");
        assert_eq!(app.fleet.machine("m3").unwrap().reach, Reach::Offline);
        assert_eq!(host(&app, "m4", Some("lab"), true).unwrap_err(), "That computer is offline. The command was not started.");
        wake(&mut app, "air");
        assert_eq!(app.fleet.machine("m4").unwrap().reach, Reach::Ready, "a linked computer is left as it is");
    }

    #[tokio::test]
    async fn connecting_remote_launch_waits_and_cancellation_prevents_late_work() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19448, sink, (100, 35));
        app.panes.insert(1, crate::pane::Pane::new(1, "local", "shell", 100, 32));
        app.fleet.machines.push(crate::fleet::Machine {
            id: "remote".into(), name: "Office".into(), shared: false, local: false,
            status: "running".into(), reach: crate::fleet::Reach::Connecting,
        });
        let request = Request {
            token: uuid::Uuid::new_v4().to_string(), id: "connecting-launch".into(), pane: 1,
            verb: "compose-launch".into(), at: Instant::now(),
            query: json!({"engine":"claude","host":"Office","path":"/project","cwd":"/local","args":[]}).to_string(),
        };
        launch(&mut app, request.clone());
        assert_eq!(app.shell_context.pending.as_ref().map(|r| r.id.as_str()), Some("connecting-launch"));
        assert!(app.shell_context.replies.is_empty(), "connecting must not be reported as offline");
        cancel(&mut app);
        let cancelled = app.shell_context.replies.len();
        app.fleet.machines[0].reach = crate::fleet::Reach::Ready;
        if let crate::event::Event::Apply(apply) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await.unwrap().unwrap() {
            apply(&mut app);
        } else { panic!("expected the bounded connection wait") }
        assert!(app.shell_context.pending.is_none());
        assert_eq!(app.shell_context.replies.len(), cancelled, "cancelled work must not restart when the connection opens");
        assert!(app.fleet.agents.is_empty());

        app.fleet.machines[0].reach = crate::fleet::Reach::Connecting;
        let mut expired = request.clone();
        expired.at = Instant::now() - Duration::from_secs(26);
        launch(&mut app, expired);
        assert!(app.shell_context.pending.is_none());
        assert_eq!(app.shell_context.replies.back().unwrap().code, 1);
        assert!(app.shell_context.replies.back().unwrap().text.contains("Could not connect"));

        launch(&mut app, request);
        app.panes.get_mut(&1).unwrap().agent_id = "another-shell".into();
        app.fleet.machines[0].reach = crate::fleet::Reach::Ready;
        if let crate::event::Event::Apply(apply) = tokio::time::timeout(Duration::from_secs(1), events.recv()).await.unwrap().unwrap() {
            apply(&mut app);
        } else { panic!("expected the pending connection wait") }
        assert!(app.shell_context.pending.is_none());
        assert_eq!(app.shell_context.replies.back().unwrap().code, 1);
        assert!(app.shell_context.replies.back().unwrap().text.is_empty(), "changing the source pane cancels the command");
        assert!(app.fleet.agents.is_empty());
    }

    #[test]
    fn large_folder_catalog_stays_within_transport_and_searches_beyond_first_batch() {
        let mut picker = Picker::new("", "");
        picker.search_extra = true;
        let mut rows: Vec<_> = (0..3000).map(|n| {
            let path = format!("~/work/{n:04}-{}", "project with spaces 日本語 ".repeat(4));
            Row::new(&path, &path)
        }).collect();
        let target = "~/other-work/autonomous-harness";
        rows.push(Row::new(target, target));
        picker.set_rows(rows);
        assert!(serde_json::to_vec(&crate::shell_picker::Items::from_picker(&picker)).unwrap().len() > 512 * 1024);
        let blank = folder_items(&mut picker, "");
        assert_eq!(blank.total_rows, Some(3001));
        assert!(blank.rows.len() < 3001);
        assert!(!blank.rows.iter().any(|r| r.id == target));
        for query in ["autonomous-harness", "atnmhrns"] {
            let found = folder_items(&mut picker, query);
            assert!(found.rows.iter().any(|r| r.id == target), "{query}");
            let frame = json!({"type":"shell_context_reply","payload":{"context":uuid::Uuid::new_v4().to_string(),"id":uuid::Uuid::new_v4().to_string(),"code":0,"text":"","data":found}});
            assert!(serde_json::to_vec(&frame).unwrap().len() < 256 * 1024);
        }
        assert!(serde_json::to_vec(&blank).unwrap().len() <= 192 * 1024);
        assert_eq!(picker.rows.len(), 3001, "search must retain the complete catalog");
    }
    #[test]
    fn folder_paths_resolve_on_the_selected_computer() {
        for (query, expected) in [
            ("", "/Users/ab"),
            ("code/", "/Users/ab/code"),
            ("code/autoh", "/Users/ab/code"),
            ("../", "/Users/ab/.."),
            ("~/code/", "/Users/ab/code"),
            ("/", "/"),
            ("/srv/projects/app", "/srv/projects"),
            ("code/client 日本/emp", "/Users/ab/code/client 日本"),
        ] {
            assert_eq!(
                folder_parent(query, "/Users/ab", Some("/Users/ab")).unwrap(),
                expected,
                "{query}"
            );
        }
        assert_eq!(
            folder_parent("code/", "/home/remote", Some("/home/remote")).unwrap(),
            "/home/remote/code"
        );
        assert!(folder_parent("~/", "/", None).is_err());
        assert!(folder_parent("code/", "", None).is_err());
    }
    #[test]
    fn unqualified_folder_search_covers_home_from_any_shell_directory() {
        for cwd in ["/private/tmp/hn-shell-first", "/Users/ab/code/one-project"] {
            for query in ["", "autonomous-harness", "atnmhrns"] {
                assert_eq!(folder_parent(query, cwd, Some("/Users/ab")).unwrap(), "/Users/ab");
            }
            assert_eq!(folder_parent("code/", cwd, Some("/Users/ab")).unwrap(), format!("{cwd}/code"));
        }
        assert!(folder_parent("project", "/private/tmp", None).is_err());
    }
    #[test]
    fn browsing_matches_child_names_and_selects_exact_literal_paths() {
        let snapshot = super::super::folders::Snapshot {
            root: Some("/home/test/code".into()),
            paths: [
                "/home/test/code",
                "/home/test/code/client 日本",
                "/home/test/code/literal $(echo x)",
                "/home/test/code/work/autonomous-harness",
            ]
            .map(str::to_string)
            .to_vec(),
            notice: String::new(),
            revision: 1,
        };
        let rows = folder_rows(&snapshot, Some("/home/test"), true);
        assert_eq!(
            rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            [
                "~/code",
                "~/code/client 日本",
                "~/code/literal $(echo x)",
                "~/code/work/autonomous-harness"
            ]
        );
        assert_eq!(rows[0].label, ".");
        assert_eq!(rows[1].label, "client 日本/");
        assert!(
            rows[1].extra.is_empty(),
            "parent must not match every child"
        );
        let mut picker = Picker::new("", "");
        picker.set_rows(rows);
        picker.query = "atnmhrns".into();
        picker.refilter();
        assert_eq!(
            picker.current_id().as_deref(),
            Some("~/code/work/autonomous-harness")
        );
        picker.query = "code".into();
        picker.refilter();
        assert!(
            picker.visible.is_empty(),
            "common parent matched every descendant"
        );
    }
    #[test]
    fn explicit_models_do_not_change_pane_defaults() {
        let route = Route {
            grid: "Office".into(),
            model: "qwen".into(),
            label: "Office".into(),
        };
        let mut l = Launch {
            engine: "claude".into(),
            model: Some("sonnet".into()),
            args: vec!["task".into()],
            ..Launch::default()
        };
        let (args, r) = model_args(&l, Some(route.clone())).unwrap();
        assert_eq!(args, ["--model", "sonnet", "task"]);
        assert!(r.is_none());
        l.model = Some("default".into());
        assert!(model_args(&l, Some(route.clone())).unwrap().1.is_none());
        l.model = None;
        assert_eq!(model_args(&l, Some(route.clone())).unwrap().1, Some(route));
        l.engine = "codex".into();
        l.model = Some("sonnet".into());
        assert!(model_args(&l, None).is_err());
        l.model = None;
        l.args = vec!["-p".into(), "work".into()];
        assert!(
            model_args(
                &l,
                Some(Route {
                    grid: "Office".into(),
                    model: "qwen".into(),
                    label: "Office".into()
                })
            )
            .unwrap()
            .1
            .is_none()
        );
    }
}
