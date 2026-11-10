// LVGL screens for the commander device (round 466x466). Thread-safe: each function
// takes the LVGL lock internally (display_lock/unlock), so the HTTP / WS tasks may call
// them directly.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>   // size_t (ui_project_id_at)
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"   // TaskHandle_t — ui_set_reload_waiter
#include "config_store.h"
#include "../cable_machines.h"   // cable_machine_t — the wheel's row, already parsed and diffed
#include "../cable_client.h"     // cable_swarm_t — one of the window's tabs, as the wire carries it
#include "habitat/supertab.h"   // ht_supertab_t — one Swarm and its Leads, as cable_client parsed it

struct cJSON;

void ui_init(void);

// Set screen brightness (0x00 dimmest .. 0xFF max) — software dim overlay + best-effort panel DCS.
// Call after ui_init(). The Settings brightness slider and the boot restore both use this.
void ui_set_brightness(uint8_t level);

// Settings → Wifi: open the picker (switch between saved networks; "New wifi" opens the setup portal).
// app_main drains a pending wifi switch (user tapped a saved network in the picker). Returns true once
// and copies the chosen network into *out; app_main then remembers it (front of the list) and reboots.
void ui_show_error(const char *title, const char *detail);
// Brief pre-reboot splash (spinner + "New update" / "Restarting…") shown just before rebooting into the
// dedicated OTA updater. No progress — nothing is downloading yet.
void ui_show_ota_restarting(void);
// Minimal OTA boot-mode progress screen (self-contained, no ui_init needed) — used by ota_boot_check.
void ui_ota_boot_show(const char *version);
void ui_ota_boot_pct(int pct);

// --- Projects tileview (swipe left/right between an agent's projects) ---
// Switch to the tileview state (shows whatever project tiles exist).
void ui_show_projects(void);

// Boot landing: park on the Overview tile (no "No agents" flash) and arm a landing so that once the saved
// machine's agents load, ui_land_after_reload slides to agent 0 — or stays on the Overview tile if it's empty.
void ui_enter_boot_loading(void);
void ui_land_after_reload(void);
// Global commander connection indicator (shown on every tile's header).
void ui_set_connected(bool connected);
// The custom pets changed (pet.map, a finished pack, pet.drop): redraw so the dial applies them at the next scene.
void ui_pets_changed(void);
// Node (paired machine) online↔offline from the `node_status` frame — distinct from ui_set_connected
// Ensure a tile exists for project_id (creates one if new). Safe to call repeatedly.
// Set/refresh the human name shown on a project's tile.
void ui_project_set_name(const char *project_id, const char *name);
// Set the engine shown below an agent name. Invalid/empty values leave the label blank.
void ui_project_set_engine(const char *project_id, const char *engine);

// Which machine an agent lives on. A tab spans machines, so this is what the tile's machine line and
// line shows and what a machine row uses to find the first agent to land on.
void ui_project_set_machine(const char *project_id, const char *machine_id, const char *machine);

// Runtime model/effort (remote machines): store the opaque runtime-v1 profile and repaint the Model/Effort
// chips. set_ is authoritative (agent_synced, clears the optimistic hold); reconcile_ is the guarded poll
// path (keeps a just-made local change on-screen until the adapter catches up).
void ui_project_set_selected_model(const char *project_id, const char *runtime_id);
void ui_project_reconcile_selected_model(const char *project_id, const char *runtime_id);
// Drained once per tick by app_main's refresh_task: if a Model/Effort chip was tapped, run the blocking
// models_list RPC (off the LVGL task) and build the picker screen.
void ui_service_model_picker(void);

// Remove a project's tile (session ended / tmux pane gone). No-op if the id isn't shown.
void ui_project_remove(const char *project_id);

// Bracket a WHOLE-LIST rebuild (a cable reconnect drops every tile and adds them all back).
//
// Between these two calls the add/remove paths touch the model only: no re-anchor, no window rebuild, no
// trailing-tile rebuild. The view catches up once, at bulk_end, and comes back to whichever page was
// centred when bulk_begin ran. Nested calls are counted, so only the outermost pair paints.
//
// This is not an optimisation to be dropped when convenient. Painting per agent held the display lock for
// about ten seconds on a 78-agent reconcile, which is the task watchdog's timeout with panic enabled, and
// the dial rebooted in the middle of the refresh. See the block comment above the implementation.
void ui_projects_bulk_begin(void);
void ui_projects_bulk_end(void);
// Copy the id of the project tile at index i into buf; false if out of range (poll reconcile).
bool ui_project_id_at(int i, char *buf, size_t n);
// Number of project tiles currently shown (for naming "Project N").
int ui_project_count(void);
// True when a tile for this agent already exists. An UNKNOWN id must not be turned into a tile from an
// event frame — see the cable_client handlers, which ask for the authoritative list instead.
bool ui_project_known(const char *project_id);
// Clear any "Working…" tile orphaned when its turn-done was lost or never produced. Acts on heartbeat
// absence: a live turn re-emits 'processing' every ~5s (adapter + node), so a tile silent for >25s is gone.
// A genuinely-live turn keeps stamping and is never cut short. Call from the ~1s refresh loop. Returns #cleared.
int ui_prune_stale_busy(void);
// True while a vertical drag should be reported to the computer as a scroll — an agent tile (where the
// dial itself has nothing to scroll) or the detail reader (where both surfaces move). See the definition
// for why every other screen says no.
bool ui_scroll_reportable(void);

// Notification centre: opens over any carousel page (a tile, the Overview, Settings).
void ui_notif_open(void);

// --- The machine wheel (the carousel's last ring) ---
//
// The dial holds a LIST of the owner's machines and exactly one is selected; its agents are what the
// carousel shows. The agent id space stays flat and unscoped, so switching machine is simply "the agent
// list changed" as far as every other part of this file is concerned.
//
// The rows arrive already parsed and already DIFFED — cable_machines.c answers "did anything change?"
// on the reader task, before any of this is called. Nothing here re-checks that, and nothing here should
// be called for an unchanged list: an unguarded rebuild on every arriving greeting measured out at 31
// session restarts an hour, with the agent list wiped each time.

// Replace the whole wheel from one streamed list. `selected` is the machine whose agents are on screen;
// `previous` is what it was, so a switch can be told from a refresh without a second call.
void ui_machines_replace(const cable_machine_t *rows, int count, const char *selected, const char *previous);

// Patch one row (a `machine.updated` delta). Already known to be a real change.
void ui_machines_replace_one(const cable_machine_t *row, const char *selected);

// Why the list is as short as it is: "backend" | "local" | "signed-out". Drives the empty-state copy, so
// one row reads as "this daemon is signed out" rather than as "you own one machine".
void ui_machines_source(const char *source);

// The session ended: drop every row. A row is a claim that a computer is reachable RIGHT NOW.
void ui_machines_clear(void);

// Record the selection `welcome` states, without clearing anything — the list is already on its way.
void ui_set_selected_machine(const char *machine_id);

// The daemon acknowledged a select. THE ONLY WRITER of the selection — a tap marks a row pending and
// waits for this, because an optimistic write leaves a lie on screen when the select is refused.
void ui_machine_selected_ack(const char *machine_id);

// The daemon refused a select. `message` is shown verbatim; `code` only picks the SHAPE of the answer —
// `NEEDS_LINK` opens the link guide (an instruction, not an error), everything else is a toast.
void ui_machine_select_error(const char *machine_id, const char *code, const char *message);

// --- Swarms (the window's tabs; see the block in ui_habitat.c) ---
// Replace the whole list from one `swarms` frame. `selected` names the one the window has on screen; it
// is what every tile's swarm line draws. count 0 hides the line. Safe from the reader task.
void ui_swarms_replace(const cable_swarm_t *rows, int count, const char *selected);

// --- The Swarms (Super Tabs; cable_client.h). Each is safe from the reader task. ---
// The `supertabs` list: the Swarms shown, in order. A Swarm gone from it leaves the list and the inbox.
void ui_supertabs_ids(const char ids[][ID_MAX], int n);
// One Swarm's card. True when the caller should beep: a Lead started needing a person, off the face.
bool ui_supertab(const ht_supertab_t *in);
// `chat_id`: the chat the text is the last message of, "" from a daemon without swarmChat. Dropped for another chat.
void ui_supertab_recap(const char *tab, const char *lead, const char *chat_id, const char *thread, const char *text, uint32_t at, bool none);
void ui_supertab_focus(const char *tab, const char *lead);
// A tag in the Lead's project, or an older daemon's Lead message (`supertab.notice`): that Lead's one inbox entry, read at
// once when its chat is on the face. `thread`: the root of the thread it replies in, "" for the main stream; such a notice
// is read at once only when the face shows that thread. True when the caller should beep.
bool ui_supertab_notice(const char *tab, const char *lead, ht_chat_kind_t chat, const char *chat_id, const char *thread, const char *text, uint32_t at);
// The desktop opened that chat (`supertab.notice.read`): the entry goes.
void ui_supertab_notice_read(const char *tab, const char *lead, const char *chat_id);
// A Super Tab wait from harness `agent_id` (some Lead's `local`). It only sets that Lead's inbox text and face;
// it never opens the question screen. True when the caller should beep.
bool ui_supertab_wait(const char *agent_id, const char *request, const char *swarm_name, bool stuck, const char *text);
void ui_supertab_wait_close(const char *agent_id, const char *request);
// Link lost: forget every Swarm and its inbox entries.
void ui_supertabs_clear(void);

// Drain the select deadline. Called from refresh_task, off the LVGL task; drops the spinner and shows the
// reason when the daemon never answered.
void ui_tick_machine_select(void);

void ui_request_agent_reload(void);
// The task that applies a pushed list (app_main's refresh_task). Given its own handle so a push can WAKE
// it rather than wait for its next tick — see ui_apply_pending_focus for what that second cost.
void ui_set_reload_waiter(TaskHandle_t task);
// Land a focus that arrived before the list it needed. The daemon pushes the ring and then the focus, but
// the ring is applied by refresh_task a tick later, so a focus naming an agent that was not yet on the
// carousel is HELD (ui_focus_project) rather than dropped — this is what lands it, and refresh_task calls
// it once the rebuilt list is on screen. No-op when nothing is held.
void ui_apply_pending_focus(void);
bool ui_take_agent_reload_req(void);
bool ui_peek_agent_reload_req(void);   // non-consuming check (a slow per-agent restore bails on a new machine select)
// Put the tiles in the order `ids` gives. Without this the carousel keeps the order it FIRST saw agents
// in — ui_project_set_name appends — and once that disagrees with the list there is no path back.
// What the list just pushed was cut from: how many agents the account has in all (the overview's number —
// the dial holds one tab, never the fleet) and whether a window is open at the far end (an empty list
// with one is an empty tab; without one it is a shut app — see no_agents_apply).
void ui_fleet_set(int total, bool has_window);

void ui_project_apply_order(const char *const *ids, int n);
// Drop every agent tile from the current machine model (used when no machine remains selected).
void ui_project_clear_all(void);
// Switch the tileview to a project's tile (called after creating one so it shows immediately).
void ui_focus_project(const char *project_id);

// Voice router result (from the `voice_routed` frame after an Overview voice turn). `auto_sent` = the backend
// already dispatched (just focus the tile); otherwise the transcript is held and the device confirms via
// commander_route_confirm. `need_new` = no agent fit. Runs on the commander-WS task (takes the display lock).
void ui_voice_routed(bool auto_sent, bool need_new, const char *route_id, const char *agent_id,
                     const char *agent_name, double confidence);
// Backend abandoned an Overview route voice (empty transcript / STT or router error) → drop the loading
// overlay now instead of waiting out the routing watchdog. No-op unless a route voice is waiting.
void ui_voice_route_abort(void);
// One short line from the cabled Mac (a routing refusal, a send that did not land). Releases the routing
// overlay first, then shows the message for ~2s over whatever is on screen.
void ui_cable_toast(const char *msg);

/*
 * THE DEVICE'S SETTINGS, AS THE APP SEES THEM.
 *
 * A 466 circle holds four list rows between its chords, so the preferences live in the desktop app and
 * the glass keeps only actions. The device still OWNS them: NVS is the record, the app proposes, and
 * every answer is read back from here rather than echoed — the same rule `voicelang` has followed since
 * it started crossing the cable (config_store.h).
 *
 * `round` is not a preference. It is the face, sent so the app can HIDE a row a square has no meaning
 * for rather than grey out a control for a setting that does not exist there. This firmware only ever
 * builds round, but the field stays: another device on this protocol may not be.
 *
 * Not here, deliberately: `swipe_reversed`. It is stored, and the LVGL build honours it, but habitat's
 * tab carousel follows the finger by position and never reads it. A row in the app for a setting the
 * glass ignores is worse than no row.
 */
// The id the app knows Focus by (its deviceFaces). The firmware's own id is 0; this is what the wire says.
enum { UI_CHARACTER_FOCUS_WIRE = 2 };
typedef struct {
    uint8_t brightness;   // 0..100, the number a person reads, not the 0..255 stored
    uint8_t character;    // always UI_CHARACTER_FOCUS_WIRE: Focus is the only face
    uint16_t face;        // the glass, in pixels across — named so a support line can read it
    bool muted, quiet, straight_title, focus_face, scroll_reversed, round;
    char voicelang[CFG_VLANG_MAX];
} ui_settings_t;

// Which fields of a ui_settings_t an apply is allowed to touch. Absent means unchanged — a frame that
// names one row must not quietly restate the other ten.
enum {
    UI_SETTING_BRIGHTNESS = 1u << 0, UI_SETTING_MUTED          = 1u << 1,
    UI_SETTING_CHARACTER  = 1u << 2,
    UI_SETTING_QUIET      = 1u << 4, UI_SETTING_STRAIGHT_TITLE = 1u << 5,
    UI_SETTING_FOCUS_FACE = 1u << 6, UI_SETTING_SCROLL         = 1u << 7,
    UI_SETTING_VOICELANG  = 1u << 8,
};

// The settings as they stand. Takes the display lock.
void ui_settings_read(ui_settings_t *out);
/*
 * Apply the named fields. False means nothing was written and `error` holds one line to show verbatim;
 * the caller answers with the settings read back either way, so a refusal still corrects the app.
 */
bool ui_settings_apply(const ui_settings_t *want, uint32_t fields, char *error, size_t cap);
// A local change the app has not heard about yet (a factory reset, a pattern just drawn). Wakes the
// cable's reporter; safe from any task.
void ui_settings_changed(void);
void ui_selection_state(const struct cJSON *payload);
void ui_draft_state(const struct cJSON *p);
void ui_voice_draft(const struct cJSON *p);
void ui_voice_question(const struct cJSON *p);
void ui_voice_form(const struct cJSON *p);
void ui_form_state(const struct cJSON *payload);
void ui_carry_state(const struct cJSON *payload);
void ui_visit_state(const struct cJSON *payload);
void ui_voice_error(const char *msg);
// A turn finished for this agent → record it in the drawer, badge, and wake the screen if it was off.
// `name`, `machine` and `recap` come from the frame: the dial holds one tab, and the agent may be on
// another — the row has nobody else to ask. Any may be NULL; a held tile's own model wins when present.
// A live `summary`. TIER is the wire's "alert" | "list" | "silent"; NULL or unknown falls back to the old
// flags (silent, then quiet, else alert). Returns true when the caller should beep: an alert, and not
// for the pane already on the face. A list entry is a drawer row only; silent files nothing.
bool ui_notify_summary(const char *project_id, const char *name, const char *machine, const char *recap,
                       const char *tier, bool quiet, bool silent);
// A failed turn: an alert. Files a drawer row, shows the error for 8 s. True when the caller should beep.
bool ui_turn_error(const char *project_id, const char *message);
// The WINDOW looked at this agent → drop its FINISHED-turn row here, as a tap on that row does.
//
// The two screens take a notification away on different gestures — a tap here, a tab coming to the
// front over there — and each has to reach the other or the pill and the badge stop agreeing the
// first time either is used. The tap's half already travels (cable_client_send_open); this is the
// return leg. No-op when no row names this agent. Safe from the reader task.
void ui_notif_seen(const char *project_id);
void ui_notif_read(const char *project_id, const char *read_token);
// Replace the WHOLE drawer with what the window still has unread, newest first.
//
// Sent once per attach, because that is the one moment this dial is known to have nothing: the rows
// live in RAM and an OTA, a replug or a flash takes them while the window keeps every mark. Without
// it the two screens read different numbers from that moment on, with nothing to bring them back.
// Safe from the reader task.
void ui_notif_replace(const cable_notif_t *rows, int count);
// Append a commander event to a project's tile as a readable text card (keeps the last 2).
// kind: "say" | "act" | "ask" | "done" | "error". session_id is the dbSessionId for voice resume.
// `recap` (optional, may be NULL): a short headline shown on the tile at a glance; `text` is the
// fuller body shown in the tap-to-read reader. When `recap` is NULL the tile previews `text`.
void ui_project_emit(const char *project_id, const char *session_id, const char *kind, const char *text, const char *recap);
// Restore a persisted historical card without changing the live busy lifecycle for this project.
void ui_project_restore_event(const char *project_id, const char *kind, const char *text, const char *recap);
void ui_project_clear_event(const char *project_id);

// --- AskUserQuestion (agent asks; user answers from the device) ---
// Show the question screen: tap an option row to answer (single/multi-select). Tap-only — there is no
// voice answer. `questions` is the cJSON array from the `commander_question` frame; copied out
// synchronously, so the caller may free the JSON right after this returns.
// Also records it behind the bell: a blocked agent is counted, and stays counted until the question is
// ANSWERED rather than until somebody looks at it. Not gated on the window having the agent on screen —
// showing a question asks the window to bring it forward, so that gate could never open.
// True when the caller should beep: not for the pane already on the face.
bool ui_question_show(const char *project_id, const char *agent_name, const char *machine, const char *request_id, const struct cJSON *questions);
// That question was answered somewhere else (the app, or the pane by hand) — leave the screen instead of
// waiting for an answer that can no longer be delivered. No-op unless THIS request is the one on screen.
void ui_question_close(const char *project_id, const char *request_id);


// Physical BOOT button pressed. Routes to "back" (cancel voice / dismiss the question) while a
// question is on screen, otherwise offers to stop the Lead at work on this computer. Safe from any task.
void ui_boot_pressed(void);

void ui_question_state(const struct cJSON *payload);
void ui_answer_receipt(const struct cJSON *payload);

void ui_voice_search(const struct cJSON *p);

void ui_workspace_applied(const char *tab, uint32_t generation);
