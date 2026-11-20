# Harness Pro firmware: the cable and model take every app's agents, the app list and caps (item B)

Status: design for review. Base: `main` 3daf515733. Part of the Pro parity work split in
`docs/plans/2026-11-20-pro-parity-split.md` (sections 1, 3, 5 and 6 apply). Item A builds the daemon side; item C draws
the pill, the Apps screen and the rooms; item E builds the app icons. This item changes no drawing.

## Goal

The Pro firmware (`devices/harness-pro/firmware`) says what the round dial says in its hello, reads the same app data
off the cable, and holds it in Pod's model in exactly the shape the split doc fixes, so item C can draw it:

- the hello adds `appFilter: "v1"`, `questionTier: "v1"`, `appCards: "v1"`;
- the welcome's `apps.switch` and `question.tier` features are read;
- `apps` frames become the model's app list; `app.pick` can be sent;
- `agent` carries `host` and `caps`; `agents.end` carries `view` and `tab`;
- a question re-filed with `tier: "list"` is a silent row;
- an agent without voice never opens the microphone, and a tap says "See it in <App>" for 2 s.

Success: the host tests feed raw frames and see the model and the sends change as below; the golden screens are
unchanged; the ESP-IDF build compiles.

## What exists (read in code)

- `main/cable/pro_cable.c` parses frames on the cable_link task into static scratch and calls `pro_app_*`
  (`main/pro_app_api.h`). `send_hello` (:217) lists six capabilities. `handle_agent` (:396) keeps id, name, engine,
  machine id and machine; `handle_agents_end` (:417) ignores its payload. `handle_question` (:679) ignores `tier`.
  `apps` is counted as unknown.
- `main/cable/cable_features.c` reads only `player.library` and `resync`, with the 16-entry rule.
- `main/app/pro_app.c` owns the one `pod_ui_t` (`s_pod`, model inside), takes its recursive lock in every entry,
  and feeds the model through `pod_glue` (`pod_ui_roster` calls `pod_model_agents_begin/agent/end`).
  `pro_app_voice_block_reason` (:605) is the only gate before `pro_voice_begin`; a refusal is shown by
  `pod_ui_notice` (3 s) from `voice_begin_effect`.
- `pod_glue.*`, `pod_nav`, `pod_view`, `home/*` belong to item C and are not edited here.
- Round dial reference: `devices/harness-device/firmware/main/cable_client.c` (`handle_apps`, `caps_of`,
  `handle_agent`, `handle_agents_end`, `cable_client_pick_app`, `handle_question`) and `ui_habitat.c` `host_name`.

## Design

### 1. Shared shapes (`main/cable/cable_types.h`, `main/pod/pod_model.h`) — the first task, item C codes against it

`cable_types.h` (pure C, already shared by cable and model):

```c
#define CABLE_APPS_MAX   16   // the daemon's APP_LIMIT (cli/src/cable/hosts/select.ts)
#define CABLE_APP_ID_MAX 16   // an id goes back in app.pick, so one that does not fit is dropped, never cut
typedef struct { char id[CABLE_APP_ID_MAX]; char name[24]; uint8_t count, waiting, working; } cable_app_t;
```

`pod_model.h` (the split doc's interface, word for word where it names something):

```c
#define POD_APPS_MAX CABLE_APPS_MAX                 // 16
typedef cable_app_t pod_app_t;                      // { char id[16]; char name[24]; uint8_t count, waiting, working; }
enum { POD_CAP_S = 1, POD_CAP_V = 2, POD_CAP_F = 4, POD_CAP_A = 8, POD_CAPS_ALL = 15 };

pod_agent_t   += char host[16];   // the app the agent lives in ("codex", "vscode", ...), "" when not said
                 uint8_t caps;    // POD_CAP_* granted; POD_CAPS_ALL when the daemon sent no caps, and for every agent
                                  // that came from the library or a tab's members (no `agent` row)
pod_model_t   += pod_app_t apps[POD_APPS_MAX]; uint8_t app_count;
                 char app_shown[CABLE_APP_ID_MAX];   // `shown`: the app whose ring the daemon sends ("" none)
                 bool apps_switch;    // the welcome listed `apps.switch`
                 bool machine_view;   // the last agents.end said view:"machine"
                 bool has_window;     // a Harness window is open: the last agents.end's tab was non-empty,
                                      // OR the last swarms frame listed at least one tab (PM note, item A:
                                      // while the view is apps the daemon sends tab:"" but keeps sending swarms)
                 bool tab_open; uint8_t swarm_n;      // the two inputs of has_window (model-private by comment)

void pod_model_apps(pod_model_t *, const pod_app_t *apps, int n, const char *shown);   // the whole list, replaced
void pod_model_apps_switch(pod_model_t *, bool on);
void pod_model_view(pod_model_t *, bool machine_view, bool tab_open);                  // from agents.end
void pod_model_agent_app(pod_model_t *, const char *id, const char *host, uint8_t caps);   // after the roster
const char *pod_host_name(const char *host);     // "ChatGPT" for codex; unknown or NULL: "Terminal"
const char *pod_host_see_it(const char *host);   // "See it in ChatGPT": a literal, valid forever
```

- `pod_host_name` is the table of `ui_habitat.c:536-541` (orca Orca, herdr herdr, rex Rex, zellij Zellij, tmux tmux,
  kitty kitty, wezterm WezTerm, ghostty Ghostty, cmux cmux, iterm iTerm2, vscode VS Code, cursor Cursor, warp Warp,
  claude Claude, codex ChatGPT, opencode opencode, harness Harness), "Terminal" otherwise. One table holds both
  strings (`"See it in " "ChatGPT"` joined at compile time), so `pod_host_see_it` returns a literal and the voice gate
  can return it after its lock is released.
- `pod_model_apps`: copies at most 16 rows, bumps `revision` only when the list or `shown` changed (an unchanged
  push costs no redraw). `swarm_n` is recorded in `pod_model_swarms_meta` (which every swarms frame and every roster
  reaches through `rebuild_tabs`); `has_window = tab_open || swarm_n > 0`, recomputed in both feeds.
- `pod_model_agent_app` is a setter on an agent already in the roster (unknown id: ignored), with a revision bump on
  change. It exists because the roster goes through `pod_glue` (item C's file), whose row has no host or caps;
  `pro_app_agents` calls it for every row right after `pod_ui_roster`, inside the same lock, so no frame sees a row
  without its caps. A new agent starts with `caps = POD_CAPS_ALL` (`init_agent`).
- `pod_model_link(m, false)` clears the apps, `app_shown`, `apps_switch`, `machine_view` and `tab_open` (the next
  session says them again). `swarm_n` stays with the tabs, as the tabs do today.

### 2. Cable in (`main/cable/pro_cable.c`, `cable_features.c/h`)

- **Hello** adds `appFilter: "v1"`, `questionTier: "v1"`, `appCards: "v1"` (after `ota`). The 16-entry cap on the
  welcome's features is unchanged; with these the daemon lists at most 11 (split doc).
- **Features**: `CABLE_FEATURE_APPS_SWITCH` (`apps.switch`), `CABLE_FEATURE_QUESTION_TIER` (`question.tier`).
  `session_up` hands `apps.switch` to `pro_app_apps_switch(bool)` on every welcome (a keepalive welcome returns early
  today; this call goes before that return, so a daemon that restarted inside the silence window is read again).
- **`apps`** `{shown, apps:[{id, name, count, waiting, working?}]}`, as the round's `handle_apps`: not an array keeps
  the current list; at most 16 rows (the loop stops there); an id empty or of 16 B or more is dropped, never cut; a
  second row with the same id is dropped; the name is cut between UTF-8 letters (`copy_cut`, 23 B); `count`, `waiting`,
  `working` are whole numbers clamped to 0..255 (absent, negative, NaN or not a number: 0), then `waiting` and
  `working` clamped to `count`; a `shown` of 16 B or more becomes "". Parsed into a static `cable_app_t[16]` and handed
  whole: `pro_app_apps(rows, n, shown)`. An empty array is a real list (no apps). Log: `apps: %d`.
- **`agent`** reads `host` (kept only when shorter than 16 B, else "") and `caps`: letters s v f a; absent means all
  four; a present string grants exactly its letters (unknown letters grant nothing), as `caps_of`. The row carries
  `host` and `caps_off` (the letters withheld), so a zero-filled row means "all allowed" and no caller can block voice
  by forgetting a field.
- **`agents.end`** reads `view` (`"machine"` only counts) and `tab` (non-empty string = a window). Absent fields (an
  older daemon): `machine_view` false, `tab_open` false. Passed with the roster:
  `pro_app_agents(rows, n, machine_view, tab_open)`.
- **`question`** with `tier: "list"` is filed silent only when the session's welcome listed `question.tier`; any other
  value, none, or no feature is an alert as today: `pro_app_question(id, request, text, list)`.

### 3. Cable out

`bool pro_cable_send_app_pick(const char *app)`: `{t:"app.pick", app}`; false without sending for NULL, "" or an id
of 16 B or more (only an id that could have arrived whole). Item C calls it on a card tap; nothing in this item does.

### 4. App layer (`main/app/pro_app.c/h`, `main/pro_app_api.h`)

- `pro_app_apps(rows, n, shown)` and `pro_app_apps_switch(on)`: lock, feed the model, mark dirty on a revision
  change.
- `pro_app_agents(rows, n, machine_view, tab_open)`: as today, then `pod_model_agent_app` per row and
  `pod_model_view`.
- `pro_app_question(..., list)`: a list question is filed as today (open-question set, the `ask` row in Notices, the
  request hash) with `POD_TIER_LIST`: no beep, no wake, no toast. An alert is unchanged.
- **Voice follows caps.** `pro_app_voice_block_reason`: after the update and link checks, an agent in the roster
  whose `caps` lacks `POD_CAP_V` returns `pod_host_see_it(host)` before any other per-agent reason (it is where the
  person must go, whatever else is true). `voice_begin_effect` already refuses on any reason, so the recorder never
  starts; for this reason it shortens the notice to 2 s (`s_pod.notice_until = now + 2000` after `pod_ui_notice`), as
  the round dial's hint. A voice start with no agent (the daemon routes it) is not gated by caps.
- Taps that open an agent are not gated here: on an app's ring the daemon answers `agent.open` of an agent without
  `f` by only marking it seen (split doc 1(d)), as for the round dial.

### 5. README

`devices/harness-pro/README.md` "Daemon contract": nine capabilities (the three new ones, one line each), and the
welcome features the Pro reads (`player.library`, `resync`, `apps.switch`, `question.tier`).

## Errors and logs

Malformed rows are dropped as the round does; a malformed list keeps the last. Logs: fixed words and counts only
(`apps: %d`, the existing `agents: %d` gains the view as a word: `agents: %d (machine)` / `(no window)`); no ids,
names or hosts of agents or apps.

## Testing (no hardware)

Red then green per task:

- `test/test_pod_model.c`: apps replace / unchanged list keeps the revision / 16 cap / shown; `has_window` from tab
  and from swarms (the PM note's case: tab "" and swarms with tabs → true; both empty → false); `machine_view`;
  `pod_model_agent_app` caps and host, default `POD_CAPS_ALL` for a library agent; link down clears;
  `pod_host_name` / `pod_host_see_it` for codex, claude, an unknown and NULL.
- `test/test_pro_cable.c` (raw JSON frames into `pro_cable_on_frame`, recorded `pro_app_*` calls): `apps` good rows;
  17 rows; long id; duplicate id; name cut mid-letter; counts negative, 300, NaN, string, working > count; not an
  array; empty array; long `shown`. `agent` host/caps (absent, "sf", "", unknown letters, long host). `agents.end`
  view/tab (absent, machine, ""). `question` tier list with and without the welcome feature, tier "alert", no tier.
  Features: both read, the 17-entry list still gives 0. `app.pick` sent, refused for "", 16 B.
- `test/test_pro_hello.py`: the three hello keys.
- `test/test_pro_app.py` (wire-driven): a no-`v` agent's voice start sends no `voice.begin`, shows "See it in
  ChatGPT" and the notice ends at 2 s; an agent with all caps records as before; a list-tier question files the row
  with no beep and no wake; `apps` and `agents.end` reach the model.
- `test/test_pro_voice_gate.py`: updated for the new `pro_app_agents` / `pro_app_question` signatures only.
- Unchanged and run: `test/run.sh`, `test_tree_isolation.py`, `test_fonts.py`, `golden.sh --check` (must match).
- Compile only: `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-pod build`. PR CI runs the
  real build and the ota_0 size check. Never flash, monitor or open a serial port.

## Files

`main/cable/*` (pro_cable.c/h, cable_features.c/h, cable_types.h), `main/pod/pod_model.c/h`, `main/app/pro_app.c/h`,
`main/pro_app_api.h` (the cable-to-app interface; no other item touches it), `test/test_pro_cable.c`,
`test/test_pod_model.c`, `test/test_pro_hello.py`, `test/test_pro_app.py`, `test/test_pro_voice_gate.py` (signature
update only), `devices/harness-pro/README.md`. `pod_types.h` needs no change. Not touched: `pod_glue.*`, `pod_nav`,
`pod_view`, `home/*`, golden files, app icons, `cli/`.

## Platforms

Firmware only. Host tests run on macOS and Linux (CI). Nothing OS-specific.

## Out of scope

Drawing (item C), icons (item E), daemon (item A), custom pets, `answer` / `turn.send` / `swarm.select`.
