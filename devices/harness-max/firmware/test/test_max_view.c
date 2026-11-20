// The screen drawn from the model, page by page, at this build's glass height (run.sh builds it at both): the run
// budget, every run on the glass and every word inside its box (cut with an ellipsis when it does not fit, never after
// one), each page's hits in the order the finger reads them, the notice and the toast, New Harness, the update screen,
// and what moves by the clock. Pages are set straight in max_m, so these tests do not lean on the model's own moves.
#include "max_test.h"
#include "max_ui_motion.h"
#include "pod/pod_draw.h"

enum { K_TEXT = 1, K_IMAGE = 3, K_POD_CELL = 16 };   // pro_canvas.c's PRO_TEXT, PRO_IMAGE; pod_draw.h's POD_CELL
#define T0 1000000u
#define ELLIPSIS "\xe2\x80\xa6"

static const char *const ABCDE[] = {"a", "b", "c", "d", "e"};

static bool within(ht_rect_t b, max_box_t o)
{
    return b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h;
}
static max_box_t box_of(const max_hit_t *h) { return (max_box_t){h->x, h->y, h->w, h->h}; }
static bool apart(max_box_t a, max_box_t b)
{
    return a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
}
static const max_hit_t *find_hit(max_hit_kind_t kind, int arg)
{
    for (int i = 0; i < max_m.hit_count; i++)
        if (max_m.hits[i].kind == kind && max_m.hits[i].arg == arg) return &max_m.hits[i];
    return NULL;
}
static int hits_of(max_hit_kind_t kind)
{
    int n = 0;
    for (int i = 0; i < max_m.hit_count; i++) n += max_m.hits[i].kind == kind;
    return n;
}
// The hits drawn are exactly these kinds, in this order.
static bool hits_are(const max_hit_kind_t *kinds, int n)
{
    bool same = max_m.hit_count == n;
    for (int i = 0; same && i < n; i++) same = max_m.hits[i].kind == kinds[i];
    if (!same) {
        fprintf(stderr, "hits:");
        for (int i = 0; i < max_m.hit_count; i++) fprintf(stderr, " %d/%d", max_m.hits[i].kind, max_m.hits[i].arg);
        fprintf(stderr, "\n");
    }
    return same;
}
#define HITS_ARE(...) \
    hits_are((const max_hit_kind_t[]){__VA_ARGS__}, sizeof((max_hit_kind_t[]){__VA_ARGS__}) / sizeof(max_hit_kind_t))
// A text run inside the box b.
static const ht_run_t *label_in(max_box_t b)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && within(ht_run_bounds(&S.runs[i]), b)) return &S.runs[i];
    return NULL;
}
// The text run that reads exactly t.
static const ht_run_t *word(const char *t)
{
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, t)) return &S.runs[i];
    return NULL;
}

static int most_runs;
static void check_budget(void)
{
    CHECK(S.count < HT_RUNS);   // below the cap: no run was refused
    if (S.count > most_runs) most_runs = S.count;
}
// Every run on the glass. Inbox's and Apps' last card may run off its right edge (the glass cuts it): a run of it
// starts on the glass inside that card.
static void check_glass(void)
{
    max_box_t cut = {0, 0, 0, 0};
    for (int i = 0; i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        if ((h->kind == MAX_HIT_NOTE || h->kind == MAX_HIT_APP || h->kind == MAX_HIT_NEW) && h->x + h->w == HT_WIDTH)
            cut = (max_box_t){h->x, h->y, HT_WIDTH, h->h};
    }
    for (int i = 0; i < S.count; i++) {
        const ht_rect_t b = ht_run_bounds(&S.runs[i]);
        const bool on = b.x >= 0 && b.y >= 0 && b.y + b.h <= HT_HEIGHT &&
                        (b.x + b.w <= HT_WIDTH || (cut.w && b.x >= cut.x && b.x < HT_WIDTH));
        if (!on) fprintf(stderr, "run %d (%d,%d %dx%d) \"%s\" off the glass\n", i, b.x, b.y, b.w, b.h, S.runs[i].text);
        CHECK(on);
    }
}
// The notice's pill: centred at the foot of the glass (in the form's head row while the form is up).
static void check_notice(void)
{
    const ht_run_t *n = max_m.notice[0] && max_notice_shown(T0) ? word(max_m.notice) : NULL;
    if (!n) return;
    const ht_rect_t b = ht_run_bounds(n);
    if (max_form_open()) CHECK(b.y + b.h < HT_HEIGHT / 2);
    else CHECK(b.y > HT_HEIGHT / 2 && abs(b.x + b.w / 2 - HT_WIDTH / 2) < DX(40));
}
// Every word inside one of the boxes, the toast's and the done note's inside theirs, the notice's where check_notice
// says; and no word cut after an ellipsis.
static void check_words(const max_box_t *boxes, int n)
{
    const max_hit_t *toast = find_hit(MAX_HIT_TOAST, 0), *done = find_hit(MAX_HIT_DONE_NOTE, 0);
    for (int i = 0; i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind != K_TEXT) continue;
        CHECK(!strstr(r->text, ELLIPSIS ELLIPSIS));
        const ht_rect_t b = ht_run_bounds(r);
        bool in = (toast && within(b, box_of(toast))) || (done && within(b, box_of(done))) ||
                  (max_m.notice[0] && !strcmp(r->text, max_m.notice));
        for (int k = 0; !in && k < n; k++) in = within(b, boxes[k]);
        if (!in) fprintf(stderr, "word run %d (%d,%d %dx%d) \"%s\" outside its box\n", i, b.x, b.y, b.w, b.h, r->text);
        CHECK(in);
    }
    check_notice();
}
// Every hit a finger's size, on the glass; none over another but the toast, the done note and the hits that cover a
// whole page (Body, Away, Wake), which the finger reads last.
static void check_hits(void)
{
    CHECK(max_m.hit_count <= MAX_HITS);
    for (int i = 0; i < max_m.hit_count; i++) {
        const max_hit_t *h = &max_m.hits[i];
        CHECK(h->x >= 0 && h->y >= 0 && h->x + h->w <= HT_WIDTH && h->y + h->h <= HT_HEIGHT);
        CHECK(h->w >= 40 && h->h >= 40);
        if (h->kind == MAX_HIT_TOAST || h->kind == MAX_HIT_DONE_NOTE || h->kind == MAX_HIT_BODY ||
            h->kind == MAX_HIT_AWAY || h->kind == MAX_HIT_WAKE)
            continue;
        for (int j = 0; j < i; j++) {
            const max_hit_t *o = &max_m.hits[j];
            if (o->kind == MAX_HIT_RELAX) continue;   // TEMP: Relax lies in Apps' Close column, ahead of it
            if (o->kind != MAX_HIT_TOAST && o->kind != MAX_HIT_DONE_NOTE) CHECK(apart(box_of(h), box_of(o)));
        }
    }
}
// The whole-page hit, if any, is the last one: everything drawn over it wins.
static void check_page_hit_last(max_hit_kind_t kind)
{
    CHECK(hits_of(kind) == 1 && max_m.hits[max_m.hit_count - 1].kind == kind);
}

static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;
static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }
// The question read whole, as the daemon answers question.read.
static void asked(const char *id, const pro_ask_item_t *items, int n, bool permission)
{
    max_ui_question(id, "toolu_1", items[0].q, items, n, permission, true, T0);
    take(T0);
    max_ui_question_state(id, max_ask_of(id)->fetch, true, "toolu_1", "tok", false, NULL, items, n, T0);
}
static void working(const char *id, const char *text)
{
    max_ui_turn(id, "started", "", 0, T0 - 134000);
    max_ui_turn(id, "step", "Read \xc2\xb7 main/display/touch_gt911.c with a long path that runs on and on", -1, T0);
    max_ui_turn(id, "step", "Edit \xc2\xb7 main/display/pro_display.c", -1, T0);
    max_ui_turn(id, "verb", "Infusing...", -1, T0);
    max_ui_turn(id, "activity", text, 134, T0);
}
// A recording for id ("": the form's spoken name), with a run of speech in the mic's levels when heard.
static void talk(const char *id, max_talk_t state, bool heard)
{
    max_copy(max_m.talk_id, sizeof max_m.talk_id, id);
    max_ui_talk(state, T0 - 3000);
    for (int i = 0; heard && i < MAX_LEVELS; i++) max_ui_level((unsigned)(i * 7 % 5), T0 - (MAX_LEVELS - i) * 100u);
    if (heard) max_m.talk_quiet_from = T0 - 500;
}
static void show(max_view_t view, const char *id)
{
    max_m.view = view;
    if (id) max_copy(max_m.selected, sizeof max_m.selected, id);
}
static void attention(const char *id, max_attn_t kind, uint32_t from)
{
    max_m.view = MAX_VIEW_ATTENTION;
    max_copy(max_m.attn_id, sizeof max_m.attn_id, id);
    max_m.attn = kind;
    max_m.attn_from = from;
}
// Each render is the page drawn afresh: App Detail's row at rest where the model sends it (its motion is
// test_max_motion.c's).
static void render_at(uint32_t now)
{
    max_m.row.drawn = false;
    ht_scene_clear(&S, ht_rgb(HT_THEME_CANVAS));
    max_ui_render(&S, now);
}
static void set_engine(const char *id, const char *engine)
{
    max_copy(max_find(id)->engine, sizeof max_find(id)->engine, engine);
}

static const char *LONG_NAME = "an-agent-name-that-is-far-too-long-for-any-box-on-this-bar";
static const char *VIET_NAME = "Tr\xe1\xbb\xa3 l\xc3\xbd vi\xe1\xba\xbft t\xc3\xa0i li\xe1\xbb\x87u ti\xe1\xba\xbfng "
                               "Vi\xe1\xbb\x87t cho c\xe1\xba\xa3 nh\xc3\xb3m";
static const char *LONG_TEXT = "Editing the touch driver so that the panel and the finger agree on which way is up, "
    "then running every host test again before the build, because a rotated panel hides its mistakes well";
static const char *VIET_TEXT = "\xc4\x90\xc3\xa2y l\xc3\xa0 m\xe1\xbb\x99t c\xc3\xa2u ti\xe1\xba\xbfng Vi\xe1\xbb\x87t "
    "d\xc3\xa0i \xc4\x91\xe1\xbb\x83 xem ch\xe1\xbb\xaf c\xc3\xb3 d\xe1\xba\xa5u v\xe1\xba\xabn v\xe1\xba\xbd \xc4\x91\xc3\xban "
    "v\xc3\xa0 c\xe1\xba\xaft \xc4\x91\xc3\xban ch\xe1\xbb\x97 khi h\xe1\xba\xbft ch\xe1\xbb\x97 tr\xc3\xaan l\xc3\xa0n";

static const pro_app_row_t APPS[] = {{"harness", "Harness", 3, 1}, {"orca", "Orca", 5, 0}, {"vscode", "VS Code", 1, 0},
                                     {"herdr", "herdr with a name too long for its card", 2, 0},
                                     {"ghostty", "Ghostty", 0, 0}, {"terminal", "Terminal", 2, 1},
                                     {"iterm", "iTerm2", 1, 0}, {"warp", "Warp", 1, 0}};
static const pro_ask_item_t DB = {"db", "Which database should the migration run on?", {"Dev", "Staging"}, 2, false,
                                  true};
static const pro_ask_item_t FLASH = {"perm", "Approve Bash command: make flash PORT=usb",
                                     {"Yes", "Yes, and don't ask again for: make flash*",
                                      "No, and tell Claude what to do differently"}, 3, false, true};

// Five agents of every kind of state, long and Vietnamese names, the computer with apps and New Harness.
static void ring(const char *caps)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    max_ui_offers(true);
    max_ui_apps("harness", APPS, 8, T0);
    const pro_agent_row_t rows[] = {{"a", "alpha", "claude", "m1", "MacBook Pro", "harness", caps},
                                    {"b", LONG_NAME, "codex", "m1", "MacBook Pro", "harness", caps},
                                    {"c", VIET_NAME, "muse", "m1", "MacBook Pro", "harness", caps},
                                    {"d", "delta", "gemini", "m1", "MacBook Pro", "harness", caps},
                                    {"e", "echo", "claude", "m1", "MacBook Pro", "harness", caps}};
    max_ui_agents(rows, 5, T0);
    working("a", LONG_TEXT);
    working("b", VIET_TEXT);
    max_ui_turn("c", "started", "", 0, T0 - 60000);
    max_ui_summary("c", VIET_TEXT, NULL, false, POD_TIER_ALERT, T0 - 30000);
    max_ui_turn("e", "started", "", 0, T0 - 60000);
    asked("e", &DB, 1, false);
}
// An Inbox of n notices in place of what the model put there: every kind, read and unread, long names and words.
static void inbox(int n)
{
    static const max_attn_t KINDS[] = {MAX_ATTN_ASK, MAX_ATTN_DONE, MAX_ATTN_FAIL};
    max_m.inbox_count = 0;
    for (int i = 0; i < n && i < MAX_INBOX; i++) {
        max_inbox_t *e = &max_m.inbox[max_m.inbox_count++];
        snprintf(e->id, sizeof e->id, "n%d", i);
        snprintf(e->name, sizeof e->name, "%s", i % 2 ? LONG_NAME : VIET_NAME);
        snprintf(e->engine, sizeof e->engine, "%s", i % 3 ? "claude" : "codex");
        snprintf(e->app, sizeof e->app, "%s", i % 2 ? "Orca" : "Harness");
        snprintf(e->text, sizeof e->text, "%s", i % 2 ? LONG_TEXT : VIET_TEXT);
        e->kind = KINDS[i % 3];
        e->at = T0 - (uint32_t)i * 70000u;
        e->unread = i < 2;
    }
}

// ---- the budget ----

// The busiest screen of each page at this glass, every engine's pet where a pet moves: none reaches the cap.
static void test_budget(void)
{
    static const char *const ENGINES[] = {"claude", "codex", "muse", "gemini"};
    for (int e = 0; e < 4; e++) {
        ring(NULL);
        inbox(MAX_INBOX);
        max_ui_notice("Sent to an-agent-name-that-is-far-too-long-for-one", 3000, T0 - 300);   // up whole by T0
        show(MAX_VIEW_OVERVIEW, NULL);
        render_at(T0);
        check_budget();
        set_engine("a", ENGINES[e]);
        show(MAX_VIEW_AGENT, "a");
        talk("a", MAX_TALK_RECORDING, true);
        max_copy(max_m.toast_id, sizeof max_m.toast_id, "e");
        max_m.toast_from = T0 - 1000;
        render_at(T0);
        check_budget();
        talk("a", MAX_TALK_IDLE, false);
        static const pro_ask_item_t two[] = {
            {"branch", "Where should the fix go?", {"main", "release/0.9"}, 2, false, true},
            {"board", "Which boards should the panel driver be flashed to before the release goes out?",
             {"ESP32-P4 Function EV", "Max rev A", "Max rev B", "Harness Pro", "Dial", "None of these"}, 6, true, true}};
        set_engine("e", ENGINES[e]);
        asked("e", two, 2, false);
        max_ask_hit(max_find("e"), MAX_HIT_OPTION, 0, T0);
        max_ask_hit(max_find("e"), MAX_HIT_OPTION, 2, T0);
        attention("e", MAX_ATTN_ASK, T0 - 500);
        render_at(T0);
        CHECK(hits_of(MAX_HIT_OPTION) == 6 && find_hit(MAX_HIT_STEP_BACK, 0) && find_hit(MAX_HIT_SEND, 0));
        check_budget();
        show(MAX_VIEW_INBOX, NULL);
        render_at(T0);
        check_budget();
        show(MAX_VIEW_APPS, NULL);
        render_at(T0);
        check_budget();
        max_ui_wall(true, 23, 59, 3, 31, 11);
        show(MAX_VIEW_AMBIENT, NULL);
        render_at(T0);
        check_budget();
    }
    printf("test_max_view: at most %d runs of %d on the busiest screens\n", most_runs, HT_RUNS);
}

// ---- App Detail ----

// The runs the compositor draws of one kind (a sliver's veil).
static int runs_of(int kind)
{
    int n = 0;
    for (int i = 0; i < S.count; i++) n += S.runs[i].pro_kind == kind;
    return n;
}

// The app column (Apps when the daemon lists apps), three cells by need, the bell; nothing else to hit, nothing
// moving. Each cell: its name, the line of its task, its chip.
static void test_overview(void)
{
    ring(NULL);
    inbox(3);
    show(MAX_VIEW_OVERVIEW, NULL);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_APPS, MAX_HIT_BELL));
    CHECK(max_m.cell_hits == MAX_CELLS);
    const max_box_t apps = box_of(find_hit(MAX_HIT_APPS, 0)), bell = box_of(find_hit(MAX_HIT_BELL, 0));
    for (int i = 0; i < max_m.cell_hits; i++) {
        CHECK(apart(max_m.cell_box[i], apps) && apart(max_m.cell_box[i], bell));
        CHECK(max_find(max_m.cell_id[i]) != NULL);
        if (i) CHECK(max_m.cell_box[i].x == max_m.cell_box[i - 1].x + max_m.cell_box[i - 1].w);
    }
    CHECK(max_m.cell_box[MAX_CELLS - 1].x + max_m.cell_box[MAX_CELLS - 1].w <= bell.x);
    // By need: e asks, a and b work (the ring's order); c (done) and d (resting) past the glass.
    CHECK(!strcmp(max_m.cell_id[0], "e") && !strcmp(max_m.cell_id[1], "a") && !strcmp(max_m.cell_id[2], "b"));
    max_box_t boxes[MAX_CELLS + 2] = {apps, bell};
    for (int i = 0; i < max_m.cell_hits; i++) boxes[2 + i] = max_m.cell_box[i];
    check_words(boxes, 2 + max_m.cell_hits);
    check_glass();
    check_hits();
    // The shown app, how many agents, the badge (2 unread), the chips, the tasks.
    CHECK(word("Harness") && word("5 agents") && word("2") && word("Needs you") && word("Infusing"));
    CHECK(text_run("Which database") && text_run("Editing the touch driver") && !word("Done"));
    CHECK(max_motion_ms(T0) <= MAX_LOOP_FRAME_MS);   // the rails and chips loop, the cells' pets play
    // Long and Vietnamese names cut with an ellipsis, inside their cells.
    const ht_run_t *cut = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, "an-agent", 8)) cut = &S.runs[i];
    CHECK(cut && strstr(cut->text, ELLIPSIS));
    // Scrolled to its end: c's summary and chip, d with nothing to say.
    max_m.row_first = 2;
    render_at(T0);
    CHECK(!strcmp(max_m.cell_id[0], "b") && !strcmp(max_m.cell_id[2], "d"));
    CHECK(word("Done") && word("Resting") && word("No task yet") && !word("Needs you"));
    for (int i = 0; i < max_m.cell_hits; i++) boxes[2 + i] = max_m.cell_box[i];
    check_words(boxes, 2 + max_m.cell_hits);
    max_m.row_first = 9;   // past the row's end: its last cells
    render_at(T0);
    CHECK(!strcmp(max_m.cell_id[0], "b") && max_m.cell_hits == MAX_CELLS);
    max_m.row_first = 0;
    // No apps frame (an older daemon): the computer's name, no Apps.
    max_m.apps_known = false;
    max_m.app_count = 0;
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_BELL) && word("MacBook Pro"));
    // Three agents or fewer: no dots, the cells keep their width.
    static const pro_agent_row_t two[] = {{"a", "a", "claude", "m1", "M", NULL, NULL},
                                          {"f", "f", "codex", "m1", "M", NULL, NULL}};
    max_ui_agents(two, 2, T0);
    render_at(T0);
    CHECK(max_m.cell_hits == 2 && max_m.cell_box[0].w == max_m.cell_box[1].w && word("2 agents"));
    CHECK(max_m.cell_box[0].w * 3 < HT_WIDTH);
    check_glass();
    // Empty: no agents, not connected; no cells either way.
    max_ui_agents(NULL, 0, T0);
    render_at(T0);
    CHECK(max_m.cell_hits == 0 && word("No agents yet") && !text_run("0 agents"));
    max_ui_reset();
    show(MAX_VIEW_OVERVIEW, NULL);
    render_at(T0);
    CHECK(max_m.cell_hits == 0 && word("Not connected") && HITS_ARE(MAX_HIT_BELL));
}

// ---- the open agent ----

// Its words in its panel (the body), the app column's and the bell's in theirs; the slivers have none (a pet-less
// engine's ">_" mark is its pet), but for the done note's over them.
static void agent_words(void)
{
    const max_hit_t *done = find_hit(MAX_HIT_DONE_NOTE, 0);
    const max_hit_t *body = find_hit(MAX_HIT_BODY, 0), *x = find_hit(MAX_HIT_AGENT_X, 0);
    const max_box_t panel = body ? box_of(body) : (max_box_t){(int16_t)(x->x + x->w - DX(900)), 0, (int16_t)DX(900),
                                                              (int16_t)HT_HEIGHT};
    max_box_t boxes[3 + MAX_CELLS] = {panel, box_of(find_hit(MAX_HIT_BELL, 0)),
                                      {0, 0, (int16_t)DX(196), (int16_t)HT_HEIGHT}};
    for (int i = 0; i < max_m.cell_hits; i++) boxes[3 + i] = max_m.cell_box[i];
    check_words(boxes, 3 + max_m.cell_hits);
    check_glass();
    check_hits();
    for (int i = 0; i < max_m.cell_hits; i++) {
        CHECK(apart(max_m.cell_box[i], panel));
        for (int k = 0; k < S.count; k++)
            if (S.runs[k].pro_kind == K_TEXT && within(ht_run_bounds(&S.runs[k]), max_m.cell_box[i]) &&
                !(done && within(ht_run_bounds(&S.runs[k]), box_of(done))))
                CHECK(!strcmp(S.runs[k].text, ">_"));
    }
}
static void test_agent_page(void)
{
    ring(NULL);
    show(MAX_VIEW_AGENT, "c");   // done, its summary in Vietnamese; by need e a b c d: b and d beside it
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_APPS, MAX_HIT_AGENT_X, MAX_HIT_BODY, MAX_HIT_BELL));
    CHECK(max_m.cell_hits == 2 && !strcmp(max_m.cell_id[0], "b") && !strcmp(max_m.cell_id[1], "d"));
    CHECK(max_m.cell_box[0].w == max_m.cell_box[1].w && max_m.cell_box[0].w < DX(200) && !runs_of(POD_VEIL));
    for (int i = 0; i < 2; i++) {   // each sliver one layer, dimmed and blurred off the glass, exactly its box
        int layers = 0;
        for (int k = 0; k < S.count; k++) {
            const ht_rect_t b = ht_run_bounds(&S.runs[k]);
            layers += S.runs[k].pro_kind == K_IMAGE && b.x == max_m.cell_box[i].x && b.w == max_m.cell_box[i].w &&
                      b.y == 0 && b.h == HT_HEIGHT;
        }
        CHECK(layers == 1);
    }
    const max_box_t panel = box_of(find_hit(MAX_HIT_BODY, 0));
    CHECK(panel.x == max_m.cell_box[0].x + max_m.cell_box[0].w && max_m.cell_box[1].x == panel.x + panel.w);
    const max_hit_t *x = find_hit(MAX_HIT_AGENT_X, 0);
    CHECK(x->y == 0 && x->x + x->w == panel.x + panel.w);   // at the panel's top right
    CHECK(word("Done") && word("Tap to talk") && text_run("\xc4\x90\xc3\xa2y l\xc3\xa0"));
    agent_words();
    // The clock closed its mic on nothing heard: the band says so, for its own agent only.
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "c");
    max_m.talk_closed = true;
    render_at(T0);
    CHECK(word("Mic closed \xc2\xb7 tap to talk") && !word("Tap to talk"));
    agent_words();
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "b");
    render_at(T0);
    CHECK(word("Tap to talk") && !word("Mic closed \xc2\xb7 tap to talk"));
    max_m.talk_closed = false;
    // A cell's tap: its mic opens in a moment, and the band says so, for its own agent only.
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "c");
    max_m.talk_soon = true;
    render_at(T0);
    CHECK(word("Mic opens in a moment\xe2\x80\xa6") && !word("Tap to talk") && find_hit(MAX_HIT_BODY, 0));
    agent_words();
    max_copy(max_m.talk_id, sizeof max_m.talk_id, "b");
    render_at(T0);
    CHECK(word("Tap to talk") && !word("Mic opens in a moment\xe2\x80\xa6"));
    max_m.talk_soon = false;
    max_m.talk_id[0] = 0;
    // Its pet moves, on its own beat; a logo holds still (the slivers' pets hold one frame).
    const uint32_t beat = max_motion_ms(T0);
    CHECK(beat > 0 && beat < MAX_WAKE_MS);
    set_engine("c", "gemini");
    render_at(T0);
    CHECK(max_motion_ms(T0) == MAX_WAKE_MS);
    // The first of the row: slivers after it only; the last: before it.
    show(MAX_VIEW_AGENT, "e");
    render_at(T0);
    CHECK(max_m.cell_hits == 2 && !strcmp(max_m.cell_id[0], "a") && !strcmp(max_m.cell_id[1], "b"));
    CHECK(box_of(find_hit(MAX_HIT_BODY, 0)).x == DX(196));
    agent_words();
    show(MAX_VIEW_AGENT, "d");
    render_at(T0);
    CHECK(max_m.cell_hits == 2 && !strcmp(max_m.cell_id[0], "b") && !strcmp(max_m.cell_id[1], "c"));
    agent_words();
    // Nothing said: "No task yet", alone in the row.
    max_ui_agents((const pro_agent_row_t[]){{"z", "zulu", "claude", "m1", "MacBook Pro", "harness", NULL}}, 1, T0);
    show(MAX_VIEW_AGENT, "z");
    render_at(T0);
    CHECK(word("No task yet") && word("zulu") && word("Resting") && max_m.cell_hits == 0);
    CHECK(HITS_ARE(MAX_HIT_APPS, MAX_HIT_AGENT_X, MAX_HIT_BODY, MAX_HIT_BELL));
    agent_words();
    // At work: its spinner word on the chip, its activity.
    ring(NULL);
    show(MAX_VIEW_AGENT, "a");
    render_at(T0);
    CHECK(word("Infusing") && text_run("Editing the touch driver") && word("alpha"));
    CHECK(word("alpha")->pro_font == &ph_sb_48);   // a name the large face draws
    agent_words();
    // An agent the bar cannot record for: where to talk to it, and no body to tap.
    ring("sf");
    show(MAX_VIEW_AGENT, "c");
    render_at(T0);
    CHECK(!find_hit(MAX_HIT_BODY, 0) && word("Talk to it in Harness") && !word("Tap to talk"));
    CHECK(HITS_ARE(MAX_HIT_APPS, MAX_HIT_AGENT_X, MAX_HIT_BELL));
    agent_words();
}

// Recording: the band (Listening, its clock, the waveform, Tap to send and its ring), X over the panel's top right; a
// frame every MAX_TALK_FRAME_MS. Sending: X only.
static void test_talking(void)
{
    ring(NULL);
    show(MAX_VIEW_AGENT, "c");
    talk("c", MAX_TALK_RECORDING, false);
    render_at(T0);
    CHECK(word("Listening") && word("Tap to send") && word("Say it" ELLIPSIS) && word("0:03"));
    CHECK(HITS_ARE(MAX_HIT_APPS, MAX_HIT_AGENT_X, MAX_HIT_BODY, MAX_HIT_BELL));
    CHECK(max_motion_ms(T0) <= MAX_TALK_FRAME_MS);
    agent_words();
    // Heard: no "Say it", the ring fills, and the send is coming.
    talk("c", MAX_TALK_RECORDING, true);
    render_at(T0);
    CHECK(!word("Say it" ELLIPSIS) && word("Listening") && text_run("Sending soon") && !word("Tap to send"));
    agent_words();
    // Working while it records: its words stay.
    show(MAX_VIEW_AGENT, "a");
    talk("a", MAX_TALK_RECORDING, true);
    render_at(T0);
    CHECK(word("Listening") && text_run("Editing the touch driver"));
    agent_words();
    // Sending: X, no body; another agent's page: no band.
    talk("a", MAX_TALK_SENDING, true);
    render_at(T0);
    CHECK(word("Sending") && HITS_ARE(MAX_HIT_APPS, MAX_HIT_AGENT_X, MAX_HIT_BELL));
    show(MAX_VIEW_AGENT, "c");
    render_at(T0);
    CHECK(!word("Sending") && !find_hit(MAX_HIT_BODY, 0) && word("Tap to talk"));   // the mic is busy for "a"
    talk("", MAX_TALK_IDLE, false);
}

// ---- Attention ----

static void attention_words(void)
{
    const max_box_t words = {DX(300), 0, HT_WIDTH - DX(300) - DX(60), HT_HEIGHT};   // right of the pet's column
    check_words(&words, 1);
    check_glass();
    check_hits();
    check_page_hit_last(MAX_HIT_AWAY);
    for (int i = 0; i < max_m.hit_count - 1; i++) CHECK(label_in(box_of(&max_m.hits[i])));   // each button's words
}
static void test_attention(void)
{
    ring(NULL);
    attention("e", MAX_ATTN_ASK, T0 - 500);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_OPTION, MAX_HIT_OPTION, MAX_HIT_SAY_IT, MAX_HIT_AWAY));
    CHECK(find_hit(MAX_HIT_OPTION, 0) && find_hit(MAX_HIT_OPTION, 1));
    CHECK(word("echo") && word("asks") && word("Dev") && word("Staging") && word("Say it"));
    CHECK(!strcmp(max_m.card_id, "e") && max_m.card_key == max_card_key(max_find("e")));
    attention_words();
    // The edge light moves, a frame every MAX_EDGE_FRAME_MS, with a logo that holds still.
    set_engine("e", "gemini");
    render_at(T0);
    CHECK(max_motion_ms(T0) <= MAX_EDGE_FRAME_MS);
    // A permission prompt: its command in mono, Allow and Deny for its yes and its no, no Say it.
    ring(NULL);
    asked("a", &FLASH, 1, true);
    attention("a", MAX_ATTN_ASK, T0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_OPTION, MAX_HIT_OPTION, MAX_HIT_AWAY));
    CHECK(find_hit(MAX_HIT_OPTION, 0) && find_hit(MAX_HIT_OPTION, 2) && !find_hit(MAX_HIT_SAY_IT, 0));
    const ht_run_t *cmd = word("make flash PORT=usb");
    CHECK(cmd && cmd->pro_font == &ph_mono_26 && word("Allow") && word("Deny") && word("wants to run"));
    CHECK(within(ht_run_bounds(word("Allow")), box_of(find_hit(MAX_HIT_OPTION, 0))));
    attention_words();
    // Another app's agent: where to answer it, and the whole glass brings it up.
    ring("svf");
    attention("e", MAX_ATTN_ASK, T0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_AWAY) && word("Answer it in Harness") && !word("Dev"));
    attention_words();
    // A wait the bar only shows: the daemon's line ends in " · answer in <App>", which the hint under it says already.
    static const pro_ask_item_t WAIT = {"prompt", "Keep the video? \xc2\xb7 answer in Orca", {"In Orca"}, 1, false, true};
    max_ui_question("e", "shown:w1", WAIT.q, &WAIT, 1, false, true, T0);
    attention("e", MAX_ATTN_ASK, T0);
    render_at(T0);
    CHECK(word("Keep the video?") && word("Answer it in Orca"));
    for (int i = 0; i < S.count; i++) CHECK(S.runs[i].pro_kind != K_TEXT || !strstr(S.runs[i].text, "answer in Orca"));
    attention_words();
    // Done and failed: the summary, the failure; nothing to answer.
    ring(NULL);
    attention("c", MAX_ATTN_DONE, T0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_AWAY) && word("is done"));
    attention_words();
    max_ui_turn("a", "error", "idf.py flash exited with 2: no serial port at /dev/cu.usbmodem1101", 0, T0);
    attention("a", MAX_ATTN_FAIL, T0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_AWAY) && word("failed"));
    attention_words();
    // An answer that failed: Reload and why, once (not again beside it when the notice says the same).
    ring(NULL);
    max_ask_hit(max_find("e"), MAX_HIT_OPTION, 1, T0);
    take(T0);
    max_ui_answer_receipt("e", max_ask_of("e")->fetch, "tok", false, false, "Question changed.", T0);
    attention("e", MAX_ATTN_ASK, T0);
    max_ui_notice("", 0, 0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_RELOAD, MAX_HIT_AWAY) && word("Question changed."));
    max_ui_notice("Question changed.", 3000, T0 - 300);   // up whole by T0: it fades in over 300 ms
    render_at(T0);
    int said = 0;
    for (int i = 0; i < S.count; i++) said += S.runs[i].pro_kind == K_TEXT && !strcmp(S.runs[i].text, "Question changed.");
    CHECK(said == 1);
}

// ---- Inbox, Apps, Ambient ----

static void test_inbox(void)
{
    ring(NULL);
    inbox(MAX_INBOX);
    show(MAX_VIEW_INBOX, NULL);
    render_at(T0);
    CHECK(max_m.hits[0].kind == MAX_HIT_CLOSE && hits_of(MAX_HIT_NOTE) == max_m.hit_count - 1);
    CHECK(hits_of(MAX_HIT_NOTE) >= 3 && hits_of(MAX_HIT_NOTE) < MAX_INBOX);   // the rest past the glass
    for (int i = 1; i < max_m.hit_count; i++) CHECK(max_m.hits[i].arg == i - 1);
    CHECK(word("Inbox") && word("2 unread") && word("asks"));
    // Each card's words in its card; the last card's run off the glass's edge.
    max_box_t boxes[MAX_INBOX + 1] = {box_of(&max_m.hits[0])};
    for (int i = 1; i < max_m.hit_count; i++) {
        boxes[i] = box_of(&max_m.hits[i]);
        if (boxes[i].x + boxes[i].w == HT_WIDTH) boxes[i].w = DX(372);
    }
    check_words(boxes, max_m.hit_count);
    check_glass();
    check_hits();
    CHECK(max_motion_ms(T0) == MAX_LOOP_FRAME_MS);   // the unread cards' dots pulse
    // Empty: it says so, and nothing loops.
    max_m.inbox_count = 0;
    render_at(T0);
    CHECK(max_motion_ms(T0) == MAX_WAKE_MS);
    CHECK(HITS_ARE(MAX_HIT_CLOSE) && word("Nothing new") && !word("0 unread"));
}

static void test_apps(void)
{
    ring(NULL);
    show(MAX_VIEW_APPS, NULL);
    render_at(T0);
    // TEMP (the owner's call of 20 Nov, to try Ambient): Relax, unseen, right under "APPS" in Close's column and ahead
    // of it; the cards as before.
    const max_hit_t *relax = &max_m.hits[0];
    CHECK(relax->kind == MAX_HIT_RELAX && !word("Relax"));
    CHECK(relax->x + relax->w <= DX(210) && relax->y > HT_HEIGHT / 2 + DY(13) && relax->h == MAX_BUTTON_H);
    CHECK(max_m.hits[1].kind == MAX_HIT_CLOSE && hits_of(MAX_HIT_APP) == max_m.hit_count - 2);
    for (int i = 2; i < max_m.hit_count; i++) CHECK(max_m.hits[i].arg == i - 2);
    CHECK(word("Shown") && word("3 agents") && word("1 agent") && word("No agents") && word("Harness"));
    max_box_t boxes[PRO_APPS_MAX + 3] = {box_of(&max_m.hits[0])};
    for (int i = 1; i < max_m.hit_count; i++) {
        boxes[i] = box_of(&max_m.hits[i]);
        if (boxes[i].x + boxes[i].w == HT_WIDTH) boxes[i].w = DX(176);
    }
    check_words(boxes, max_m.hit_count);
    check_glass();
    check_hits();
    CHECK(max_motion_ms(T0) == MAX_WAKE_MS);
    // Few apps: "+ New" last while the computer offers New Harness, else none.
    max_ui_apps("orca", APPS, 2, T0);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_RELAX, MAX_HIT_CLOSE, MAX_HIT_APP, MAX_HIT_APP, MAX_HIT_NEW) && word("New") && word("+"));
    max_ui_offers(false);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_RELAX, MAX_HIT_CLOSE, MAX_HIT_APP, MAX_HIT_APP) && !word("New"));
}

static void test_ambient(void)
{
    ring(NULL);
    max_ui_wall(true, 15, 7, 3, 18, 10);
    show(MAX_VIEW_AMBIENT, NULL);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_WAKE) && max_m.hits[0].w == HT_WIDTH && max_m.hits[0].h == HT_HEIGHT);
    CHECK(word("15") && word("07") && word("Wednesday 18 November") && word("All quiet"));
    CHECK(word("15")->pro_font == &ph_num_230);
    check_glass();
    // The demo's three pets play, whatever the ring holds: the render task wakes for the first of their next steps.
    // Its stars hold still.
    const uint32_t step = max_motion_ms(T0);
    CHECK(step < MAX_WAKE_MS && step <= max_pet_next_ms("claude", POD_SCENE_RELAX, T0) &&
          step <= max_pet_next_ms("muse", POD_SCENE_RELAX, T0) && step <= max_pet_next_ms("codex", POD_SCENE_REST, T0));
    // No wall clock yet: no clock.
    max_ui_wall(false, 0, 0, 0, 1, 0);
    render_at(T0);
    CHECK(!word("15") && word("All quiet"));
    max_ui_agents(NULL, 0, T0);
    render_at(T0);
    CHECK(word("No agents yet") && max_motion_ms(T0) == step);
    max_ui_reset();
    max_m.view = MAX_VIEW_AMBIENT;
    render_at(T0);
    CHECK(word("Not connected") && HITS_ARE(MAX_HIT_WAKE) && max_motion_ms(T0) == step);
}

// A cell's pet plays its state's scene at rest, as V3's PetView (the owner, 20 Nov: the bar looked still): an Overview of
// resting agents, where nothing loops, wakes for its pets' next step and draws them anew there. Logos hold still and
// let it sleep.
static const ht_run_t *pet_in(int cell)
{
    for (int k = 0; k < S.count; k++) {
        const ht_rect_t b = ht_run_bounds(&S.runs[k]);
        if (S.runs[k].pro_kind == K_POD_CELL && b.x >= max_m.cell_box[cell].x &&
            b.x + b.w <= max_m.cell_box[cell].x + max_m.cell_box[cell].w)
            return &S.runs[k];
    }
    return NULL;
}
static void test_cell_pets_play(void)
{
    max_ui_reset();
    max_ui_link(true, "MacBook Pro", T0);
    const pro_agent_row_t rows[] = {{"a", "alpha", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"b", "bravo", "claude", "m1", "MacBook Pro", NULL, NULL},
                                    {"c", "charlie", "claude", "m1", "MacBook Pro", NULL, NULL}};
    max_ui_agents(rows, 3, T0);
    show(MAX_VIEW_OVERVIEW, NULL);
    render_at(T0);
    CHECK(word("Resting") && max_m.cell_hits == 3);
    const uint32_t beat = max_pet_next_ms("claude", max_pet_scene(max_find("a"), false), T0);
    CHECK(beat < MAX_WAKE_MS && max_motion_ms(T0) == beat);
    const ht_run_t *pet = pet_in(0);
    CHECK(pet != NULL);
    const ht_run_t first = *pet;   // the frame and its zoom live in the run (pod_draw.h)
    // On its next steps the pet is drawn anew, another frame of its scene at least once.
    bool moved = false;
    uint32_t t = T0;
    for (int i = 0; i < 40 && !moved; i++) {
        t += max_motion_ms(t);
        render_at(t);
        const ht_run_t *now = pet_in(0);
        CHECK(now != NULL);
        moved = memcmp(&first, now, sizeof first) != 0;
    }
    CHECK(moved);
    // Logos hold still: nothing on the glass moves, the render task sleeps.
    set_engine("a", "gemini");
    set_engine("b", "gemini");
    set_engine("c", "gemini");
    render_at(T0);
    CHECK(max_motion_ms(T0) == MAX_WAKE_MS);
}

// ---- the apps' icons ----

// Whether app's own icon is drawn at size px, with no letter over it.
// Two names of one app draw the same pre-rendered picture.
static bool same_icon(const char *a, const char *b, int size)
{
    const ht_pro_bitmap_t *x = max_icon_find(a, size), *y = max_icon_find(b, size);
    return x && y && x->pixels == y->pixels;
}

static bool icon_drawn(const char *app, int size)
{
    const ht_pro_bitmap_t *b = max_icon_find(app, size);
    for (int i = 0; b && i < S.count; i++) {
        const ht_run_t *r = &S.runs[i];
        if (r->pro_kind == K_IMAGE && r->bitmap.pixels == b->pixels)
            return r->w == size && r->pro_height == size && !label_in((max_box_t){r->x, r->y, r->w, r->pro_height});
    }
    return false;
}

// Every app V3 has an icon for draws it (V3's assets/apps, each its own tile; Harness's its symbol), pre-rendered by
// scripts/gen_app_icons.py at each size a page draws an app: never its letter. An app without one keeps its letter.
static void test_app_icons(void)
{
    ring(NULL);
    show(MAX_VIEW_OVERVIEW, NULL);
    render_at(T0);
    CHECK(icon_drawn("harness", DY(60)) && !word("H"));
    // Apps: Harness's card its symbol, Orca's its letter.
    show(MAX_VIEW_APPS, NULL);
    render_at(T0);
    CHECK(icon_drawn("harness", DY(72)) && icon_drawn("orca", DY(72)) && !word("O"));
    // Inbox: a notice's app, by its name; Attention: the agent's app.
    inbox(2);   // Harness's, then Orca's
    show(MAX_VIEW_INBOX, NULL);
    render_at(T0);
    CHECK(icon_drawn("Harness", DY(22)) && icon_drawn("Orca", DY(22)) && !word("H") && !word("O"));
    attention("e", MAX_ATTN_ASK, T0);
    render_at(T0);
    CHECK(icon_drawn("harness", DY(28)) && !word("H"));
    // V3's key: case and anything but letters and digits aside, V3's other names for the same app; none for an app
    // V3 has no icon for, nor at a size no page draws.
    CHECK(max_icon_find("HARNESS", DY(60)) == max_icon_find("harness", DY(60)));
    CHECK(same_icon("VS Code", "visualstudiocode", DY(60)) && same_icon("codex", "ChatGPT", DY(72)));
    CHECK(max_icon_find("herdr", DY(28)) && max_icon_find("cursor", DY(28)) && max_icon_find("Claude Desktop", DY(28)));
    CHECK(max_icon_find("terminal", DY(22)) && !max_icon_find("ghostty", DY(60)));
    CHECK(!max_icon_find("harness", DY(60) + 1) && !max_icon_find(NULL, DY(60)));
}

// ---- the toast and the notice ----

// A question while a person talks to another agent: the toast at the top, the first hit, with no motion of its own.
static void test_toast(void)
{
    ring(NULL);
    show(MAX_VIEW_AGENT, "c");
    talk("c", MAX_TALK_RECORDING, true);
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "e");
    max_m.toast_from = T0 - 1000;
    render_at(T0);
    CHECK(max_m.hits[0].kind == MAX_HIT_TOAST && hits_of(MAX_HIT_TOAST) == 1);
    const max_box_t toast = box_of(&max_m.hits[0]);
    CHECK(toast.y < HT_HEIGHT / 4 && abs(toast.x + toast.w / 2 - HT_WIDTH / 2) < 2);
    CHECK(word("echo asks") && within(ht_run_bounds(word("echo asks")), toast));
    agent_words();
    // Gone after MAX_TOAST_MS.
    render_at(T0 - 1000 + MAX_TOAST_MS);
    CHECK(!find_hit(MAX_HIT_TOAST, 0));
    // Over the form, with a logo for a pet: nothing moves.
    talk("", MAX_TALK_IDLE, false);
    CHECK(max_ui_form_open("form-1", T0));
    max_m.toast_from = T0 - 1000;
    render_at(T0);
    CHECK(find_hit(MAX_HIT_TOAST, 0) && max_motion_ms(T0) == MAX_WAKE_MS);
}

// A finished turn's note at the bottom right for MAX_DONE_NOTE_MS: the first hit (after a toast), reaching past its
// card, its pet still and its words inside it, the name cut to leave room for "is done". Over an agent that records
// too; never over New Harness or the update screen.
static void test_done_note(void)
{
    ring(NULL);
    show(MAX_VIEW_OVERVIEW, NULL);
    max_copy(max_m.done_id, sizeof max_m.done_id, "c");   // done, a long Vietnamese name and summary
    max_m.done_from = T0 - 1000;
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_DONE_NOTE, MAX_HIT_APPS, MAX_HIT_BELL));
    const max_box_t note = box_of(&max_m.hits[0]);
    CHECK(note.x + note.w > HT_WIDTH - DX(16) && note.y + note.h > HT_HEIGHT - DY(10));
    CHECK(note.x > HT_WIDTH / 2 && note.y > HT_HEIGHT / 2 && note.w <= DX(460) + 2 * DX(12));
    CHECK(word(" is done") && within(ht_run_bounds(word(" is done")), note));
    const ht_run_t *name = NULL, *said = NULL;
    for (int i = 0; i < S.count; i++) {
        if (S.runs[i].pro_kind != K_TEXT || !within(ht_run_bounds(&S.runs[i]), note)) continue;
        if (!strncmp(S.runs[i].text, "Tr\xe1\xbb\xa3", 4)) name = &S.runs[i];
        if (!strncmp(S.runs[i].text, "\xc4\x90\xc3\xa2" "y", 4)) said = &S.runs[i];
    }
    CHECK(name && strstr(name->text, ELLIPSIS) && said && strstr(said->text, ELLIPSIS));
    CHECK(ht_run_bounds(name).x < ht_run_bounds(word(" is done")).x);
    CHECK(ht_run_bounds(word(" is done")).x < ht_run_bounds(said).x);
    max_box_t boxes[2 + MAX_CELLS] = {box_of(find_hit(MAX_HIT_APPS, 0)), box_of(find_hit(MAX_HIT_BELL, 0))};
    for (int i = 0; i < max_m.cell_hits; i++) boxes[2 + i] = max_m.cell_box[i];
    check_words(boxes, 2 + max_m.cell_hits);
    check_glass();
    check_hits();
    check_budget();
    // Its pet plays as the cells' do, the cells' rails and chips loop: the render task wakes for the soonest.
    CHECK(max_motion_ms(T0) <= MAX_LOOP_FRAME_MS && max_motion_ms(T0) <= max_pet_next_ms("muse", POD_SCENE_REST, T0));
    // A short one: its card fits its words.
    max_find("c")->name[0] = 'x';
    max_find("c")->name[1] = 0;
    max_find("c")->note[0] = 0;
    render_at(T0);
    CHECK(box_of(&max_m.hits[0]).w < note.w && word(" is done") && !word(" \xc2\xb7 "));
    ring(NULL);
    max_copy(max_m.done_id, sizeof max_m.done_id, "c");
    max_m.done_from = T0 - 1000;
    // Gone after MAX_DONE_NOTE_MS.
    render_at(T0 - 1000 + MAX_DONE_NOTE_MS);
    CHECK(!find_hit(MAX_HIT_DONE_NOTE, 0) && !word(" is done"));
    // With a toast over an agent that records: the toast first, then the note.
    show(MAX_VIEW_AGENT, "a");
    talk("a", MAX_TALK_RECORDING, true);
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "e");
    max_m.toast_from = T0 - 1000;
    render_at(T0);
    CHECK(max_m.hits[0].kind == MAX_HIT_TOAST && max_m.hits[1].kind == MAX_HIT_DONE_NOTE);
    agent_words();
    check_budget();
    // Not over New Harness, nor the update screen.
    talk("", MAX_TALK_IDLE, false);
    CHECK(max_ui_form_open("form-1", T0));
    render_at(T0);
    CHECK(!find_hit(MAX_HIT_DONE_NOTE, 0) && !word(" is done"));
    max_form_dismiss();
    max_ui_update(40, "0.9.0");
    render_at(T0);
    CHECK(!find_hit(MAX_HIT_DONE_NOTE, 0) && !word(" is done"));
}

static void test_notice(void)
{
    ring(NULL);
    show(MAX_VIEW_OVERVIEW, NULL);
    max_ui_notice("Mic closed \xc2\xb7 tap to talk", 3000, T0 - 300);   // up whole by T0: it fades in over 300 ms
    render_at(T0);
    CHECK(word("Mic closed \xc2\xb7 tap to talk"));
    check_notice();
    check_glass();
    // Too long for the pill: cut with an ellipsis, still centred on the glass.
    max_ui_notice(LONG_TEXT, 3000, T0 - 300);
    render_at(T0);
    const ht_run_t *cut = NULL;
    for (int i = 0; i < S.count; i++)
        if (S.runs[i].pro_kind == K_TEXT && !strncmp(S.runs[i].text, "Editing the touch", 17)) cut = &S.runs[i];
    CHECK(cut && strstr(cut->text, ELLIPSIS) && ht_run_bounds(cut).w < HT_WIDTH);
    check_glass();
    // Run out: it goes over 300 ms, then nothing of it is left.
    char was[ROW_BYTES];
    snprintf(was, sizeof was, "%s", cut->text);
    render_at(T0 + 2700);
    CHECK(word(was));
    render_at(T0 + 3000);
    CHECK(!word(was));
}

static void test_cut_after_an_ellipsis(void)
{
    const char *name = "far-too-long-f" ELLIPSIS, *line = "far-too-long-f" ELLIPSIS " asks";
    char out[ROW_BYTES];
    max_cut(out, line, &ph_sb_22, ht_pro_width(&ph_sb_22, "far-too-long-f" ELLIPSIS ELLIPSIS), false);
    CHECK(!strcmp(out, name));
}

static void test_update_screen(void)
{
    linked(ABCDE, 5);
    max_ui_update(40, "0.9.0");
    render_at(T0);
    CHECK(word("Updating") && word("40%") && word("Version 0.9.0"));
    CHECK(max_m.hit_count == 0 && max_m.cell_hits == 0 && max_motion_ms(T0) == MAX_WAKE_MS);
    check_glass();
    check_budget();
}

// ---- New Harness ----

// Over the whole glass: Close, the choices and their moves, Back and the action, Say while its field takes a spoken
// name, Cancel and Send while one records; a toast and a notice in its head row over none of its buttons.
static void test_new_harness(void)
{
    ring(NULL);
    CHECK(max_ui_form_open("form-1", T0));
    render_at(T0);
    CHECK(word("Opening" ELLIPSIS) && find_hit(MAX_HIT_FORM_CLOSE, 0) && !find_hit(MAX_HIT_FORM_PICK, 0));
    CHECK(!find_hit(MAX_HIT_FORM_SAY, 0) && max_m.cell_hits == 0);
    check_glass();
    check_hits();
    take(T0);
    pro_form_page_t page = {.title = "Project", .label = "harness-max-firmware", .detail = "~/work/harness",
                            .previous = "backend", .next = "website", .error = "", .status = "", .action = "choose",
                            .query = "", .revision = 7, .position = 2, .total = 5, .active = true, .enabled = true,
                            .can_query = true};
    max_ui_form_state(OUT[0].fetch, "form-1", true, &page, T0);
    render_at(T0);
    check_hits();
    check_glass();
    CHECK(find_hit(MAX_HIT_FORM_MOVE, -1) && find_hit(MAX_HIT_FORM_MOVE, 1) && hits_of(MAX_HIT_FORM_PICK) == 2);
    CHECK(word("harness-max-firmware") && word("2 / 5") && word("Choose") && word("backend"));
    CHECK(max_form_can_say() && find_hit(MAX_HIT_FORM_SAY, 0) && word("Say"));
    const max_hit_t *close = find_hit(MAX_HIT_FORM_CLOSE, 0);
    CHECK(close->x + close->w > HT_WIDTH - DX(60));   // the form spans the glass
    // A spoken name: only Cancel and Send while it records, nothing while it goes.
    talk("", MAX_TALK_RECORDING, false);
    render_at(T0);
    CHECK(HITS_ARE(MAX_HIT_TALK_CANCEL, MAX_HIT_TALK_SEND) || HITS_ARE(MAX_HIT_TALK_SEND, MAX_HIT_TALK_CANCEL));
    CHECK(word("Listening") && !word("Say"));
    check_hits();
    talk("", MAX_TALK_SENDING, false);
    render_at(T0);
    CHECK(max_m.hit_count == 0);
    talk("", MAX_TALK_IDLE, false);
    // A question that waits: its toast left of Close, over none of the form's buttons; a notice left of it.
    max_copy(max_m.toast_id, sizeof max_m.toast_id, "e");
    max_m.toast_from = T0 - 1000;
    max_ui_notice("Sent to backend", 3000, T0 - 300);
    render_at(T0);
    const max_hit_t *toast = find_hit(MAX_HIT_TOAST, 0);
    CHECK(toast && toast->x + toast->w < find_hit(MAX_HIT_FORM_CLOSE, 0)->x);
    for (int i = 0; i < max_m.hit_count; i++)
        if (&max_m.hits[i] != toast) CHECK(apart(box_of(toast), box_of(&max_m.hits[i])));
    const ht_rect_t sent = ht_run_bounds(word("Sent to backend"));
    CHECK(sent.x + sent.w < toast->x);
    for (int i = 0; i < max_m.hit_count; i++)
        CHECK(apart((max_box_t){sent.x, sent.y, sent.w, sent.h}, box_of(&max_m.hits[i])));
    check_notice();
    check_glass();
    check_budget();
    max_ui_notice("", 0, 0);
    max_m.toast_id[0] = 0;
    // The desktop working: nothing but Close.
    take(T0);
    max_form_command(MAX_FORM_ACTIVATE, 0, T0);
    take(T0);
    pro_form_page_t busy = page;
    busy.busy = true;
    busy.enabled = false;
    busy.status = "Starting" ELLIPSIS;
    busy.next = "";
    busy.revision = 9;
    max_ui_form_state(OUT[0].fetch, "form-1", true, &busy, T0);
    render_at(T0);
    CHECK(word("Wait") && word("Starting" ELLIPSIS) && hits_of(MAX_HIT_FORM_PICK) == 0);
    // Failed: why, and Retry.
    max_form_due(T0 + MAX_FORM_WAIT_MS + 1000);
    take(T0 + MAX_FORM_WAIT_MS + 1000);
    max_form_due(T0 + 2 * MAX_FORM_WAIT_MS + 2000);
    render_at(T0);
    CHECK(max_m.form.failed && word("No reply. Check Harness on desktop.") && find_hit(MAX_HIT_FORM_RETRY, 0));
    check_hits();
    check_glass();
}

// The Max's pod_draw.c (main/pro_fork/pod/pod_draw.c) draws a triangle right of 1023 px, as far as int16 sixteenths reach
// (the Pro's refuses it): the 1920 px glass's arrows and tails there. An edge too long for tri_raster's 32-bit isqrt,
// or a vertex past int16, is still refused.
static void test_triangle_reach(void)
{
    const uint16_t ink = 0xFFFF;
    static ht_scene_t s;
    ht_scene_clear(&s, 0);
    CHECK(!pod_tri(&s, 0, 0, 160, 160, 320, 320, ink) && s.count == 0);       // degenerate
    CHECK(!pod_tri(&s, 40000, 0, 0, 0, 0, 160, ink) && s.count == 0);         // past int16 sixteenths
    CHECK(!pod_tri(&s, -0x7000, 0, 0x7000, 0, 0, 160, ink) && s.count == 0);  // an edge too long for isqrt
    CHECK(pod_tri(&s, 1500 * 16, 0, 1530 * 16, 0, 1515 * 16, 16 * 16, ink) && s.count == 1);
    static uint16_t px[32 * 16];
    ht_raster(&s, (ht_rect_t){1500, 0, 32, 16}, px);
    CHECK(px[2 * 32 + 15] == ink && px[15 * 32 + 1] == 0);   // inside its middle, and outside a lower corner
}

int main(void)
{
    test_triangle_reach();
    test_budget();
    test_overview();
    test_agent_page();
    test_talking();
    test_attention();
    test_inbox();
    test_apps();
    test_ambient();
    test_cell_pets_play();
    test_app_icons();
    test_toast();
    test_done_note();
    test_notice();
    test_cut_after_an_ellipsis();
    test_update_screen();
    test_new_harness();
    printf("test_max_view: %d checks passed\n", checks);
    return 0;
}
