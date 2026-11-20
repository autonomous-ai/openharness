# Harness Pro firmware: the cable and model take every app's agents, the app list and caps (item B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(pro): <the task's message> (red)` once its failing tests have been run and seen to fail, then `feat(pro): <the task's message>`. No task pushes or merges.

**Goal:** The Pro firmware says the round dial's three app capabilities in its hello, reads `apps`, `host`/`caps`, `view`/`tab` and `question` `tier` off the cable, holds them in Pod's model in the shape the split doc fixes, can send `app.pick`, and never opens the microphone for an agent without voice.

**Architecture:**
- **Model** (`main/pod/pod_model.*`, `main/cable/cable_types.h`, pure C): the app list, the window flags, per-agent `host` and `caps`, and the host-name table. Task 1 lands it alone; item C codes against it.
- **Cable** (`main/cable/*`, cable_link task): parses the new fields into static scratch and calls `pro_app_*` (`main/pro_app_api.h`) with whole lists.
- **App** (`main/app/pro_app.c`): feeds the model under its one lock; the voice gate reads `caps`. No drawing changes anywhere.

**Tech Stack:** C11 on ESP-IDF 5.5.4 (ESP32-P4); host tests in C (cJSON from the IDF checkout) and Python 3 drivers.

**Spec:** `docs/plans/2026-11-20-pro-firmware-app-data-design.md` (approved). Read it with this plan, the root `AGENTS.md`, `devices/harness-pro/README.md`, and sections 1, 3, 5, 6 of the split doc (`docs/plans/2026-11-20-pro-parity-split.md`, kept outside this worktree; the spec quotes what applies). Reference only, never edited or included by path: the round dial's `cable_client.c` (`handle_apps`, `count_of`, `caps_of`, `handle_question`, `cable_client_pick_app`) and `ui_habitat.c` `host_name`.

## Base

- Branch `feat/pro-firmware-app-data` at `3daf515733`, worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/pro-B-firmware-cable`. Nothing else has to merge first.
- Needs: ESP-IDF 5.5.4 at `~/esp/esp-idf-5.5.4` (its `components/json` for the cable test; `IDF_PATH` overrides), `python3` with Pillow, a C compiler.
- Names at the base (tasks name functions, never lines):
  - `pod_model.c`: `init_agent`, `pod_model_agent`, `pod_model_swarms`, `pod_model_swarms_meta`, `pod_model_link`, `pod_copy_str`; `pod_model_t.revision`.
  - `pro_cable.c`: `copy_cut`, `str_of`, `send_json`, `msg`, `msg_string`, `send_hello`, `agent_store_t`, `s_agent_store`, `s_agent_rows`, `handle_agent`, `handle_agents_end`, `handle_question`, `session_up` (its `if (was && !moved) return;`), `handle_message`, `s_features`.
  - `pro_app.c`: `settle`, `leave`, `s_rows`, `pro_app_agents`, `pro_app_question` (`set_add(s_quest…)`, `s_alerted_h`, `pod_ui_notify_text(… POD_TIER_ALERT …)`), `pro_app_voice_block_reason`, `voice_begin_effect`.
  - `test_pro_cable.c`: the recorder (`EV_*`, `add`, `put`, `evs`, `nev`), `reset`, `feed`, `feedf`, `repeat`, `utf8_ok`, `welcome`, `parse_heavy`, `send_shapes`, `main`'s call list.
  - `test_pod_model.c`: `M`, `fresh`, `CHECK`, `main`'s call list.
  - `test_pro_app.py`: `setup`, `agent`, `render`, `tap`, `tap_talk`, `tap_stale_talk`, `notif_room`, `top`, `R.begins`, `V`, `BEEPS`, `LOCK_DEPTH`, `U`, `now`, `pro_app_test_take_dirty`, the `tests[]` table.
  - `test_pro_voice_gate.py`: `ROWS`, `situation`, `question_agent_says_why`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Commands

Run from the repo root. Each task's last run is `ALL`, which adds the stack caps the narrow runs leave out.

- **ALL:** `bash devices/harness-pro/firmware/test/run.sh` (passes when its last line is the recorder test's, exit 0).
- **MODEL** (`test_pod_model.c` alone), pass line `Pod model: PASS (N checks)`:
  `cd devices/harness-pro/firmware && out=$(mktemp -d) && python3 scripts/gen_fonts.py --font fonts/LiberationSans-Regular.ttf --out $out/pro_fonts.c >/dev/null && cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize=undefined,bounds -DHT_FACE_PX=720 -Imain/display -Imain -o $out/t test/test_pod_model.c main/pod/*.c main/pod/home/*.c main/app/pod_glue.c main/display/scroll.c main/display/pro_canvas.c main/display/terminal.c $out/pro_fonts.c && $out/t`
- **CABLE** (`test_pro_cable.c` alone), pass line `test_pro_cable: N checks passed`:
  `cd devices/harness-pro/firmware && out=$(mktemp -d) && cj=${IDF_PATH:-$HOME/esp/esp-idf-5.5.4}/components/json/cJSON && cc -std=c11 -D_DEFAULT_SOURCE -w -O1 -g -c -o $out/cJSON.o $cj/cJSON.c && cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize=undefined,bounds -Imain -Imain/cable -Itest/host_esp -I$cj -o $out/t test/test_pro_cable.c main/cable/pro_cable.c main/cable/cable_json_guard.c main/cable/cable_features.c main/cable/cable_machines.c main/cable/cable_scroll.c main/cable/cable_frame.c $out/cJSON.o -lpthread -lm && $out/t`
- **APP `<case>`:** `PRO_APP_TEST=<case> python3 devices/harness-pro/firmware/test/test_pro_app.py` (pass: `PASS <case>`; an unregistered name runs nothing, so register the case first).
- **VOICE:** `python3 devices/harness-pro/firmware/test/test_pro_voice_gate.py`. **HELLO:** `python3 devices/harness-pro/firmware/test/test_pro_hello.py`.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The model holds apps, the window flags, host and caps | `main/cable/cable_types.h`, `main/pod/pod_model.h`, `main/pod/pod_model.c`, `test/test_pod_model.c` | none | high | `test_pod_model.c` |
| 2 The welcome's `apps.switch` and `question.tier` are read | `main/cable/cable_features.h`, `main/cable/cable_features.c`, `test/test_pro_cable.c` | none | medium | `test_pro_cable.c` |
| 3 `apps` frames become the model's app list | `main/pro_app_api.h`, `main/cable/pro_cable.c`, `main/app/pro_app.c`, `test/test_pro_cable.c`, `test/test_pro_app.py` | 1, 2 | high | `test_pro_cable.c`, `test_pro_app.py` |
| 4 `agent` carries host and caps; `agents.end` carries view and tab | `main/pro_app_api.h`, `main/cable/pro_cable.c`, `main/app/pro_app.c`, `test/test_pro_cable.c`, `test/test_pro_app.py`, `test/test_pro_voice_gate.py`, `test/stress_pro_app.c` (one call, PM yes) | 1 | high | `test_pro_cable.c`, `test_pro_app.py` |
| 5 A question told again with `tier: "list"` is a silent row | `main/pro_app_api.h`, `main/cable/pro_cable.c`, `main/app/pro_app.c`, `test/test_pro_cable.c`, `test/test_pro_app.py`, `test/test_pro_voice_gate.py` | 2 | high | `test_pro_cable.c`, `test_pro_app.py` |
| 6 An agent without voice never opens the microphone | `main/app/pro_app.c`, `main/app/pro_app.h` (one comment), `test/test_pro_app.py` | 1, 4 | high | `test_pro_app.py` |
| 7 The Pro can send `app.pick` | `main/cable/pro_cable.h`, `main/cable/pro_cable.c`, `test/test_pro_cable.c` | 1 | medium | `test_pro_cable.c` |
| 8 The hello says the three capabilities; README contract | `main/cable/pro_cable.c` (`send_hello` only), `test/test_pro_hello.py`, `devices/harness-pro/README.md` | 3, 4, 5, 6 | medium | `test_pro_hello.py` |

Longest chain: four tasks (1 → 4 → 6 → 8). Shared files serialize more than the dependencies do: 3, 4, 5 and 7 all edit `pro_cable.c` and `test_pro_cable.c`; 3, 4, 5 and 6 all edit `pro_app.c` and `test_pro_app.py`. What can run together: 1 with 2, and 6 with 7. Task 8 depends on 3–6 for a real reason: the hello is the switch that turns the daemon's output on, and a commit that says `questionTier` or `appFilter` before the firmware reads `tier` and `caps` would beep re-told questions and open the microphone on agents without voice (split doc 1(c)).

## Layers

| File | Layer | Gate |
|---|---|---|
| `main/pod/pod_model.*`, `main/cable/cable_types.h` | Pod's pure-C model: no ESP-IDF, no clock; written on the cable_link task under pro_app's lock | MODEL, ALL (frames ≤ 1 KB) |
| `main/cable/*` | cable client on the cable_link task (12 KB stack; every frame ≤ 1 KB, so parse scratch is static) | CABLE, HELLO, ALL |
| `main/app/pro_app.*`, `main/pro_app_api.h` | app layer: one recursive lock, sends only after it is released | APP, VOICE, ALL |

Not changed, and a diff in any is a finding: `main/app/pod_glue.*`, `main/pod/pod_nav.*`, `main/pod/pod_view.*`, `main/pod/home/*`, `main/pod/pod_types.h`, `test/golden*.txt`, `test/golden.sh`, `test/pod_render.*`, app icons, `main/CMakeLists.txt`, `devices/harness-pro/docs/cable.md` (item A), anything under `cli/`.

## Global Constraints

- **Hardware:** never flash, never run `flash.sh`/esptool, no `idf.py flash` or `idf.py monitor`, never open a serial port, never touch Diego's devices (the Pro's power latch bricks it on a wrong-revision image). Compile only.
- **Logs:** fixed words and counts only: `apps: %d`; `agents: %d`, plus ` (machine)` when `machine_view`, else ` (no window)` when `!tab_open`. No ids, names or hosts of agents or apps.
- **Copy:** `pod_host_name` table exactly as spec §1 (orca Orca, herdr herdr, rex Rex, zellij Zellij, tmux tmux, kitty kitty, wezterm WezTerm, ghostty Ghostty, cmux cmux, iterm iTerm2, vscode VS Code, cursor Cursor, warp Warp, claude Claude, codex ChatGPT, opencode opencode, harness Harness; anything else, `""` or NULL: Terminal). The notice is `See it in ` + that name.
- **Tree isolation:** no `.c`, `.h` or `.py` under `devices/harness-pro` may contain the string `harness-device` (`test_tree_isolation.py`). Cite the round dial by function name ("the round dial's `handle_apps`"), never by path.
- **Stack:** parse scratch on the cable task is file-static (`run.sh` caps every cable, model and app frame at 1 KB).
- **No drawing change:** `golden.sh --check` matches at every commit.
- **Repo rules:** red test first at the layer where the behavior lives; no fixed sleeps (the fake clock `now`); comments say why; no dead code.

## Review Focus

1. **A daemon that restarted inside the silence window and no longer lists `apps.switch`.** Expected: its keepalive welcome turns `apps_switch` off. Task 3, `apps_switch_on_every_welcome`.
2. **The same `apps` list pushed again and again.** Expected: no revision bump, no redraw. Task 1 `pod_model_test_apps`; Task 3 `apps_reach_the_model` (`pro_app_test_take_dirty()` false on the second push).
3. **A `shown` that names no row.** Expected: kept as sent (the round keeps it; item C finds no card). Task 3, `apps_rows`.
4. **An agent with no `agent` row (library-only, an offline tab member) and a voice start with no agent.** Expected: voice as today, never "See it in". Task 1 `pod_model_test_agent_app`; Task 6 `voice_needs_the_v_cap`.
5. **A re-told question (`tier: "list"`) while the glass is dark.** Expected: it stays dark and silent, yet the row is in Notices and voice still says "Answer its question first." Task 5, `question_list_tier_is_quiet`.

## Decided (the PM, 2026-11-20)

The spec as written: `has_window = tab_open || swarm_n > 0` (the last `agents.end`'s `tab` non-empty, or the last swarms frame listed at least one tab); host and caps reach the model through `pod_model_agent_app`, called by `pro_app_agents` after `pod_ui_roster` (`pod_glue.*` is item C's and is not edited); `pro_agent_row_t` carries `caps_off` (zero = all allowed); the "See it in <App>" notice lasts 2 s by setting `s_pod.notice_until` in `pro_app`; `main/pro_app_api.h` may be edited, `test_pro_voice_gate.py` only for the new signatures.

## Decided here, where the spec was silent

- **`swarm_n`** is the `n` that reaches `pod_model_swarms_meta` (every item the frame listed after the parser's id checks, clamped to `POD_TABS_MAX`; NULL items: 0), before the model hides tabs with no agent: "listed", not "shown".
- **`has_window` is recomputed** in `pod_model_view`, `pod_model_swarms_meta` and `pod_model_link(m, false)`, so `has_window == (tab_open || swarm_n > 0)` always holds.
- **Revision:** every new setter bumps `revision` only when a field a reader sees changed (`apps`, `app_count`, `app_shown`, `apps_switch`, `machine_view`, `has_window`, an agent's `host` or `caps`); `tab_open` and `swarm_n` alone do not.
- **Counts** follow the round dial's `count_of`, clamped to 255: not a number or not `> 0` (negative, NaN, absent): 0; `> 255` (and infinity): 255; else truncated (2.7 → 2); then `waiting` and `working` clamped to `count`. NaN cannot be written in JSON text, so the test covers it through `!(v > 0)` only.
- **`caps` present but not a string** is "not said" (all four), as the round's `caps_of(str_of(...))`.
- **Order in `pro_app_agents`:** `pod_ui_roster` → `pod_model_agent_app` for each row that went into the roster → `pod_model_view` → `settle` with the roster's effect, all inside the one lock.
- **The 2 s notice** is chosen by an internal `static const char *block_reason(const char *agent_id, bool *see_it)`; `pro_app_voice_block_reason(id)` returns `block_reason(id, NULL)`, and `voice_begin_effect` calls `block_reason(agent, &see_it)`.
- **`app.pick`** goes out with `send_json` (it waits), as `agent.open` does.
- **Existing test callers:** positional `(pro_agent_row_t){...}` initializers gain `, NULL, 0`; `pro_app_agents(rows, n)` becomes `pro_app_agents(rows, n, false, true)` (today's tests model an open window); `pro_app_question(id, req, text)` becomes `pro_app_question(id, req, text, false)`. No other edit to those tests.
- **The `pro_app_apps_switch` stub** in `test_pro_cable.c` records into its own counters, not `evs[]`, so the existing "a welcome makes one `EV_LINK`" checks stay as they are.

---

### Task 1: The model holds apps, the window flags, host and caps

**Depends on:** none. **Effort:** high.

**Files:**
- Modify: `devices/harness-pro/firmware/main/cable/cable_types.h`
- Modify: `devices/harness-pro/firmware/main/pod/pod_model.h`, `devices/harness-pro/firmware/main/pod/pod_model.c` (`init_agent`, `pod_model_swarms_meta`, `pod_model_link`, new setters and the host table)
- Test: `devices/harness-pro/firmware/test/test_pod_model.c`

**Interfaces:**
- Produces, verbatim from spec §1 (its two code blocks are the contract item C codes against): `CABLE_APPS_MAX` 16, `CABLE_APP_ID_MAX` 16, `cable_app_t`; `POD_APPS_MAX`, `pod_app_t`, `POD_CAP_S/V/F/A`, `POD_CAPS_ALL`; `pod_agent_t.host[16]`, `.caps`; `pod_model_t.apps[]`, `.app_count`, `.app_shown[CABLE_APP_ID_MAX]`, `.apps_switch`, `.machine_view`, `.has_window`, `.tab_open`, `.swarm_n`; and
  - `void pod_model_apps(pod_model_t *, const pod_app_t *apps, int n, const char *shown);` (`n` clamped to 0..16, NULL `apps`: 0 rows, NULL `shown`: ""; rows past `n` zeroed so an unchanged push compares equal)
  - `void pod_model_apps_switch(pod_model_t *, bool on);`
  - `void pod_model_view(pod_model_t *, bool machine_view, bool tab_open);`
  - `void pod_model_agent_app(pod_model_t *, const char *id, const char *host, uint8_t caps);` (unknown id ignored; NULL `host`: ""; stores `caps & POD_CAPS_ALL`)
  - `const char *pod_host_name(const char *host);`, `const char *pod_host_see_it(const char *host);` (one static table of `{id, name, "See it in " name}` built by a macro, so both return literals)

- [ ] **Step 1: Write the failing tests** in `test_pod_model.c`, each added to `main`:
  - `pod_model_test_apps`: three rows `{codex, ChatGPT, 3, 1, 2}`, `{vscode, VS Code, 1, 0, 0}`, `{warp, Warp, 2, 2, 0}` with shown `"codex"` → `app_count == 3`, rows equal field by field, `app_shown == "codex"`, revision bumped. The same call again → revision unchanged. Shown `"vscode"` → bumped. 17 rows → `app_count == 16`. `n == 0` → `app_count == 0`, bumped. Shown NULL → `""`.
  - `pod_model_test_apps_switch`: `false → true` bumps and sets; `true` again does not bump.
  - `pod_model_test_window`: fresh model → `!has_window`. `pod_model_view(&M, false, true)` → `has_window`, `!machine_view`. `pod_model_view(&M, true, false)` with no swarms → `machine_view`, `!has_window`. One swarm item with `agents = 0, panes = 1` through `pod_model_swarms` (a tab the model hides) then `pod_model_view(&M, false, false)` → `has_window` (the PM's case: `tab: ""` while swarms list a tab). Swarms `n = 0` → `!has_window`. The same `pod_model_view` twice → the second leaves `revision` unchanged.
  - `pod_model_test_agent_app`: after `fresh()`, `a1` has `caps == POD_CAPS_ALL`, `host == ""`. `pod_model_agent_app(&M, "a1", "codex", POD_CAP_S | POD_CAP_F)` → stored, bumped; again → not bumped. Unknown id `"zz"` → no agent added, not bumped. A new agent from `pod_model_library_row` and an offline member from `pod_model_swarms_meta` (`meta.has`, `!online`) both have `caps == POD_CAPS_ALL`.
  - `pod_model_test_link_clears_apps`: set apps, `apps_switch`, `pod_model_view(&M, true, true)`, one swarm item; `pod_model_link(&M, true)` then `(&M, false)` → `app_count == 0`, `app_shown == ""`, `!apps_switch`, `!machine_view`, `!tab_open`, `swarm_n == 1`, `has_window` (the tabs stay, as today). Repeat with swarms `n = 0` before the drop → `!has_window` after it.
  - `pod_model_test_host_names`: every one of the 17 table pairs; `codex` → `"ChatGPT"` and `"See it in ChatGPT"`; `claude` → `"See it in Claude"`; `"nope"`, `""` and NULL → `"Terminal"` and `"See it in Terminal"`; `pod_host_see_it("codex") == pod_host_see_it("codex")` (one literal).

- [ ] **Step 2: Run to verify they fail.** Run: MODEL. Expected: FAIL to build (`pod_model_apps`, `POD_CAPS_ALL` … undeclared).

- [ ] **Step 3: Commit red:** `test(pro): the model holds apps, the window flags, host and caps (red)` (only `test_pod_model.c`).

- [ ] **Step 4: Implement** the Interfaces above. `init_agent` sets `caps = POD_CAPS_ALL`. `pod_model_swarms_meta` records `swarm_n` and recomputes `has_window` ("Decided here"). `pod_model_link(m, false)` clears what spec §1 lists and recomputes `has_window`. Header comments say what each field means, that `tab_open` and `swarm_n` are the model's own inputs, and where caps come from.

- [ ] **Step 5: Run to verify they pass.** Run: MODEL, then ALL. Expected: `Pod model: PASS`, ALL exit 0.

- [ ] **Step 6: Commit:** `feat(pro): the model holds apps, the window flags, host and caps`.

---

### Task 2: The welcome's `apps.switch` and `question.tier` are read

**Depends on:** none. **Effort:** medium.

**Files:**
- Modify: `devices/harness-pro/firmware/main/cable/cable_features.h`, `devices/harness-pro/firmware/main/cable/cable_features.c`
- Test: `devices/harness-pro/firmware/test/test_pro_cable.c` (one new case and `#include "cJSON.h"`)

**Interfaces:**
- Produces: `CABLE_FEATURE_APPS_SWITCH = 1u << 2`, `CABLE_FEATURE_QUESTION_TIER = 1u << 3`, each with a one-line comment on what the daemon promises (the round's wording). The 16-entry rule is unchanged.

- [ ] **Step 1: Write the failing test** `features_apps_switch_and_question_tier` (cJSON_Parse a welcome, `cable_features_parse`, cJSON_Delete): `["apps.switch","question.tier","resync"]` → all three bits; `["apps.switch"]` → only it; `["question.tier"]` → only it; 17 strings that include both → 0; `["apps.switch", 3]` → 0.

- [ ] **Step 2: Run to verify it fails.** Run: CABLE. Expected: FAIL to build (`CABLE_FEATURE_APPS_SWITCH` undeclared).

- [ ] **Step 3: Commit red:** `test(pro): the welcome's apps.switch and question.tier are read (red)`.

- [ ] **Step 4: Implement** the two names in `cable_features_parse`; update the header's "two welcome features" comment to four.

- [ ] **Step 5: Run to verify it passes.** Run: CABLE, then ALL. Expected: pass line, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): the welcome's apps.switch and question.tier are read`.

---

### Task 3: `apps` frames become the model's app list

**Depends on:** Tasks 1, 2. **Effort:** high.

**Files:**
- Modify: `devices/harness-pro/firmware/main/pro_app_api.h` (two declarations)
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.c` (new `handle_apps`, the `"apps"` dispatch in `handle_message`, `session_up`)
- Modify: `devices/harness-pro/firmware/main/app/pro_app.c` (two entries)
- Test: `devices/harness-pro/firmware/test/test_pro_cable.c`, `devices/harness-pro/firmware/test/test_pro_app.py`

**Interfaces:**
- Consumes: `cable_app_t`, `CABLE_APPS_MAX`, `CABLE_APP_ID_MAX`, `pod_model_apps`, `pod_model_apps_switch` (Task 1); `CABLE_FEATURE_APPS_SWITCH` (Task 2).
- Produces (in `pro_app_api.h`, documented like its neighbours):
  - `void pro_app_apps(const cable_app_t *rows, int n, const char *shown);` (the whole list; `n` 0..16; `shown` never NULL, `""` none; ids unique, non-empty, < 16 B)
  - `void pro_app_apps_switch(bool on);` (on every welcome, before the link callback of a first one)

- [ ] **Step 1: Write the failing tests.**
  - `test_pro_cable.c`: a recording stub `pro_app_apps` (new `EV_APPS`; rows copied into `static cable_app_t rec_apps[CABLE_APPS_MAX]`, `n1 = n`, shown in `a`) and `pro_app_apps_switch` (`static int apps_switch_calls; static bool apps_switch_on;`, not in `evs[]`).
  - `apps_rows`: after `welcome(); reset();` feed `{"t":"apps","shown":"codex","apps":[{"id":"codex","name":"ChatGPT","count":3,"waiting":1,"working":2},{"id":"vscode","name":"VS Code","count":1,"waiting":0}]}` → one `EV_APPS`, `n1 == 2`, `{codex, ChatGPT, 3, 1, 2}`, `{vscode, VS Code, 1, 0, 0}`, shown `"codex"`. `{"t":"apps","apps":{}}` and `{"t":"apps"}` → no event. `{"t":"apps","apps":[]}` → `EV_APPS` with `n1 == 0`. Shown `"warp"` beside a codex row only → `"warp"`. Shown `"abcdefghijklmnop"` (16 B), absent, and `7` → `""`.
  - `apps_bounds`: 17 rows `a0`…`a16` → `n1 == 16`, last id `a15`. Ids `""`, `"abcdefghijklmnop"` (16 B) and `3` dropped; `"abcdefghijklmno"` (15 B) kept; a second `"x"` dropped and the first's name kept. Name of 22 `a` + `"é"` → 22 bytes, `utf8_ok`; no name → `""`. Counts, one row each: `count -1` → 0; `count 300, waiting 300, working 300` → 255, 255, 255; `count "3"` → 0; `count 2.7` → 2; `count 1e999` → 255; `count 2, waiting 5, working 9` → 2, 2, 2; `count 0, waiting 2` → waiting 0; absent → 0.
  - `apps_switch_on_every_welcome`: after `end_session()`, a welcome (machine `m1`) with `["apps.switch"]` → `apps_switch_calls == 1 && apps_switch_on`; a keepalive welcome of the same machine with `[]` → `apps_switch_calls == 2 && !apps_switch_on` and no new `EV_LINK`.
  - `parse_heavy` gains one 16-row `apps` frame (names of 23 B) per round.
  - `test_pro_app.py` case `apps_reach_the_model` (registered in `tests[]`): `setup()`; `pro_app_test_take_dirty()`; `pro_app_apps(rows, 2, "codex")` with the two rows above → `U.model.app_count == 2`, `apps[0].working == 2`, `app_shown == "codex"`, `pro_app_test_take_dirty()` true; the same call → `pro_app_test_take_dirty()` false; `pro_app_apps_switch(true)` → `U.model.apps_switch` and dirty; `pro_app_link(false, NULL)` → `app_count == 0`, `!apps_switch`; `LOCK_DEPTH == 0` throughout.

- [ ] **Step 2: Run to verify they fail.** Run: CABLE and APP `apps_reach_the_model`. Expected: FAIL to build (`pro_app_apps` undeclared).

- [ ] **Step 3: Commit red:** `test(pro): apps frames become the model's app list (red)`.

- [ ] **Step 4: Implement.**
  - `pro_cable.c` `handle_apps(const cJSON *p)` as spec §2 `apps`, into a file-static `cable_app_t[CABLE_APPS_MAX]`, counts as "Decided here", name via `copy_cut`; log `apps: %d`; then `pro_app_apps(rows, n, shown)`. Dispatch `"apps"` with the other session messages.
  - `session_up`: `pro_app_apps_switch((features & CABLE_FEATURE_APPS_SWITCH) != 0)` right after the features are stored, before `if (was && !moved) return;`.
  - `pro_app.c`: each entry locks, feeds the model, `settle((pod_out_t){0})`, `leave()`.

- [ ] **Step 5: Run to verify they pass.** Run: CABLE, APP `apps_reach_the_model`, then ALL. Expected: pass lines, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): apps frames become the model's app list`.

---

### Task 4: `agent` carries host and caps; `agents.end` carries view and tab

**Depends on:** Task 1. **Effort:** high.

**Files:**
- Modify: `devices/harness-pro/firmware/main/pro_app_api.h` (`pro_agent_row_t`, `pro_app_agents`)
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.c` (`agent_store_t`, `handle_agent`, `handle_agents_end` and its dispatch, a new `caps_of`)
- Modify: `devices/harness-pro/firmware/main/app/pro_app.c` (`pro_app_agents`)
- Test: `devices/harness-pro/firmware/test/test_pro_cable.c`, `devices/harness-pro/firmware/test/test_pro_app.py`
- Signature only: `devices/harness-pro/firmware/test/test_pro_voice_gate.py`; `devices/harness-pro/firmware/test/stress_pro_app.c` (one call, PM 2026-11-20: yes)

**Interfaces:**
- Consumes: `POD_CAP_*`, `POD_CAPS_ALL`, `pod_model_agent_app`, `pod_model_view` (Task 1).
- Produces:
  - `typedef struct { const char *id, *name, *engine, *machine_id, *machine, *host; uint8_t caps_off; } pro_agent_row_t;` (`host` NULL or `""`: not said; `caps_off`: the `POD_CAP_*` bits withheld, 0 = all allowed)
  - `void pro_app_agents(const pro_agent_row_t *rows, int n, bool machine_view, bool tab_open);`

- [ ] **Step 1: Write the failing tests.**
  - `test_pro_cable.c`: the `pro_app_agents` stub takes the new signature, records each row's host (`""` for NULL) and `caps_off` into arrays beside `rec_agent_ids`, `n2 = machine_view`, `n3 = tab_open`.
  - `agent_host_and_caps`: one roster of `{"id":"a1","engine":"claude"}` → host `""`, `caps_off 0`; `{"id":"a2","host":"codex","caps":"sf"}` → `"codex"`, `POD_CAP_V | POD_CAP_A`; `{"id":"a3","caps":""}` → 15; `{"id":"a4","caps":"xyz"}` → 15; `{"id":"a5","caps":"vz"}` → `15 & ~POD_CAP_V`; `{"id":"a6","caps":3}` → 0; `{"id":"a7","host":"abcdefghijklmnop"}` → `""`; `{"id":"a8","host":"abcdefghijklmno"}` → kept. `n1 == 8`, rows in order.
  - `agents_end_view_and_tab`: `agents.end` with neither → `n2 == 0, n3 == 0`; `{"view":"machine","tab":""}` → 1, 0; `{"view":"apps","tab":"t1"}` → 0, 1; `{"view":"Machine","tab":7}` → 0, 0.
  - `test_pro_app.py` case `agents_carry_app_and_view`: `setup()`; rows (designated) `a1` claude with no host or caps, `a2` codex `.host = "codex", .caps_off = POD_CAP_V | POD_CAP_A`, `a3` `.host = "claude", .caps_off = POD_CAPS_ALL & ~POD_CAP_S`; `pro_app_agents(rows, 3, true, false)` → `agent("a1")->caps == POD_CAPS_ALL` and host `""`, `a2` caps `S|F` host `"codex"`, `a3` caps `S`; `U.model.machine_view`; `U.model.has_window` (setup's swarms listed two tabs). `pro_app_agents(rows, 3, false, true)` → `!machine_view && has_window`. A library-only row (`pro_app_library`, id `"far"`) → `caps == POD_CAPS_ALL`. `LOCK_DEPTH == 0`.
  - Existing callers updated as "Decided here" in `test_pro_app.py`, `test_pro_voice_gate.py` and `stress_pro_app.c`.

- [ ] **Step 2: Run to verify they fail.** Run: CABLE and APP `agents_carry_app_and_view`. Expected: FAIL to build (`pro_agent_row_t` has no member `host`; too many arguments to `pro_app_agents`).

- [ ] **Step 3: Commit red:** `test(pro): agent carries host and caps; agents.end carries view and tab (red)`.

- [ ] **Step 4: Implement.**
  - `pro_cable.c`: `agent_store_t` gains `char host[16]; uint8_t caps_off;`. `handle_agent` keeps `host` only when `strlen < 16`; `static uint8_t caps_of(const char *letters)` as the round's (NULL: `POD_CAPS_ALL`; else exactly the letters s v f a); `caps_off = POD_CAPS_ALL & ~caps`. `handle_agents_end(const cJSON *p)` reads `view` (`"machine"` only) and `tab` (a non-empty string); rows carry `host` (never NULL) and `caps_off`; log per Global Constraints.
  - `pro_app.c` `pro_app_agents`: the order in "Decided here"; caps = `POD_CAPS_ALL & ~caps_off`.

- [ ] **Step 5: Run to verify they pass.** Run: CABLE, APP `agents_carry_app_and_view`, VOICE, then ALL. Expected: pass lines, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): agent carries host and caps; agents.end carries view and tab`.

---

### Task 5: A question told again with `tier: "list"` is a silent row

**Depends on:** Task 2. **Effort:** high.

**Files:**
- Modify: `devices/harness-pro/firmware/main/pro_app_api.h` (`pro_app_question`)
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.c` (`handle_question`)
- Modify: `devices/harness-pro/firmware/main/app/pro_app.c` (`pro_app_question`)
- Test: `devices/harness-pro/firmware/test/test_pro_cable.c`, `devices/harness-pro/firmware/test/test_pro_app.py`
- Signature only: `devices/harness-pro/firmware/test/test_pro_voice_gate.py`

**Interfaces:**
- Consumes: `CABLE_FEATURE_QUESTION_TIER` (Task 2).
- Produces: `void pro_app_question(const char *id, const char *request, const char *text, bool list);` (`list`: a question told again, filed with no beep, no wake and no toast).

- [ ] **Step 1: Write the failing tests.**
  - `test_pro_cable.c`: the stub takes `bool list` into `n1`. `question_tier_list`: welcome with `["question.tier"]`; `{"t":"question","agentId":"a","id":"q","tier":"list","questions":[{"q":"x"}]}` → `n1 == 1`; `tier` `"alert"`, absent, `7`, `"List"` → 0. Then `welcome()` (no `question.tier`) and `tier: "list"` → 0.
  - `test_pro_app.py` case `question_list_tier_is_quiet`: `notif_room()`; `pro_app_sleep()`; `pro_app_question("a3", "r1", "Which branch?", true)`; `render()` → `pro_app_question_open("a3")`, `agent("a3")->state == POD_ASKING`, `pod_model_unread_find(&U.model, "a3")->ask`, `BEEPS == 0`, `pro_app_asleep()`, `!U.ban_on`, `pro_app_voice_block_reason("a3")` is `"Answer its question first."`. Then `pro_app_question("a2", "r1", "Which file?", false)` → `BEEPS == 1 && !pro_app_asleep()`.
  - Every existing `pro_app_question` call in `test_pro_app.py` and `test_pro_voice_gate.py` gains `, false`.

- [ ] **Step 2: Run to verify they fail.** Run: CABLE and APP `question_list_tier_is_quiet`. Expected: FAIL to build (too many arguments to `pro_app_question`).

- [ ] **Step 3: Commit red:** `test(pro): a question told again with tier list is a silent row (red)`.

- [ ] **Step 4: Implement.** `handle_question`: `list = (s_features & CABLE_FEATURE_QUESTION_TIER) && tier is "list"`. `pro_app_question`: unchanged except the tier passed to `pod_ui_notify_text` (`POD_TIER_LIST` when `list`); the open-question set and the request hash are kept for both. Update the declaration's comment.

- [ ] **Step 5: Run to verify they pass.** Run: CABLE, APP `question_list_tier_is_quiet`, VOICE, then ALL. Expected: pass lines, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): a question told again with tier list is a silent row`.

---

### Task 6: An agent without voice never opens the microphone

**Depends on:** Tasks 1, 4. **Effort:** high.

**Files:**
- Modify: `devices/harness-pro/firmware/main/app/pro_app.c` (`pro_app_voice_block_reason`, `voice_begin_effect`, new `block_reason`)
- Modify: `devices/harness-pro/firmware/main/app/pro_app.h` (the `pro_app_voice_block_reason` comment names the new reason)
- Test: `devices/harness-pro/firmware/test/test_pro_app.py`

**Interfaces:**
- Consumes: `pod_agent_t.caps`, `.host`, `POD_CAP_V`, `pod_host_see_it` (Task 1); `pro_app_agents` with `host`/`caps_off` (Task 4).
- Produces: no new symbol. `pro_app_voice_block_reason` returns `pod_host_see_it(host)` for a roster agent without `POD_CAP_V`, after the update and link checks and before every other per-agent reason.

- [ ] **Step 1: Write the failing tests** (registered in `tests[]`), both starting from `setup()` and `pro_app_agents` with `a1` (claude, all caps), `a2` (`.host = "codex", .caps_off = POD_CAP_V | POD_CAP_A`), `a3` (`.engine = "terminal", .host = "", .caps_off = POD_CAP_V`), `false, true`:
  - `voice_needs_the_v_cap`: `a1` → NULL; `a2` → `pod_host_see_it("codex")` (same pointer) and `"See it in ChatGPT"`; `a3` → `"See it in Terminal"` (before "Choose an agent pane."); after `pro_app_question("a2", "r1", "Which?", false)` still `"See it in ChatGPT"`; NULL agent → NULL; a library-only agent `"far"` → NULL; after `pro_app_link(false, NULL)` `a2` → `"Not connected"`.
  - `see_it_notice_lasts_two_seconds`: open `a2` (`tap(POD_A_OPEN_TAB, 0)`, `tap(POD_A_OPEN_AGENT, 1)`), `tap(POD_A_TALK, 0)` → `R.begins == 0` (no `voice.begin`), `!V.open`, `!pod_ui_talking(&U)`, `U.notice == "See it in ChatGPT"`, `0 < (int32_t)(U.notice_until - now) <= 2000`; `now = U.notice_until - 1; render()` → `U.notice_on`; `now = U.notice_until; render()` → `!U.notice_on`. Then from a fresh `setup()` and the same rows: open `a1` (`OPEN_TAB 0`, `OPEN_AGENT 0`), `pro_app_question("a1", "r1", "Which?", false)`, `render()`, `tap_stale_talk()` → `"Answer its question first."` with `(int32_t)(U.notice_until - now) > 2000` (other reasons keep 3 s). `pro_app_question_close("a1")`, `render()`, `tap(POD_A_TALK, 0)` → `R.begins == 1` (all caps: records as before).

- [ ] **Step 2: Run to verify they fail.** Run: APP `voice_needs_the_v_cap` and APP `see_it_notice_lasts_two_seconds`. Expected: FAIL (`a2` returns NULL; the recorder starts).

- [ ] **Step 3: Commit red:** `test(pro): an agent without voice never opens the microphone (red)`.

- [ ] **Step 4: Implement** `block_reason` as "Decided here". In `voice_begin_effect`, after `pod_ui_notice`, set `s_pod.notice_until = now + 2000` when `see_it`, with the same `now` passed to the notice.

- [ ] **Step 5: Run to verify they pass.** Run: both APP cases, VOICE, then ALL. Expected: pass lines, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): an agent without voice never opens the microphone`.

---

### Task 7: The Pro can send `app.pick`

**Depends on:** Task 1. **Effort:** medium.

**Files:**
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.h`, `devices/harness-pro/firmware/main/cable/pro_cable.c`
- Test: `devices/harness-pro/firmware/test/test_pro_cable.c`

**Interfaces:**
- Consumes: `CABLE_APP_ID_MAX` (Task 1).
- Produces: `bool pro_cable_send_app_pick(const char *app);` in `pro_cable.h` under "sends Pod uses" (false, sending nothing, for NULL, `""` or an id of 16 B or more: only an id that could have arrived whole). Item C calls it; nothing in this item does.

- [ ] **Step 1: Write the failing test** `app_pick_shapes`: `welcome(); reset();` `pro_cable_send_app_pick("codex")` → true, `nsent == 1`, `sent[0] == {"t":"app.pick","app":"codex"}`; NULL, `""`, `"abcdefghijklmnop"` → false, `nsent` still 1; `"abcdefghijklmno"` → true, `nsent == 2`.

- [ ] **Step 2: Run to verify it fails.** Run: CABLE. Expected: FAIL to build (`pro_cable_send_app_pick` undeclared).

- [ ] **Step 3: Commit red:** `test(pro): the Pro can send app.pick (red)`.

- [ ] **Step 4: Implement** with `msg`, `msg_string`, `send_json`.

- [ ] **Step 5: Run to verify it passes.** Run: CABLE, then ALL. Expected: pass line, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): the Pro can send app.pick`.

---

### Task 8: The hello says the three capabilities; README contract

**Depends on:** Tasks 3, 4, 5, 6. **Effort:** medium.

**Files:**
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.c` (`send_hello` only)
- Modify: `devices/harness-pro/README.md` ("Daemon contract" only)
- Test: `devices/harness-pro/firmware/test/test_pro_hello.py`

**Interfaces:** none new. The hello's keys, in order: `fw, product, proto, hw, board, swarms, recap, activity, stats, player, ota, appFilter, questionTier, appCards, mac, settings`.

- [ ] **Step 1: Write the failing test:** `test_pro_hello.py`'s expected `pairs` gain `("appFilter", "v1")`, `("questionTier", "v1")`, `("appCards", "v1")` after `("ota", "v1")`; the docstring and the final print line name them.

- [ ] **Step 2: Run to verify it fails.** Run: HELLO. Expected: FAIL (AssertionError on `pairs`).

- [ ] **Step 3: Commit red:** `test(pro): the hello says appFilter, questionTier and appCards (red)`.

- [ ] **Step 4: Implement.** Three `msg_string` calls after `ota`. README "Daemon contract": "The nine capabilities", with these three lines after `ota`:
  - `` `appFilter: "v1"`: every app's agents (`host` and `caps` on `agent`, `view` and `tab` on `agents.end`), the `apps` list, and `app.pick`. ``
  - `` `questionTier: "v1"`: a question told again comes back with `tier: "list"`, a silent row. ``
  - `` `appCards: "v1"`: `working` on each `apps` row. ``
  
  and one line after the list: ``The welcome features the Pro reads: `player.library`, `resync`, `apps.switch`, `question.tier`.``

- [ ] **Step 5: Run to verify it passes.** Run: HELLO, then ALL. Expected: `Pro hello: …` line, exit 0.

- [ ] **Step 6: Commit:** `feat(pro): the hello says appFilter, questionTier and appCards`.

---

## Verification

**No device end-to-end check.** The hardware is off-limits for this item (never flash, monitor or open a serial port: the Pro's power latch bricks it on a wrong-revision image), and the daemon side is item A, built in parallel. Nothing on the Pro's screen changes in this item, so a person would see nothing new; the evidence is the host tests feeding raw frames and the golden match. An on-device check of A, B and C together is the PM's to arrange with Diego after the merges, outside this plan.

Local checks, on this Mac, from a clean tree at the final head (no board, no daemon, no account, nothing outside temp directories):

1. `PRO_FONT=devices/harness-pro/firmware/fonts/LiberationSans-Regular.ttf bash devices/harness-pro/firmware/test/run.sh` (CI's fonts), and once without `PRO_FONT`: exit 0.
2. `python3 devices/harness-pro/firmware/test/test_tree_isolation.py` and `python3 devices/harness-pro/firmware/test/test_fonts.py`: exit 0.
3. `cd devices/harness-pro/firmware && PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check` and `bash test/golden.sh --check`: both exit 0 (no baseline rewritten).
4. Compile only: `. ~/esp/esp-idf-5.5.4/export.sh && cd devices/harness-pro/firmware && idf.py -B build -DPROJECT_VER=0.0.99-pod build` ends with "Project build complete"; record the size of `build/harness_pro.bin` against `ota_0` in `partitions.csv` (the computation PR CI's "Fit the app in its OTA partition" step runs). Never `flash` or `monitor`.

PR CI runs, for any change under `devices/harness-pro/`: the Harness Pro host contracts (`run.sh`, `test_tree_isolation.py`, `test_fonts.py` with Liberation Sans, Linux), `pro-firmware-build` (the real ESP-IDF v5.5.4 build and the `ota_0` size check) and `pro-golden` (`golden.sh --check`, macOS arm64). No workflow is run by hand and no temporary workflow is needed: every check is short and already in PR CI. No `local-checks.py` gate maps to `devices/` paths. Platforms: firmware only; host tests on macOS and Linux.

## Answered (PM, 2026-11-20)

1. Task 4 may change the one `pro_app_agents` call in `test/stress_pro_app.c` to `pro_app_agents(&r, 1, false, true)`.
