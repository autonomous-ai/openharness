// What pro_cable tells the app. pro_cable parses the daemon's messages and calls these; pro_app (Task 6) implements
// them, and test_pro_cable.c stubs them with a recorder.
//
// EVERY CALL RUNS ON THE cable_link TASK (STACK_CABLE_LINK, 12 KB). A pointer argument is valid only until the call returns:
// copy what must outlive it. A NULL string means "the daemon did not send that field" (an older daemon sends
// less); "" means it sent an empty one. None of these is ever called with a string longer than its stated cap, and
// every cut is on a UTF-8 boundary.
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "cable/cable_machines.h"   // cable_machine_t
#include "cable/cable_types.h"      // cable_swarm_t, cable_swarm_members_t, cable_tile_t

// ---- caps (bytes, NUL included) ----
#define PRO_VERB_BYTES     128   // turn.started / turn.activity `text`
#define PRO_ACTION_BYTES   192   // turn.activity `action` (the daemon sends at most 188 B)
#define PRO_STEP_BYTES     121   // turn.activity `step`: at most 120 B
#define PRO_RECAP_BYTES    2048  // summary text / recap / full: the Pod recap buffer
#define PRO_QUESTION_BYTES 240   // question prompt

// ---- link ----
// The session came up (`welcome`) or went down (cable gone, 15 s of silence). `machine` is the cabled computer's name
// (never NULL when up; NULL when down). Called on the transition, and again if a welcome names another computer.
// A drop clears everything the daemon told us: pro_app must forget busy agents, abort a sweep and a recording.
void pro_app_link(bool up, const char *machine);

// ---- roster ----
typedef struct { const char *id, *name, *engine, *machine_id, *machine; } pro_agent_row_t;
// The complete agent list of the window's tab, once per `agents.end`. Ids are unique and shorter than ID_MAX; at most
// POD_AGENTS_MAX (32) rows; `name` falls back to the id. A list that ends without a begin is dropped.
void pro_app_agents(const pro_agent_row_t *rows, int n);

// The tab list. `members` is NULL when no tab carried `agentIds` (an older daemon); otherwise members->count[i] and
// ->id[i][k] belong to items[i], and ->meta[i][k].has says whether `members` described that id. At most SWARMS_MAX
// items (extra ones are dropped). `tiles` are the selected tab's grid rectangles from the SAME frame (tile_n may be 0).
// `selected` is NULL when absent. Called for every swarms frame, changed or not.
void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members,
                    const char *selected, const cable_tile_t *tiles, int tile_n);

// ---- Swarm cards (hello swarmCard:v1) ----
// `supertabs`: the current set and order of Swarm ids (at most SWARMS_CARD_MAX, each shorter than ID_MAX, no repeats). A Swarm not
// listed is dropped; a listed one not yet received stays absent until its `supertab` frame arrives.
void pro_app_supertab_ids(const char (*ids)[ID_MAX], int n);
// `supertab`: one Swarm's data (<= SWARM_LEADS_MAX Leads, names cut on a UTF-8 boundary, a bad Lead skipped), replacing that Swarm's. Ignored
// when its id is not in the last id list. `since_at_ms` and every Lead's `text` are 0/NULL here: the model stamps the clock and keeps the cached texts.
void pro_app_supertab(const pod_swarm_t *s);
// `supertab.recap`: the Lead's last message (<= SWARM_TEXT_MAX - 1 bytes; "" when `none`), `at` its epoch seconds.
void pro_app_supertab_recap(const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none);
// `supertab.focus`: the desktop opened this Swarm project. Both ids are non-empty.
void pro_app_supertab_focus(const char *tab, const char *lead);
// `supertab.notice`: a new message in one of that Lead's chats (`chat` "lead" | "pm" | "group" | "buddy"; `text` is cut to POD_UNREAD_TEXT). The alert tier of an agent's
// notice: an entry, the toast, a wake and a beep. A Buddy's chat is ignored. `supertab.notice.read`: that chat was read on the desktop; its entry and toast go.
void pro_app_supertab_notice(const char *tab, const char *lead, const char *chat, const char *chat_id, const char *text);
void pro_app_supertab_notice_read(const char *tab, const char *lead, const char *chat_id);

// ---- library ----
// Same layout as pod_library_row_t (pod_glue.h). `machine` is the machine NAME ("" when the machine list does not
// hold the id), `status` one of idle working question finished failed paused offline.
typedef struct { const char *id, *name, *engine, *machine, *status; int32_t age_s; } pro_library_row_t;
// One page of the player library, only for the latest request pro_cable_request_library made (an older reply is
// dropped). A page the parser rejects is not delivered. count is 0..6.
void pro_app_library(const pro_library_row_t *rows, int count, int offset, int total);

// player.context. Parsed and delivered; pro_app ignores it for now (owner decision 4). Strings are "" when absent.
void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine);

// ---- turns ----
// kind is one of:
//   "started"  text = the daemon's status line ("" if none), elapsed_s 0
//   "verb"     text = the spinner word (non-empty), elapsed_s -1 (keep the model's)
//   "activity" text = the progress sentence ("" when the frame had only elapsedSeconds), elapsed_s 0..2592000 or -1
//   "step"     text = one tool card (non-empty, <= 120 B), elapsed_s -1
//   "done" / "error"  text "", elapsed_s 0
// `turn.activity` is delivered as verb, then activity, then step, each only when its field is present.
// kind "error": `text` is the failure message (may be ""); the failed turn is filed as an alert.
void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s);
// turn.stats, once before turn.done: each count is 0..1000000, or -1 when the message left it out.
void pro_app_turn_stats(const char *id, int tests_passed, int tests_failed, int commits, int tokens_in, int tokens_out);

// `text` and `recap` are NULL when absent, `full` is NULL from a daemon without recap=long-v1.
// `tier`: how loud a live turn's end is (see pod_tier_t; a `restore` is never news, whatever it says): alert files an unread
// entry, shows the banner and beeps (one beep per POD_BEEP_COALESCE_MS), list only files the entry, silent files nothing.
// The recap itself is applied either way.
void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore, pod_tier_t tier);

// ---- notifications ----
// notif.replace: the whole unread list (the daemon sends it on greeting; at most 8 items, one per agent). Strings are never
// NULL ("" when absent); token is "" without one (and only ever a valid readToken, [A-Za-z0-9_-]{1,63}). No banner, no beep.
typedef struct { const char *agent_id, *name, *summary, *token; } pro_notif_row_t;
void pro_app_notif_replace(const pro_notif_row_t *rows, int n);
// notif.seen: read elsewhere. token is NULL without one.
void pro_app_notif_seen(const char *id, const char *token);

// request is the question's request id: with the prompt it tells a re-sent question from a new one. super_tab is the Super Tab
// the asking agent works in (NULL for a plain question; never "", at most SUPER_TAB_MAX - 1 bytes) and attention what it needs
// (POD_ATTN_DECISION or POD_ATTN_STUCK with a super_tab, POD_ATTN_NONE without).
void pro_app_question(const char *id, const char *request, const char *text, const char *super_tab, pod_attention_t attention);
void pro_app_question_close(const char *id);

// The daemon's surface moved to this agent.
void pro_app_focus(const char *id);

// ---- voice ----
enum { PRO_VOICE_OK = 0, PRO_VOICE_ERROR = 1 };
// The reply to the recording pro_cable_voice_begin started (a reply for another upload id is dropped).
// PRO_VOICE_OK: `text` is the agent id it was routed to ("" if none). pro_cable already sent voice.confirm when the
// daemon asked for one. PRO_VOICE_ERROR: `text` is the daemon's message ("" if none). Either ends the voice state.
void pro_app_voice_result(int kind, const char *text);

// ---- machines ----
// The machine list as applied (after `machines.end` or a `machine.updated` that changed a row), only when it
// differs from the last one; count 0 with selected "" when the session ends. `selected` is never NULL.
void pro_app_machines(const cable_machine_t *rows, int count, const char *selected);

// ---- settings ----
// Put a brightness (0..255, what config_store keeps) on the panel. The caller stores it.
void pro_app_set_brightness(uint8_t level);

// ---- firmware update (pro_cable -> pro_app) ----
// The offer's "busy" decision and the updating flag in one step, atomic with respect to a voice start: false when a voice
// start or recording is open (decline the offer), else true with voice held off from now on. Pair a refusal that left
// nothing in flight with pro_app_end_update_gate (no screen, no notice).
bool pro_app_begin_update_gate(void);
void pro_app_end_update_gate(void);
// After fw_confirm_*: if this boot is the first of an update, say "Updated to X.Y.Z" once the cable is up.
void pro_app_note_update(void);
