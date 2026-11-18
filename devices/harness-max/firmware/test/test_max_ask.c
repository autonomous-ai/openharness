// Answering from the bar (max_ui_ask.c): how a question is answered (its path), the reviewed path's read and receipt,
// the plain answer's words, the outbox, and what ends a question.
#include "max_test.h"

static const char *const ABC[] = {"a", "b", "c"};
static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;

static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }
static max_ask_t *ask(const char *id) { return max_ask_of(id); }
static bool hit(const char *id, max_hit_kind_t kind, int arg, uint32_t now) { return max_ask_hit(max_find(id), kind, arg, now); }

static const pro_ask_item_t DB = {"db", "Which database?", {"Dev", "Staging"}, 2, false, true};
static const pro_ask_item_t DEPLOY = {"perm", "Approve Bash command: npm run deploy:staging", {"Yes", "No"}, 2, false,
                                      true};
static const pro_ask_item_t TWO[] = {{"db", "Which database?", {"Dev", "Staging"}, 2, false, true},
                                     {"checks", "Which checks?", {"Lint", "Types", "Tests"}, 3, true, true}};

// The reviewed path up to its card: asked, read, and the state back with token "tok".
static void reviewed(const char *id, const pro_ask_item_t *items, int n, uint32_t now)
{
    CHECK(max_ui_question(id, "toolu_1", items[0].q, items, n, false, true, now));
    CHECK(take(now) == 1 && OUT[0].kind == MAX_OUT_READ);
    CHECK(max_ui_question_state(id, OUT[0].fetch, true, "toolu_1", "tok", false, NULL, items, n, now));
    CHECK(ask(id)->phase == MAX_ASK_READY);
}

static void test_permission_words(void)
{
    // questionPane.ts APPROVE_RE on the first option, REJECT_RE on any: whole words, any case.
    static const char *const yes[] = {"Yes", "yes, and don't ask again", "Allow", "APPROVE", "Accept", "Proceed",
                                      "Run it", "Continue"};
    static const char *const no_yes[] = {"Yesterday", "Running", "", "Sure"};
    for (unsigned i = 0; i < sizeof yes / sizeof yes[0]; i++) CHECK(max_option_approves(yes[i]));
    for (unsigned i = 0; i < sizeof no_yes / sizeof no_yes[0]; i++) CHECK(!max_option_approves(no_yes[i]));
    static const char *const no[] = {"No", "No, and tell Claude what to do differently", "Reject", "deny", "Decline",
                                     "Cancel", "Skip", "Don't", "dont", "Stop", "Tell Claude what to change"};
    static const char *const no_no[] = {"Nothing", "Notes", "Tell me more", "Stopwatch", "Yes"};
    for (unsigned i = 0; i < sizeof no / sizeof no[0]; i++) CHECK(max_option_rejects(no[i]));
    for (unsigned i = 0; i < sizeof no_no / sizeof no_no[0]; i++) CHECK(!max_option_rejects(no_no[i]));
    CHECK(!max_option_approves(NULL) && !max_option_rejects(NULL));
}

static void test_paths(void)
{
    linked(ABC, 3);
    // The daemon offers question.review: read the question whole first.
    CHECK(max_ui_question("a", "toolu_1", "Which database?", &DB, 1, false, true, 0));
    CHECK(ask("a")->path == MAX_PATH_REVIEWED && ask("a")->phase == MAX_ASK_READING && max_find("a")->state == MAX_ASKING);
    // Without it: a plain answer, when every key and option came whole.
    CHECK(max_ui_question("b", "toolu_2", "Which database?", &DB, 1, false, false, 0));
    CHECK(ask("b")->path == MAX_PATH_PLAIN && ask("b")->phase == MAX_ASK_READY);
    pro_ask_item_t cut = DB;
    cut.whole = false;
    CHECK(max_ui_question("b", "toolu_3", "Which database?", &cut, 1, false, false, 0));
    CHECK(ask("b")->path == MAX_PATH_NONE);
    pro_ask_item_t keyless = DB;
    keyless.key = NULL;   // too long to echo
    CHECK(max_ui_question("b", "toolu_4", "Which database?", &keyless, 1, false, false, 0));
    CHECK(ask("b")->path == MAX_PATH_NONE);
    // No questions the inbox would hold, or no request: only the computer answers.
    CHECK(max_ui_question("c", "toolu_5", "Proceed?", NULL, 0, false, true, 0));
    CHECK(ask("c")->path == MAX_PATH_NONE && ask("c")->count == 0);
    CHECK(max_ui_question("c", NULL, "Proceed?", &DB, 1, false, true, 0));
    CHECK(ask("c")->path == MAX_PATH_NONE);
    // Shown only: answered in the agent's own app, named by its one option.
    static const pro_ask_item_t shown = {"shown", "Allow Edit of src/auth/session.ts?", {"In Orca"}, 1, false, true};
    CHECK(max_ui_question("c", "shown:toolu_6", shown.q, &shown, 1, true, true, 0));
    CHECK(ask("c")->path == MAX_PATH_SHOWN && !strcmp(ask("c")->app, "Orca") && ask("c")->permission);
    CHECK(max_m.out_count == 0 && take(0) == 1 && !strcmp(OUT[0].agent, "a"));   // the clock reads: a's only
    // The permission mark is the daemon's; with no questions there is nothing to approve.
    CHECK(max_ui_question("b", "toolu_7", DEPLOY.q, &DEPLOY, 1, true, false, 0) && ask("b")->permission);
    CHECK(max_ui_question("b", "toolu_8", DEPLOY.q, NULL, 0, true, false, 0) && !ask("b")->permission);
    CHECK(max_ui_question("b", "toolu_9", DEPLOY.q, &DEPLOY, 1, false, false, 0) && !ask("b")->permission);
    // The same question again is no change; an agent not on the roster is nobody's.
    CHECK(!max_ui_question("b", "toolu_9", DEPLOY.q, &DEPLOY, 1, false, false, 10));
    CHECK(!max_ui_question("zz", "toolu_1", DEPLOY.q, &DEPLOY, 1, false, false, 10));
}

static void test_reads(void)
{
    linked(ABC, 3);
    CHECK(max_ui_question("a", "toolu_1", "Which database?", &DB, 1, false, true, 1000));
    CHECK(max_ask_wake(1000, MAX_WAKE_MS) == 1);   // the read is due now
    CHECK(take(1000) == 1 && OUT[0].kind == MAX_OUT_READ && !strcmp(OUT[0].agent, "a") && !strcmp(OUT[0].fetch, "q1"));
    CHECK(take(1000 + MAX_READ_MS - 1) == 0);
    CHECK(max_ask_wake(1000, MAX_WAKE_MS) == MAX_READ_MS);
    // No reply: read again, three times in all, then the card says so.
    CHECK(take(1000 + MAX_READ_MS) == 1 && !strcmp(OUT[0].fetch, "q1"));
    CHECK(take(1000 + 2 * MAX_READ_MS) == 1);
    CHECK(take(1000 + 3 * MAX_READ_MS) == 0);
    CHECK(ask("a")->phase == MAX_ASK_FAILED && !strcmp(ask("a")->note, "No reply. Check Harness on your computer."));
    CHECK(max_ui_tick(1000 + 3 * MAX_READ_MS));
    // A late state for that read is not taken; Reload reads again under a new name.
    CHECK(!max_ui_question_state("a", "q1", true, "toolu_1", "tok", false, NULL, &DB, 1, 9000));
    CHECK(hit("a", MAX_HIT_RELOAD, 0, 9000) && ask("a")->phase == MAX_ASK_READING);
    CHECK(take(9000) == 1 && !strcmp(OUT[0].fetch, "q2"));
    // A state for another read, or another agent, is not this card's.
    CHECK(!max_ui_question_state("a", "q1", true, "toolu_1", "tok", false, NULL, &DB, 1, 9000));
    CHECK(!max_ui_question_state("b", "q2", true, "toolu_1", "tok", false, NULL, &DB, 1, 9000));
    // The daemon's own copy replaces the one the question carried.
    CHECK(max_ui_question_state("a", "q2", true, "toolu_1", "tok", false, NULL, TWO, 2, 9000));
    CHECK(ask("a")->phase == MAX_ASK_READY && ask("a")->count == 2 && !strcmp(ask("a")->token, "tok"));
    CHECK(!strcmp(ask("a")->items[1].options[2], "Tests"));
    // The daemon's refusal is the card's words; a state with nothing to answer, ours.
    max_ui_question("b", "toolu_2", "Which database?", &DB, 1, false, true, 0);
    take(0);
    CHECK(max_ui_question_state("b", ask("b")->fetch, false, NULL, NULL, false, "Question changed.", NULL, 0, 0));
    CHECK(ask("b")->phase == MAX_ASK_FAILED && !strcmp(ask("b")->note, "Question changed."));
    hit("b", MAX_HIT_RELOAD, 0, 0);
    take(0);
    CHECK(max_ui_question_state("b", ask("b")->fetch, true, "toolu_2", "tok", false, NULL, NULL, 0, 0));
    CHECK(ask("b")->phase == MAX_ASK_FAILED && !strcmp(ask("b")->note, "Could not load the question."));
    // Answered already: shown as sent, never sent again.
    hit("b", MAX_HIT_RELOAD, 0, 0);
    take(0);
    CHECK(max_ui_question_state("b", ask("b")->fetch, true, "toolu_2", "tok", true, NULL, &DB, 1, 0));
    CHECK(ask("b")->phase == MAX_ASK_SENT && !strcmp(ask("b")->note, "An answer was already sent. Check the terminal."));
    CHECK(!hit("b", MAX_HIT_OPTION, 0, 0) && !hit("b", MAX_HIT_RELOAD, 0, 0));
}

static void test_reviewed_answer(void)
{
    linked(ABC, 3);
    max_ui_turn("a", "started", "", 0, 0);
    reviewed("a", &DB, 1, 0);
    // One tap on a single choice is the answer: the option's bit, under the read's token and name.
    CHECK(!hit("a", MAX_HIT_OPTION, 2, 10) && !hit("a", MAX_HIT_OPTION, -1, 10));
    CHECK(hit("a", MAX_HIT_OPTION, 1, 10) && ask("a")->phase == MAX_ASK_SENDING);
    CHECK(!hit("a", MAX_HIT_OPTION, 0, 10));   // one answer at a time
    CHECK(take(10) == 1 && OUT[0].kind == MAX_OUT_REVIEWED && !strcmp(OUT[0].agent, "a") && !strcmp(OUT[0].token, "tok"));
    CHECK(!strcmp(OUT[0].fetch, ask("a")->fetch) && OUT[0].count == 1 && OUT[0].choices[0] == 2);
    // A receipt for another token or read is not this answer's.
    CHECK(!max_ui_answer_receipt("a", OUT[0].fetch, "other", true, false, NULL, 20));
    CHECK(!max_ui_answer_receipt("a", "q99", "tok", true, false, NULL, 20));
    // Taken: "Sent", and the turn goes on.
    CHECK(max_ui_answer_receipt("a", OUT[0].fetch, "tok", true, false, NULL, 20));
    CHECK(!strcmp(max_m.notice, "Sent") && max_find("a")->state == MAX_WORKING && !ask("a"));
    // Taken but the terminal not done with it: the card says sent until the question closes.
    reviewed("b", &DB, 1, 0);
    hit("b", MAX_HIT_OPTION, 0, 0);
    take(0);
    CHECK(max_ui_answer_receipt("b", ask("b")->fetch, "tok", true, true, NULL, 0) && ask("b")->phase == MAX_ASK_SENT);
    CHECK(max_ui_question_close("b") && !ask("b") && max_find("b")->state == MAX_WORKING);
    // Refused: the daemon's words on the card and as the notice; Reload reads it again.
    reviewed("c", &DEPLOY, 1, 0);
    hit("c", MAX_HIT_OPTION, 0, 0);
    take(0);
    CHECK(max_ui_answer_receipt("c", ask("c")->fetch, "tok", false, false,
                                "Permission prompts cannot be answered from here.", 0));
    CHECK(ask("c")->phase == MAX_ASK_FAILED && !strcmp(ask("c")->note, "Permission prompts cannot be answered from here."));
    CHECK(!strcmp(max_m.notice, ask("c")->note));
    CHECK(hit("c", MAX_HIT_RELOAD, 0, 0) && ask("c")->phase == MAX_ASK_READING);
    // No receipt: the card says so, and nothing is sent again (the daemon takes one answer a token).
    take(0);
    max_ui_question_state("c", ask("c")->fetch, true, "toolu_1", "tok2", false, NULL, &DEPLOY, 1, 0);
    hit("c", MAX_HIT_OPTION, 1, 1000);
    CHECK(take(1000) == 1 && OUT[0].choices[0] == 2 && !strcmp(OUT[0].token, "tok2"));
    CHECK(max_ask_wake(1000, MAX_WAKE_MS) == MAX_RECEIPT_MS);
    CHECK(take(1000 + MAX_RECEIPT_MS - 1) == 0 && ask("c")->phase == MAX_ASK_SENDING);
    CHECK(take(1000 + MAX_RECEIPT_MS) == 0 && ask("c")->phase == MAX_ASK_FAILED);
    CHECK(!strcmp(ask("c")->note, "No reply. Check the terminal."));
}

static void test_steps_and_several_choices(void)
{
    linked(ABC, 3);
    reviewed("a", TWO, 2, 0);
    // The first question's tap moves on to the second; Back returns to it with its choice kept.
    CHECK(hit("a", MAX_HIT_OPTION, 1, 0) && ask("a")->step == 1 && ask("a")->phase == MAX_ASK_READY);
    CHECK(hit("a", MAX_HIT_STEP_BACK, 0, 0) && ask("a")->step == 0 && ask("a")->choices[0] == 2);
    CHECK(!hit("a", MAX_HIT_STEP_BACK, 0, 0));
    CHECK(hit("a", MAX_HIT_OPTION, 0, 0) && ask("a")->step == 1 && ask("a")->choices[0] == 1);
    // Several choices: each tap toggles; Send needs one.
    CHECK(!hit("a", MAX_HIT_SEND, 0, 0));
    CHECK(hit("a", MAX_HIT_OPTION, 0, 0) && hit("a", MAX_HIT_OPTION, 2, 0) && hit("a", MAX_HIT_OPTION, 0, 0));
    CHECK(ask("a")->choices[1] == 4 && ask("a")->phase == MAX_ASK_READY);
    CHECK(hit("a", MAX_HIT_OPTION, 1, 0) && ask("a")->choices[1] == 6);
    CHECK(hit("a", MAX_HIT_SEND, 0, 0) && ask("a")->phase == MAX_ASK_SENDING);
    CHECK(take(0) == 1 && OUT[0].count == 2 && OUT[0].choices[0] == 1 && OUT[0].choices[1] == 6);
    // The card's key follows the step and the phase: a tap on a card drawn before either changed is stale.
    reviewed("b", TWO, 2, 0);
    const uint32_t first = max_card_key(max_find("b"));
    hit("b", MAX_HIT_OPTION, 0, 0);
    CHECK(max_card_key(max_find("b")) != first);
}

static void test_plain_answer(void)
{
    linked(ABC, 3);
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(max_ui_question("a", "toolu_1", "Which database?", TWO, 2, false, false, 0));
    hit("a", MAX_HIT_OPTION, 1, 0);
    hit("a", MAX_HIT_OPTION, 0, 0);
    hit("a", MAX_HIT_OPTION, 2, 0);
    CHECK(hit("a", MAX_HIT_SEND, 0, 0) && ask("a")->phase == MAX_ASK_SENDING);
    // Handed out with its words: each key and the chosen options, a multi-select's joined as the daemon joins them.
    CHECK(take(5) == 1 && OUT[0].kind == MAX_OUT_ANSWER && !strcmp(OUT[0].agent, "a") && !strcmp(OUT[0].request, "toolu_1"));
    CHECK(ANSWER.count == 2 && !strcmp(ANSWER.keys[0], "db") && !strcmp(ANSWER.values[0], "Staging"));
    CHECK(!strcmp(ANSWER.keys[1], "checks") && !strcmp(ANSWER.values[1], "Lint, Tests"));
    // No receipt comes for it: sent once handed out.
    CHECK(ask("a")->phase == MAX_ASK_SENT && !strcmp(max_m.notice, "Sent"));
    // The port had no room: the same choices can go again, and the question is back on Attention for them.
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    CHECK(max_ui_unsent(&OUT[0], 6) && ask("a")->phase == MAX_ASK_READY && !strcmp(max_m.notice, "Not sent"));
    CHECK(ask("a")->choices[0] == 2 && ask("a")->choices[1] == 5);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "a") && max_m.attn_from == 6);
    CHECK(hit("a", MAX_HIT_SEND, 0, 7) && take(7) == 1);
    // The question went before its answer was handed out: nothing goes.
    max_ui_question("b", "toolu_2", "Which database?", &DB, 1, false, false, 0);
    hit("b", MAX_HIT_OPTION, 0, 0);
    max_ui_question_close("b");
    CHECK(take(0) == 0 && max_m.out_count == 0);
    // Two answers queued: one a take, the other the next.
    max_ui_question("b", "toolu_3", "Which database?", &DB, 1, false, false, 0);
    max_ui_question("c", "toolu_4", "Which database?", &DB, 1, false, false, 0);
    hit("b", MAX_HIT_OPTION, 0, 0);
    hit("c", MAX_HIT_OPTION, 1, 0);
    CHECK(take(0) == 1 && !strcmp(OUT[0].agent, "b") && !strcmp(ANSWER.values[0], "Dev"));
    CHECK(take(0) == 1 && !strcmp(OUT[0].agent, "c") && !strcmp(ANSWER.values[0], "Staging"));
    // A reviewed answer that did not go out is back to be sent. Another question on Attention keeps it: this one waits.
    reviewed("a", &DB, 1, 0);
    hit("a", MAX_HIT_OPTION, 0, 0);
    take(0);
    max_ui_question("c", "toolu_6", "Which database?", &DB, 1, false, false, 0);
    CHECK(!strcmp(max_m.attn_id, "c"));
    CHECK(max_ui_unsent(&OUT[0], 0) && ask("a")->phase == MAX_ASK_READY && !strcmp(max_m.attn_id, "c"));
    // A read that did not go out is read again by the clock.
    max_ui_question("b", "toolu_5", "Which database?", &DB, 1, false, true, 0);
    take(0);
    CHECK(!max_ui_unsent(&OUT[0], 0) && ask("b")->phase == MAX_ASK_READING);
}

static void test_only_ready_cards_answer(void)
{
    linked(ABC, 3);
    // On the computer only, in the agent's app: no option answers.
    max_ui_question("a", "toolu_1", "Proceed?", NULL, 0, false, true, 0);
    CHECK(!hit("a", MAX_HIT_OPTION, 0, 0) && !hit("a", MAX_HIT_SEND, 0, 0));
    static const pro_ask_item_t shown = {"shown", "Allow?", {"In Orca"}, 1, false, true};
    max_ui_question("b", "shown:toolu_2", "Allow?", &shown, 1, true, true, 0);
    CHECK(!hit("b", MAX_HIT_OPTION, 0, 0) && max_m.out_count == 0);
    // Reading: not yet.
    max_ui_question("c", "toolu_3", "Which?", &DB, 1, false, true, 0);
    CHECK(!hit("c", MAX_HIT_OPTION, 0, 0));
    // Nobody asking: nothing.
    max_ui_question_close("c");
    CHECK(!hit("c", MAX_HIT_OPTION, 0, 0) && !hit("c", MAX_HIT_RELOAD, 0, 0));
}

static void test_outbox_full(void)
{
    linked(ABC, 3);
    for (int i = 0; i < MAX_OUTBOX; i++) CHECK(max_out_push(MAX_OUT_READ) != NULL);
    CHECK(max_out_push(MAX_OUT_READ) == NULL);
    max_ui_question("a", "toolu_1", "Which?", &DB, 1, false, false, 0);
    // No room for the answer: the card stays, and says it did not go.
    CHECK(hit("a", MAX_HIT_OPTION, 0, 0) && ask("a")->phase == MAX_ASK_READY && !strcmp(max_m.notice, "Not sent"));
    // A take hands out at most what the caller holds; the rest waits.
    CHECK(max_ui_take(OUT, 3, &ANSWER, 0) == 3 && max_m.out_count == MAX_OUTBOX - 3);
}

static void test_what_ends_a_question(void)
{
    linked(ABC, 3);
    // A turn that starts or ends drops it.
    max_ui_question("a", "toolu_1", "Which?", &DB, 1, false, true, 0);
    max_ui_turn("a", "done", "", 0, 0);
    CHECK(!ask("a"));
    max_ui_question("a", "toolu_2", "Which?", &DB, 1, false, true, 0);
    max_ui_turn("a", "started", "", 0, 0);
    CHECK(!ask("a") && max_find("a")->state == MAX_WORKING);
    // A failure drops it and opens the failure's card.
    max_ui_question("a", "toolu_3", "Which?", &DB, 1, false, true, 0);
    max_ui_turn("a", "error", "boom", 0, 0);
    CHECK(!ask("a") && max_has_card(max_find("a"), 0));
    // Leaving the roster drops it; so does the link, with the outbox.
    max_ui_question("b", "toolu_4", "Which?", &DB, 1, false, true, 0);
    roster(ABC + 2, 1);
    CHECK(!ask("b"));
    linked(ABC, 3);
    max_ui_question("b", "toolu_5", "Which?", &DB, 1, false, true, 0);
    CHECK(max_m.out_count == 0 && take(0) == 1);
    max_ui_question("c", "toolu_6", "Which?", &DB, 1, false, false, 0);
    hit("c", MAX_HIT_OPTION, 0, 0);
    CHECK(max_m.out_count == 1);
    max_ui_link(false, NULL, 0);
    CHECK(!ask("b") && !ask("c") && max_m.out_count == 0);
    // Unlinked, the clock owes nothing.
    CHECK(take(100000) == 0);
}

// An agent in another app waits on its app's prompt: the daemon shows its question only (a `shown:` id) and tells the
// wait as the line of a turn that starts (devices.ts showWaits, then `processing`). That start is the same wait, so the
// question and its Attention stay; the daemon's close ends them.
static void test_a_shown_wait_survives_its_line(void)
{
    linked(ABC, 3);
    static const pro_ask_item_t SHOWN = {"prompt", "npm test \xc2\xb7 answer in Orca", {"In Orca"}, 1, false, true};
    CHECK(max_ui_question("b", "shown:w1", SHOWN.q, &SHOWN, 1, false, true, 0));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
    max_ui_turn("b", "started", "npm test \xc2\xb7 answer in Orca", 0, 10);
    CHECK(ask("b") && ask("b")->path == MAX_PATH_SHOWN && max_find("b")->state == MAX_ASKING);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "b"));
    // A Harness question is still dropped by a turn that starts: its answer moved the agent on.
    max_ui_question("a", "toolu_9", "Which?", &DB, 1, false, true, 20);
    max_ui_turn("a", "started", "", 0, 30);
    CHECK(!ask("a") && max_find("a")->state == MAX_WORKING);
    max_ui_question_close("b");
    CHECK(!ask("b") && max_find("b")->state != MAX_ASKING);
}

// An answer from Attention on its way: Attention moves on to the question waiting longest; with none waiting,
// Overview. A step on is no answer; an answer that found no room in the outbox did not go, and the page stays.
static void test_answered_attention_moves_on(void)
{
    linked(ABC, 3);
    CHECK(max_ui_question("a", "toolu_1", DB.q, &DB, 1, false, false, 1000));
    reviewed("c", TWO, 2, 2000);
    CHECK(max_ui_question("b", "toolu_3", DEPLOY.q, &DEPLOY, 1, true, false, 3000));
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "a"));
    // One tap on a single choice: the answer goes, and c's question has waited longest.
    CHECK(hit("a", MAX_HIT_OPTION, 0, 4000) && ask("a")->phase == MAX_ASK_SENDING);
    CHECK(max_m.view == MAX_VIEW_ATTENTION && !strcmp(max_m.attn_id, "c") && max_m.attn_from == 4000);
    // A step on is not the answer; Send on several choices is.
    CHECK(hit("c", MAX_HIT_OPTION, 1, 4100) && !strcmp(max_m.attn_id, "c"));
    CHECK(hit("c", MAX_HIT_OPTION, 2, 4200) && !strcmp(max_m.attn_id, "c"));
    CHECK(hit("c", MAX_HIT_SEND, 0, 4300) && !strcmp(max_m.attn_id, "b"));
    // Yes on the permission prompt, and nothing else waits (a's and c's answers are on their way): Overview.
    CHECK(hit("b", MAX_HIT_OPTION, 0, 4400) && ask("b")->phase == MAX_ASK_SENDING);
    CHECK(max_m.view == MAX_VIEW_OVERVIEW);
    // An answer for an agent Attention does not show leaves the page where it is.
    take(4500);
    CHECK(max_ui_answer_receipt("c", ask("c")->fetch, "tok", true, false, NULL, 4500));
    CHECK(max_ui_question("a", "toolu_4", DB.q, &DB, 1, false, false, 5000) && !strcmp(max_m.attn_id, "a"));
    CHECK(max_ui_question("c", "toolu_5", DB.q, &DB, 1, false, false, 6000) && !strcmp(max_m.attn_id, "a"));
    CHECK(hit("c", MAX_HIT_OPTION, 0, 7000) && !strcmp(max_m.attn_id, "a") && max_m.attn_from == 5000);
    // An answer that found no room in the outbox did not go: Attention stays with its question.
    while (max_out_push(MAX_OUT_READ)) {}
    CHECK(hit("a", MAX_HIT_OPTION, 1, 8000) && ask("a")->phase == MAX_ASK_READY && !strcmp(max_m.attn_id, "a"));
    CHECK(max_m.view == MAX_VIEW_ATTENTION);
}

// What a card holds: a failure's until the agent moves on, an alert's while its words show, a question's in place of
// either. Attention shows it; nothing on the card closes it.
static void test_cards(void)
{
    linked(ABC, 3);
    max_ui_turn("a", "started", "", 0, 0);
    max_ui_turn("a", "error", "boom", 0, 0);
    CHECK(max_has_card(max_find("a"), 1000000));
    max_ui_summary("b", "Fixed it", NULL, false, POD_TIER_ALERT, 0);
    CHECK(max_has_card(max_find("b"), MAX_DONE_MS - 1) && !max_has_card(max_find("b"), MAX_DONE_MS));
    // A quieter summary shows on the agent's page only.
    max_ui_summary("c", "Fixed it", NULL, false, POD_TIER_LIST, 0);
    CHECK(!max_has_card(max_find("c"), 0) && max_note_shown(max_find("c"), 0));
    // A question's card replaces a failure's.
    max_ui_turn("a", "error", "boom", 0, 20);
    max_ui_question("a", "toolu_1", "Which?", &DB, 1, false, false, 30);
    CHECK(max_has_card(max_find("a"), 30) && !max_find("a")->card);
}

int main(void)
{
    test_permission_words();
    test_paths();
    test_reads();
    test_reviewed_answer();
    test_steps_and_several_choices();
    test_plain_answer();
    test_only_ready_cards_answer();
    test_outbox_full();
    test_what_ends_a_question();
    test_a_shown_wait_survives_its_line();
    test_answered_attention_moves_on();
    test_cards();
    printf("test_max_ask: %d checks passed\n", checks);
    return 0;
}
