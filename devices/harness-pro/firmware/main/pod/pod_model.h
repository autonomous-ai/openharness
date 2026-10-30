// Pod's state: tabs, agents, per-agent state and recap. Pure C11: no drawing, no I/O, no ESP-IDF, and no
// clock (every time is passed in as now_ms). Fed by pro_app from the cable messages pro_cable parses.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cable/cable_types.h"   // ID_MAX, CABLE_NAME_MAX, SWARM_ID_MAX, cable_swarm_t, cable_tile_t

#define POD_AGENTS_MAX 32
#define POD_TABS_MAX   24
#define POD_PANES_MAX  24
#define POD_RECENT_MAX 8     // agents the Recent list holds
#define POD_LIB_AGE_MAX_S 1728000   // 20 days: older library ages all read as this
#define POD_RECAP_BYTES 2048
#define POD_RECAP_LINES 64   // the Recap screen joins them, so this is only a cap on sentences kept (2 KB holds ~50)

// Where the roster knows an agent from. An agent stays while any source still lists it.
enum { POD_SRC_TAB = 1, POD_SRC_LIBRARY = 2, POD_SRC_TAB_META = 4 };   // TAB_META: a tab lists it and the daemon described it (swarms `members`)

// POD_OFFLINE: the agent's machine is offline (known only from a tab's member metadata); it has no turn, no recap, no voice.
typedef enum { POD_IDLE, POD_WORKING, POD_ASKING, POD_DONE, POD_OFFLINE } pod_state_t;

// Room for a Vietnamese sentence or two (UTF-8, ~2 bytes a letter). POD_AGENTS_MAX of these live in PSRAM.
#define POD_ACTIVITY_BYTES 512
// The steps of the turn so far: the activity sentences (turn.activity's `action`) the agent has moved on from, newest
// first. The cable carries no tool, token or file counters, so these are the only "how far" the device can know.
// The footer's spinner word (turn.activity `text`, "Infusing..." with its dots dropped): its own field, so it and the
// progress sentence (`action`, in activity[]) never overwrite each other.
#define POD_VERB_BYTES 64
#define POD_STEPS_MAX  6
#define POD_STEP_BYTES 160

typedef struct {
    char id[ID_MAX], name[CABLE_NAME_MAX], engine[12], machine[CABLE_NAME_MAX];
    pod_state_t state;
    uint32_t since_ms, elapsed_s, event_ms;
    bool has_event;                      // event_ms is set (an agent with none takes any feed, wrap or not)
    char activity[POD_ACTIVITY_BYTES], question[320], recap[POD_RECAP_BYTES];
    // The open question's Super Tab (the shared project it was asked in; "" = a plain question) and what it needs
    // (pod_attention_t: decision or stuck; NONE without a Super Tab). Set and cleared with question[].
    char super_tab[SUPER_TAB_MAX];
    uint8_t attention;
    // What a Super Tab question holds back (a pod_state_t): the state the agent's turns and sweeps would have given it,
    // taken once the question closes. Before the first such feed, the state it had when asked.
    uint8_t wait_after;
    char verb[POD_VERB_BYTES];
    char steps[POD_STEPS_MAX][POD_STEP_BYTES];   // this turn's tools and previous activity sentences, newest first (cut on a codepoint)
    uint16_t step_at_s[POD_STEPS_MAX];   // seconds into the turn each step arrived (steps[] order); 0xFFFF = unknown (no turn start seen)
    uint8_t step_count;
    int16_t step_total;                  // steps pushed this turn (not cut by the list's cap or by done), -1 when no turn.started was seen
    bool turn_started;                   // a turn.started began the current turn (step times are measured from since_ms)
    bool failed;                         // the last turn ended in turn.error; the next turn.started clears it (state stays IDLE)
    int32_t tests_passed, tests_failed, commits;   // turn.stats of the last turn, -1 unknown; cleared by turn.started
    int32_t tokens_in, tokens_out;                 // same, from turn.stats tokensIn / tokensOut
    bool activity_cut;                   // the cable text was longer than activity[]: the view ends it with an ellipsis
    bool recap_cut;                      // the text ends mid-thought (the source was cut, or too long to keep): the view ends it with "..."
    uint8_t recap_lines;                 // recap[] holds that many NUL-terminated lines, back to back
    uint16_t line_at[POD_RECAP_LINES];   // byte offset of each line in recap[]
    bool seen;                           // re-sent since the last pod_model_agents_begin
    bool recap_live;                     // the recap came from a live summary (not a restore)
    uint8_t src;                         // POD_SRC_*: agents.* (the window's tab) and/or player.library
    bool lib_seen;                       // re-sent since the last pod_model_library_begin
    int32_t age_s;                       // library: seconds since its last activity, -1 unknown (ranks the cap)
    // When the agent last had a task, two clocks for pod_model_recent (each valid with its flag): the last turn event,
    // question, or change into or out of working/asking, and the library's ageSeconds as an absolute time at receipt.
    // Opening or following it on the Pod is not a task and sets neither. (event_ms is no use for this: every library
    // sweep restamps it.)
    uint32_t act_ms, lib_ms;
    bool has_act, has_lib;
    // A message was just sent to it from the Pod (pod_model_sent): Working before the daemon says so, until a turn
    // event arrives, or Idle again after POD_SENT_WAIT_MS with none.
    bool sent;
    uint32_t sent_ms;
    // This turn plays the pet's second working scene (POD_SCENE_WORK_ALT, Claude's builder) instead of its first (the
    // chef): drawn once as the turn starts (pod_model_random), kept until it ends, so every screen shows the same one.
    bool work_alt;
} pod_agent_t;

typedef struct { int16_t x1, y1, x2, y2; } pod_rect_t;   // 0..1000

typedef struct {
    char id[SWARM_ID_MAX], name[CABLE_NAME_MAX];
    uint8_t panes, count;                // count: members listed (or the daemon's agent count when unknown)
    int8_t agent[POD_PANES_MAX];         // indices into agents[]; -1 = not in the roster (or not a driveable tile)
    pod_rect_t rect[POD_PANES_MAX];      // selected tab only: rect[k] is tile k
    bool has_rects, members_known;
    uint32_t member_hash[POD_PANES_MAX]; // FNV-1a of each member id (0 = unused): who is in some tab, for the cap
} pod_tab_t;

// The unread notifications: one per agent, newest first. `text` is the recap (the Inbox shows its first line, the banner two).
// token is the daemon's readToken (notif.replace only: a live summary carries none); "" = none.
#define POD_UNREAD_MAX  16
#define POD_UNREAD_TEXT 240
#define POD_TOKEN_MAX   64
#define POD_UNREAD_TTL_MS    (6u * 3600u * 1000u)   // an entry lives 6 h from receipt (the device's monotonic ms, uint32-wrap safe)
#define POD_BEEP_COALESCE_MS 30000                  // at most one beep per this long
typedef enum { POD_UNREAD_FINISHED, POD_UNREAD_FAILED } pod_unread_kind_t;
typedef struct {
    char agent[ID_MAX], name[CABLE_NAME_MAX], token[POD_TOKEN_MAX], text[POD_UNREAD_TEXT];
    char tab[ID_MAX], chat_id[ID_MAX];   // a Swarm chat's notice (tab set): agent = the Lead's id, name = its project, tab = the Swarm's id, chat_id = the chat it is about
    bool ask;                            // filed by a question (not a finished turn): it goes when the question closes
    pod_unread_kind_t kind;              // FAILED when the agent's last turn ended in an error
    uint32_t at_ms;
    int32_t elapsed_s;                   // the turn's length, -1 unknown
} pod_unread_t;
// An entry read here whose token the host must hear about (notif.read); pro_app drains these.
typedef struct { char agent[ID_MAX], token[POD_TOKEN_MAX]; } pod_read_out_t;
#define POD_READS_MAX 4

typedef struct {
    pod_agent_t agents[POD_AGENTS_MAX];
    uint8_t agent_count;
    pod_tab_t tabs[POD_TABS_MAX];
    uint8_t tab_count, selected;         // tabs holding no agent are left out; selected == tab_count: the window's tab is one of those
    bool linked;
    uint32_t revision;                   // bumped by every feed that changes something
    uint32_t clock_ms;                   // the newest now_ms seen (pod_model_clock); the stale rule reads it
    bool clock_set;
    pod_unread_t unread[POD_UNREAD_MAX];
    uint8_t unread_count;
    pod_read_out_t reads[POD_READS_MAX];
    uint8_t read_count;
    // The Swarm cards (hello swarmCard:v1): the daemon's list, in card order, with each Lead's cached recap text (PSRAM, owned here).
    pod_swarm_t swarms[SWARMS_CARD_MAX];
    uint8_t swarm_n;                     // the received ones, in the order of want[]
    char want[SWARMS_CARD_MAX][ID_MAX];  // the last `supertabs` id list: set and order; a Swarm not here is dropped, one not received yet is absent
    uint8_t want_n;
    bool swarm_ids;                      // a `supertabs` list has arrived on this link (want[] is then the truth; before it, a Swarm that is not here may just not be sent yet)
    // supertab.focus: the desktop opened this Swarm project. Kept until the view that acts on it clears focus_pending (a focus for a
    // Swarm the list does not hold yet waits for it).
    bool focus_pending;
    char focus_tab[ID_MAX], focus_lead[ID_MAX];
} pod_model_t;

// Copy src into dst[cap], cut on a UTF-8 codepoint boundary (always valid, always NUL-terminated); src may be dst.
void pod_copy_str(char *dst, size_t cap, const char *src);
// Cut a trailing partial UTF-8 codepoint off s (after an snprintf that truncated).
void pod_utf8_trim(char *s);

void pod_model_reset(pod_model_t *);
// The random source a new turn draws its working scene from (pod_agent_t.work_alt): esp_random on the device (pro_app);
// NULL, the default, always the first scene (the host tests and goldens: the chef).
void pod_model_random(uint32_t (*rnd)(void));
// Interface addition: call at agents.begin; agents_end then drops every agent not re-sent since.
void pod_model_agents_begin(pod_model_t *);
void pod_model_agent(pod_model_t *, const char *id, const char *name, const char *engine, const char *machine);
void pod_model_agents_end(pod_model_t *);
void pod_model_swarms(pod_model_t *, const cable_swarm_t *items, const char *const *agent_ids[],
                      const uint8_t agent_id_counts[], int n, const char *selected,
                      const cable_tile_t *tiles, int tile_count);
// The same with the daemon's member metadata: meta[i][k] describes agent_ids[i][k] (NULL: none, nothing changes). A member
// that no roster source lists and whose machine is offline joins the roster as POD_OFFLINE (source POD_SRC_TAB_META, which
// the agents.* and library sweeps leave alone) for as long as the tab still lists it.
typedef cable_swarm_member_meta_t pod_member_meta_t;
void pod_model_swarms_meta(pod_model_t *, const cable_swarm_t *items, const char *const *agent_ids[],
                           const uint8_t agent_id_counts[], int n, const char *selected,
                           const cable_tile_t *tiles, int tile_count, const pod_member_meta_t (*meta)[POD_PANES_MAX]);
// player.library is the second roster source: every session on every machine, so tabs other than the window's
// show their agents. A sweep is library_begin, one library_row per row of every page, library_end (which drops the
// LIBRARY source from agents the sweep did not see). A row adds the agent if absent, fills empty name / engine /
// machine, and applies `status` like pod_model_library_status. age_s is the row's ageSeconds (-1 unknown).
// The roster holds POD_AGENTS_MAX agents. When it is full, a library-only agent is kept over another by: member of
// some tab, then working or asking, then most recent. A row that ranks below every library-only agent is not
// added; agents.* agents always make room.
void pod_model_library_begin(pod_model_t *);
void pod_model_library_row(pod_model_t *, const char *id, const char *name, const char *engine, const char *machine,
                           const char *status, int32_t age_s, uint32_t now_ms);
void pod_model_library_end(pod_model_t *);
void pod_model_library_status(pod_model_t *, const char *id, const char *status, uint32_t now_ms);
// kind: started, activity (text = the progress sentence, the `action`), verb (text = the footer's spinner word),
// step (text = a tool the turn started, "Read · file.c"), done, error.
// An empty text never blanks the line it feeds.
void pod_model_turn(pod_model_t *, const char *id, const char *kind, const char *text, int elapsed_s, uint32_t now_ms);
// turn.stats: the last turn's test and commit counts (-1 leaves a field unknown). Unknown agents are ignored.
void pod_model_turn_stats(pod_model_t *, const char *id, int32_t passed, int32_t failed, int32_t commits, int32_t tokens_in, int32_t tokens_out);
void pod_model_question(pod_model_t *, const char *id, const char *text);
// The same for a Super Tab's question: super_tab (NULL or "" = a plain one, attention ignored) and what it needs.
// Unlike a plain one it survives the agent's turns and library sweeps: only question_close (or the link) ends it.
void pod_model_question_tab(pod_model_t *, const char *id, const char *text, const char *super_tab, pod_attention_t attention);
// What the agent's open question asks for: DECISION or STUCK while it asks (pod_model_eff) a Super Tab's question, else NONE.
pod_attention_t pod_model_attention(const pod_model_t *, const pod_agent_t *);
void pod_model_question_close(pod_model_t *, const char *id);
void pod_model_recap(pod_model_t *, const char *id, const char *recap, bool restore);
void pod_model_link(pod_model_t *, bool up);

// ---- the Swarm cards ----
// The `supertabs` id list (at most SWARMS_CARD_MAX, bad or repeated ids skipped): Swarms not listed are dropped and their texts freed, the
// rest are put in this order; a listed Swarm not received yet stays absent until pod_model_supertab brings it.
void pod_model_supertab_ids(pod_model_t *, const char (*ids)[ID_MAX], int n);
// One `supertab` frame: replaces that Swarm's data (a new one is placed by the id list's order). A Lead that was in the old data (same Lead id)
// keeps its recap state and text; the texts of Leads that left are freed. Stamps since_at_ms with now_ms. Ignored when the id is not in the list.
void pod_model_supertab(pod_model_t *, const pod_swarm_t *s, uint32_t now_ms);
// A Lead's last message: LOADED with a copy of `text` (cut to SWARM_TEXT_MAX - 1 on a codepoint), or EMPTY when `none`. Unknown Swarm/Lead: dropped.
void pod_model_supertab_recap(pod_model_t *, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none);
// The Lead view asks for / lets go of a Lead's last message: loading puts a cold one (NONE) to LOADING (the texts arrive as pod_model_supertab_recap);
// close sends a LOADING, LOADED or EMPTY one back to NONE and frees its text (only the open Lead gets pushes, so a closed one would go stale).
void pod_model_supertab_loading(pod_model_t *, const char *tab, const char *lead);
void pod_model_supertab_close(pod_model_t *, const char *tab, const char *lead);
// supertab.focus: record it as pending (focus_pending, focus_tab, focus_lead); the latest one wins.
void pod_model_supertab_focus(pod_model_t *, const char *tab, const char *lead);
const pod_swarm_t *pod_model_swarm_for_tab(const pod_model_t *, const char *tab_id);   // the desk tab's Swarm (its `tab` link); NULL for "" or none
const pod_swarm_t *pod_model_swarm(const pod_model_t *, const char *swarm_id);
// Index of the Lead in the Swarm, or -1.
int pod_model_lead_index(const pod_swarm_t *, const char *lead_id);

const pod_agent_t *pod_model_find(const pod_model_t *, const char *id);
// The agents with the most recent task (the newer of act_ms and lib_ms), at most max, newest first. An agent with
// neither clock has had no task the Pod knows of and is not listed.
// When there are more candidates than max, every working or asking agent (by the effective state) is kept first, most
// recent first, and the most recent others fill the rest. The list is only as stable as the clocks: it reorders when
// an agent gets news.
int pod_model_recent(const pod_model_t *, const pod_agent_t *out[], int max);
// A message (a voice recording) was delivered to the agent: show it Working now, as the turn it starts will. Until a turn
// event arrives a sweep's idle or finished does not undo it; with none in POD_SENT_WAIT_MS it shows Idle again.
#define POD_SENT_WAIT_MS 30000u
void pod_model_sent(pod_model_t *, const char *id, uint32_t now_ms);
int pod_model_working(const pod_model_t *, const pod_agent_t *out[], int max);
// The state to show: the agent's own, except that a Working only the Pod's own send put there goes Idle when no turn
// event followed within POD_SENT_WAIT_MS. A real turn stays Working until done, error, a library status that says
// otherwise, or the link drops (owner decision, port inventory 7.1: no 25 s expiry). pod_model_eff is that at the model's clock and is what every reader uses (the working
// list, the tab counts and tints, the rows, the recap rule, the cap's ranking); pod_model_state names the instant.
pod_state_t pod_model_state(const pod_model_t *, const pod_agent_t *, uint32_t now_ms);
pod_state_t pod_model_eff(const pod_model_t *, const pod_agent_t *);
// Advance the model's clock (never backwards). Feeds that carry now_ms do it themselves; the renderer calls it.
void pod_model_clock(pod_model_t *, uint32_t now_ms);
bool pod_model_opens_on_recap(const pod_model_t *, const pod_agent_t *);

// ---- unread notifications ----
// A new notification for the agent: replaces its entry and moves it to the top; at POD_UNREAD_MAX the oldest goes.
// `text` is cut on a codepoint; name may be "". elapsed_s -1 = unknown.
void pod_model_unread_add(pod_model_t *, const char *agent, const char *name, const char *text, int32_t elapsed_s, uint32_t now_ms);
// The whole list at once (notif.replace): clear, then append in the order given (first = newest). One per agent, at most
// POD_UNREAD_MAX; an append past that or for an agent already listed is dropped.
void pod_model_unread_clear(pod_model_t *);
void pod_model_unread_append(pod_model_t *, const char *agent, const char *name, const char *token, const char *text, uint32_t now_ms);
// Read elsewhere (notif.seen): drop the agent's entry. With a token, only an entry that has that token or none. True if dropped.
bool pod_model_unread_seen(pod_model_t *, const char *agent, const char *token);
// Read here: the same, and an entry that had a token is queued in reads[] for notif.read.
bool pod_model_unread_read(pod_model_t *, const char *agent);
const pod_unread_t *pod_model_unread_find(const pod_model_t *, const char *agent);
// How many notices Pets lists (the Notices screen and Home's Notices card): the asking agents, then the unread entries of agents that are not asking.
int pod_notice_count(const pod_model_t *);
// A Swarm chat's notice (supertab.notice): an entry like an agent's, keyed by its Lead (one per Lead, the newest replacing, the 16 cap shared), named by the Lead's
// project. Nothing is filed for a Swarm or Lead the model does not hold. The read drops only the entry of that tab, Lead AND chat (true when it did), so one that
// arrives before its notice, or for another chat, leaves the row alone.
void pod_model_swarm_notice(pod_model_t *, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t now_ms);
bool pod_model_swarm_notice_read(pod_model_t *, const char *tab, const char *lead, const char *chat_id);
// The entry of a question that was just asked (the toast needs one): like pod_model_unread_add, marked `ask`.
void pod_model_unread_ask(pod_model_t *, const char *agent, const char *name, const char *text, uint32_t now_ms);
// Take the queued notif.read frames (at most max); returns the count.
int pod_model_take_reads(pod_model_t *, pod_read_out_t out[], int max);
