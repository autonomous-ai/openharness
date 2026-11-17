// New Harness from the bar (max_ui_form.c): the desktop's form opened under a name, read again while it is up, moved,
// chosen in and closed; one command at a time, a reply that never comes, and a spoken name.
#include "max_test.h"

static const char *const ABC[] = {"a", "b", "c"};
static const char FORM[] = "form-0badc0de-000186a0";
static max_out_t OUT[MAX_OUTBOX];
static max_answer_t ANSWER;

static int take(uint32_t now) { return max_ui_take(OUT, MAX_OUTBOX, &ANSWER, now); }
static const max_form_t *form(void) { return &max_m.form; }

static pro_form_page_t page(int32_t revision, int32_t position, const char *label)
{
    return (pro_form_page_t){.title = "New Harness", .label = label, .detail = "Claude Code\nharness", .previous = "Agent",
                             .next = "New Harness", .error = "", .status = "", .action = "open", .query = "",
                             .revision = revision, .position = position, .total = 3, .active = true, .enabled = true,
                             .can_query = true};
}
// The reply to the command last handed out.
static bool reply(bool ok, const pro_form_page_t *p, uint32_t now) { return max_ui_form_state(OUT[0].fetch, FORM, ok, p, now); }

// Opened, and the first page back: "Project", revision 4.
static void opened(uint32_t now)
{
    linked(ABC, 3);
    max_ui_offers(true);
    CHECK(max_ui_form_open(FORM, now) && take(now) == 1);
    const pro_form_page_t p = page(4, 2, "Project");
    CHECK(reply(true, &p, now));
}

static void test_offer(void)
{
    linked(ABC, 3);
    CHECK(!max_m.offers_form && max_ui_offers(true) && max_m.offers_form);
    CHECK(!max_ui_offers(true) && max_ui_offers(false) && !max_m.offers_form);
}

static void test_open(void)
{
    // Not linked, or a name the desktop would refuse: nothing opens.
    max_ui_reset();
    CHECK(!max_ui_form_open(FORM, 0));
    linked(ABC, 3);
    CHECK(!max_ui_form_open("", 0) && !max_ui_form_open("form 1", 0) && !max_ui_form_open(NULL, 0));
    char long_id[MAX_FORM_ID_BYTES + 1];
    memset(long_id, 'f', sizeof long_id - 1);
    long_id[sizeof long_id - 1] = 0;
    CHECK(!max_ui_form_open(long_id, 0));
    long_id[MAX_FORM_ID_BYTES - 1] = 0;   // 48: the longest the desktop takes
    CHECK(max_ui_form_open(long_id, 0));
    linked(ABC, 3);
    // Opened: the open goes out under the next command's name, and nothing else opens meanwhile.
    CHECK(max_ui_form_open(FORM, 100) && max_form_open() && form()->pending);
    CHECK(!max_ui_form_open("form-2", 100));
    CHECK(take(100) == 1 && OUT[0].kind == MAX_OUT_FORM && !strcmp(OUT[0].form, FORM) && !strcmp(OUT[0].fetch, "form-1"));
    CHECK(OUT[0].op == MAX_FORM_OPEN && OUT[0].revision == 0 && OUT[0].delta == 0);
    CHECK(!strcmp(max_form_op_name(OUT[0].op), "open") && !strcmp(max_form_op_name(MAX_FORM_ACTIVATE), "activate"));
    // A reply to another command, or another form, is not this one's.
    const pro_form_page_t p = page(4, 2, "Project");
    CHECK(!max_ui_form_state("form-2", FORM, true, &p, 200) && !max_ui_form_state("form-1", "form-x", true, &p, 200));
    CHECK(!max_ui_form_state("form-01x", FORM, true, &p, 200) && !max_ui_form_state(NULL, FORM, true, &p, 200));
    CHECK(form()->pending);
    // Its page: read again a second later, while it is up.
    CHECK(reply(true, &p, 200) && !form()->pending && !strcmp(form()->page.label, "Project"));
    CHECK(!strcmp(form()->page.detail, "Claude Code\nharness") && form()->page.revision == 4);
    CHECK(max_form_wake(200, MAX_WAKE_MS) == MAX_FORM_POLL_MS);
    CHECK(take(200 + MAX_FORM_POLL_MS - 1) == 0);
    CHECK(take(200 + MAX_FORM_POLL_MS) == 1 && OUT[0].op == MAX_FORM_STATE && OUT[0].revision == 4);
    // A poll that read the same page changes nothing drawn; a new page does.
    CHECK(!reply(true, &p, 1300));
    take(2300);
    const pro_form_page_t q = page(5, 3, "New Harness");
    CHECK(reply(true, &q, 2300) && form()->page.position == 3);
    // While the desktop works, more often.
    take(3300);
    pro_form_page_t busy = q;
    busy.busy = true;
    busy.enabled = false;
    reply(true, &busy, 3300);
    CHECK(max_form_wake(3300, MAX_WAKE_MS) == MAX_FORM_BUSY_MS);
}

static void test_close_and_end(void)
{
    // Started, or backed out of: the form leaves the bar (the new agent arrives as a lane).
    opened(0);
    take(MAX_FORM_POLL_MS);
    const pro_form_page_t done = {.title = "", .label = "", .detail = "", .previous = "", .next = "", .error = "",
                                  .status = "", .action = "", .query = ""};
    CHECK(reply(true, &done, MAX_FORM_POLL_MS) && !max_form_open());
    // Closed from the bar: a close goes out, best effort, and a late reply to the form before is not taken.
    opened(0);
    CHECK(max_form_dismiss() && !max_form_open() && !max_form_dismiss());
    CHECK(take(0) == 1 && OUT[0].op == MAX_FORM_CLOSE && !strcmp(OUT[0].form, FORM) && OUT[0].revision == 4);
    CHECK(!strcmp(OUT[0].fetch, "form-2"));
    const pro_form_page_t p = page(4, 2, "Project");
    CHECK(max_ui_form_open("form-next", 0) && take(0) == 1 && !strcmp(OUT[0].fetch, "form-3"));
    CHECK(!max_ui_form_state("form-2", FORM, true, &p, 0) && !max_ui_form_state("form-1", "form-next", true, &p, 0));
    // The link going drops it, and whatever it had queued.
    opened(0);
    max_form_command(MAX_FORM_BACK, 0, 0);
    max_ui_link(false, NULL, 0);
    CHECK(!max_form_open() && max_m.out_count == 0);
}

static void test_failures(void)
{
    // Refused: the desktop's words, or ours when it gave none.
    linked(ABC, 3);
    max_ui_form_open(FORM, 0);
    take(0);
    pro_form_page_t refused = {.title = "", .label = "", .detail = "", .previous = "", .next = "",
                               .error = "Open New Harness again.", .status = "", .action = "", .query = ""};
    CHECK(reply(false, &refused, 0) && form()->failed && !strcmp(form()->page.error, "Open New Harness again."));
    CHECK(max_form_wake(0, MAX_WAKE_MS) == MAX_WAKE_MS && take(100000) == 0);   // failed: nothing more goes
    CHECK(!max_form_command(MAX_FORM_BACK, 0, 0) && !max_form_can_say());
    linked(ABC, 3);
    max_ui_form_open(FORM, 0);
    take(0);
    refused.error = "";
    CHECK(reply(false, &refused, 0) && !strcmp(form()->page.error, "Could not open New Harness."));
    // No reply at all: the desktop's own words for its timeout.
    linked(ABC, 3);
    max_ui_form_open(FORM, 0);
    take(0);
    CHECK(max_form_wake(0, MAX_WAKE_MS) == MAX_FORM_WAIT_MS);
    CHECK(take(MAX_FORM_WAIT_MS - 1) == 0 && !form()->failed);
    CHECK(take(MAX_FORM_WAIT_MS) == 0 && form()->failed && !strcmp(form()->page.error, "No reply. Check Harness on desktop."));
    CHECK(max_ui_tick(MAX_FORM_WAIT_MS));
    // A command the port had no room for fails the form; a poll is only read again later.
    opened(0);
    max_form_command(MAX_FORM_BACK, 0, 0);
    take(0);
    CHECK(max_ui_unsent(&OUT[0], 0) && form()->failed && !strcmp(form()->page.error, "Cable busy. Try again."));
    opened(0);
    take(MAX_FORM_POLL_MS);
    CHECK(OUT[0].op == MAX_FORM_STATE && !max_ui_unsent(&OUT[0], MAX_FORM_POLL_MS) && !form()->pending && !form()->failed);
    CHECK(take(2 * MAX_FORM_POLL_MS - 1) == 0 && take(2 * MAX_FORM_POLL_MS) == 1);
    // No room in the outbox for the open: failed at once.
    linked(ABC, 3);
    for (int i = 0; i < MAX_OUTBOX; i++) max_out_push(MAX_OUT_READ);
    CHECK(max_ui_form_open(FORM, 0) && form()->failed && !strcmp(form()->page.error, "Cable busy. Try again."));
}

static void test_commands(void)
{
    opened(0);
    // Moves while a command is out are added up and sent as one, within the desktop's ±8.
    CHECK(max_form_command(MAX_FORM_MOVE, 1, 0) && take(0) == 1 && OUT[0].op == MAX_FORM_MOVE && OUT[0].delta == 1);
    for (int i = 0; i < 10; i++) CHECK(max_form_command(MAX_FORM_MOVE, 1, 0));
    CHECK(take(0) == 0 && form()->queued == MAX_FORM_MOVES);
    const pro_form_page_t p = page(5, 3, "New Harness");
    reply(true, &p, 10);
    CHECK(take(10) == 1 && OUT[0].op == MAX_FORM_MOVE && OUT[0].delta == MAX_FORM_MOVES && OUT[0].revision == 5);
    max_form_command(MAX_FORM_MOVE, -1, 10);
    max_form_command(MAX_FORM_MOVE, -1, 10);
    max_form_command(MAX_FORM_MOVE, 1, 10);
    reply(true, &p, 20);
    CHECK(take(20) == 1 && OUT[0].delta == -1);
    // Anything else waits for the reply before it; a choice a busy or disabled page cannot take is refused.
    CHECK(!max_form_command(MAX_FORM_ACTIVATE, 0, 30) && !max_form_command(MAX_FORM_MOVE, 0, 30));
    reply(true, &p, 30);
    CHECK(max_form_command(MAX_FORM_ACTIVATE, 0, 40) && take(40) == 1 && OUT[0].op == MAX_FORM_ACTIVATE);
    pro_form_page_t busy = p;
    busy.busy = true;
    busy.enabled = false;
    busy.status = "Starting\xe2\x80\xa6";
    reply(true, &busy, 50);
    CHECK(!max_form_command(MAX_FORM_ACTIVATE, 0, 60) && !max_form_command(MAX_FORM_MOVE, 1, 60));
    CHECK(max_form_command(MAX_FORM_BACK, 0, 60) && take(60) == 1 && OUT[0].op == MAX_FORM_BACK);
    pro_form_page_t off = p;
    off.enabled = false;
    reply(true, &off, 70);
    CHECK(!max_form_command(MAX_FORM_ACTIVATE, 0, 70));
    // A move that arrived while the page was busy is not kept for later.
    CHECK(form()->queued == 0);
}

static void test_polls_wait_for_a_spoken_name(void)
{
    opened(0);
    // The desktop takes one command at a time: no poll while a name is being said and sent.
    max_ui_talk(MAX_TALK_RECORDING);
    CHECK(take(5 * MAX_FORM_POLL_MS) == 0);
    max_ui_talk(MAX_TALK_IDLE);
    CHECK(take(5 * MAX_FORM_POLL_MS) == 1 && OUT[0].op == MAX_FORM_STATE);
}

static void test_spoken_name(void)
{
    opened(0);
    CHECK(max_form_can_say());
    // What the name did: the page it moved to.
    const pro_form_page_t found = page(6, 2, "harness-max-firmware");
    CHECK(!max_ui_voice_form("form-x", true, &found, 10) && !max_ui_voice_form(FORM, true, NULL, 10));
    CHECK(max_ui_voice_form(FORM, true, &found, 10) && !strcmp(form()->page.label, "harness-max-firmware"));
    CHECK(form()->page.revision == 6 && max_form_wake(10, MAX_WAKE_MS) == MAX_FORM_POLL_MS);
    // Not understood: the desktop's words, or ours, stay up a while before a poll.
    pro_form_page_t missed = {.title = "", .label = "", .detail = "", .previous = "", .next = "", .error = "",
                              .status = "", .action = "", .query = ""};
    CHECK(max_ui_voice_form(FORM, false, &missed, 20) && !strcmp(form()->page.error, "Say the name again."));
    CHECK(!strcmp(form()->page.label, "harness-max-firmware") && max_form_wake(20, MAX_WAKE_MS) == 6000);
    missed.error = "Choices changed. Try again.";
    CHECK(max_ui_voice_form(FORM, false, &missed, 30) && !strcmp(form()->page.error, "Choices changed. Try again."));
    // The name started it, or the form is gone: it leaves the bar.
    CHECK(max_ui_voice_form(FORM, true, &missed, 40) && !max_form_open());
    // Only a current page that can be searched takes a name.
    opened(0);
    max_form_command(MAX_FORM_BACK, 0, 0);
    CHECK(!max_form_can_say());
    pro_form_page_t start = page(7, 3, "New Harness");
    start.can_query = false;
    reply(true, &start, 0);
    CHECK(!max_form_can_say());
}

static void test_words_come_clean(void)
{
    opened(0);
    take(MAX_FORM_POLL_MS);
    pro_form_page_t p = page(5, 2, "Pro\x01ject\n");
    p.detail = "agent\nproject\tname";
    reply(true, &p, MAX_FORM_POLL_MS);
    CHECK(!strcmp(form()->page.label, "Pro ject ") && !strcmp(form()->page.detail, "agent\nproject name"));
}

int main(void)
{
    test_offer();
    test_open();
    test_close_and_end();
    test_failures();
    test_commands();
    test_polls_wait_for_a_spoken_name();
    test_spoken_name();
    test_words_come_clean();
    printf("test_max_form: %d checks passed\n", checks);
    return 0;
}
