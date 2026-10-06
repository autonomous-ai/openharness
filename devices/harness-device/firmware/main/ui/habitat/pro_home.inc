/* The dock-only companion. Its entire middle is always the same control
 * surface; summaries and delivered letters never change what a tap means. */
static void pro_home_header(ht_scene_t *f)
{
    const uint16_t ink = color(0x627466);
    pro_control(f, 548, 24, 128, 64, PRO_TR("Menu"), A_LAUNCHER, 0, true);
    const char *tab = PRO_TR("Workspace");
    for (int i = 0; i < s.tab_count; i++)
        if (!strcmp(s.tabs[i].id, s.selected_tab)) { tab = s.tabs[i].name; break; }
    ht_pro_text(f, 44, 36, 224, &ht_pro_24, ink,
        !s.connected ? PRO_TR("Connect to Harness") :
        s.loading ? PRO_TR("Finding your workspace...") : tab);
    pro_hit(32, 24, 248, 80, A_TABS, 0, s.connected && !s.loading);
    char updates[40];
    int questions = waiting();
    if (s.q.pending) COPY(updates, PRO_TR("Review answer"));
    else if (questions) snprintf(updates, sizeof updates,
        questions == 1 ? PRO_TR("%d needs you") : PRO_TR("%d need you"), questions);
    else COPY(updates, PRO_TR("Updates"));
    // Reading a question never clears its need for an answer. Keep this target
    // in one place, away from the central voice surface, including an empty inbox.
    pro_control(f, 296, 24, 236, 64, updates, A_INBOX, 1, true);
}
static void pro_home_footer(ht_scene_t *f, agent_t *a, bool recap)
{
    const uint16_t ink = color(0x263b34);
    const uint16_t dim = color(0x627466);
    ht_pro_rect(f, 0, 596, 720, 124, 0, color(0xfbf9ef));
    const char *name = a ? a->name : PRO_TR("Choose a pane");
    const ht_pro_font_t *font = ht_pro_width(&ht_pro_42, name) <= 468 ? &ht_pro_42 : &ht_pro_32;
    ht_pro_text(f, 44, 604, 468, font, ink, name);
    const char *feedback = pro_send_feedback_text(ms());
    const char *blocked = pro_work_block_reason(a, PRO_WORK_TASK);
    const char *status = !s.connected ? PRO_TR("Connect to your computer") :
        s.loading ? PRO_TR("One moment...") : s.voice_retry_until ? PRO_TR("Voice was not sent. Try again.") :
        blocked ? PRO_TR(blocked) :
        s.nap ? PRO_TR("Taking a little rest") : a && is_question(a->id) ? PRO_TR("Needs your answer") :
        s.speech_error_until ? PRO_TR("Voice unavailable. Text is still here.") :
        pro_speech_visible() ? (s.speech.playing ? PRO_TR("Speaking. Touch to interrupt.") : PRO_TR("One moment...")) :
        feedback ? feedback :
        a && a->busy ? (a->tool[0] ? a->tool : PRO_TR("Working")) :
        recap ? PRO_TR("A result is ready") : PRO_TR("Tap to speak");
    char carrying[128];
    snprintf(carrying, sizeof carrying, PRO_TR("%d line%s from %s"), carry.rows, carry.rows == 1 ? "" : PRO_TR("s"), carry.source);
    if (carry.active && !blocked) status = carrying;
    else if (carry.error[0]) status = PRO_TR("Selected text expired");
    uint32_t seconds;
    int status_width = 478;
    if (!blocked && pro_busy_elapsed(a, ms(), &seconds)) {
        char elapsed[24];
        if (seconds < 60) snprintf(elapsed, sizeof elapsed, "%lus", (unsigned long)seconds);
        else snprintf(elapsed, sizeof elapsed, "%lum %02lus",
                      (unsigned long)(seconds / 60), (unsigned long)(seconds % 60));
        int width = ht_pro_width(&ht_pro_24, elapsed);
        status_width -= width + 16;
        ht_pro_text(f, 522 - width, 668, width, &ht_pro_24, dim, elapsed);
    }
    ht_pro_text(f, 44, 668, status_width, &ht_pro_24, dim, status);
    pro_hit(32, 598, 492, 104, A_AGENTS, 0, s.connected && !s.loading);
    if (carry.active || carry.error[0])
        pro_control(f, 548, 622, 128, 64, PRO_TR("Drop"), A_CARRY_DROP, 0, true);
    else if (visit.available)
        pro_control(f, 548, 622, 128, 64, PRO_TR("Return"), A_RETURN, 0, s.connected && !visit.pending);
    else if (a && is_question(a->id))
        pro_control(f, 548, 622, 128, 64, PRO_TR("Answer"), A_QUESTION, 0, s.connected && !s.q.pending);
    else if (a && blocked && !strcmp(blocked, "Check its question in Harness."))
        pro_control(f, 548, 622, 128, 64, PRO_TR("Open"), A_DESKTOP, 0, s.connected);
    else if (recap)
        pro_control(f, 548, 622, 128, 64, PRO_TR("Read"), A_READER, 0, true);
}
static void pro_render_home(ht_scene_t *f)
{
    agent_t *a = active();
    bool has_summary = a && !a->busy && a->recap_ready && a->preview[0] &&
        s.connected && !s.loading && !s.nap && !s.voice_retry_until && !carry.active && !carry.error[0];
    bool speech = pro_speech_visible();
    bool has_text = has_summary || speech || carry.active || carry.error[0];
    pro_visual_background(f, s.scene_choice, character.id);
    pro_home_header(f);
    ht_character_mood_t mood = character_mood();
    ht_character_t portrait = character;
    if (speech) {
        // LISTENING names the reusable open-mouth artwork, not the UI state or
        // microphone. Its mouth follows speaker PCM amplitude during playback.
        mood = s.speech.playing ? HT_CHARACTER_LISTENING : HT_CHARACTER_IDLE;
        portrait.motion.reaction.pose.level = s.speech.level;
        portrait.motion.reaction.pose.emotion = s.speech.emotion;
    }
    pro_visual_character(f, &portrait, mood, has_text,
        has_text ? 280 : 185, has_text ? 115 : 164,
        ms(), s.quiet, notice_unread() > 0);
    if (has_text) {
        char carried[192];
        snprintf(carried, sizeof carried, PRO_TR("%d line%s from %s"), carry.rows, carry.rows == 1 ? "" : PRO_TR("s"), carry.source);
        ht_pro_rect(f, 40, 295, 640, 281, 26, color(0xfbf9ef));
        const char *body = carry.active ? (carry.excerpt[0] ? carry.excerpt : carried) :
            carry.error[0] ? PRO_TR("Select the text again, or drop it to start fresh.") :
            speech ? s.speech.caption : a->preview;
        ht_pro_wrap(f, 64, 315, 592, 5, 0, &ht_pro_32, color(0x263b34), body);
    }
    pro_home_footer(f, a, has_summary);
    // Registered after chrome: the same center is voice with or without text.
    pro_hit(40, 106, 640, 474, A_PET, 0, true);
}
static void pro_render_voice(ht_scene_t *f)
{
    bool recording = !s.voice_start_pending && !s.voice_waiting && audio_client_recording();
    bool can_review = recording && cable_client_supports(CABLE_FEATURE_DRAFT) &&
        !s.voice_search && (s.voice_return == HOME || s.voice_return == AGENT || s.voice_return == SELECTION || s.voice_return == WORK_INTENT);
    pro_visual_background(f, s.scene_choice, character.id);
    ht_pro_text(f, 44, 36, 632, &ht_pro_32, color(0x365343), s.voice_target);
    if (s.work_voice_mode != PRO_WORK_TASK)
        ht_pro_text(f, 44, 83, 632, &ht_pro_24, color(0x627466), PRO_TR(pro_work_label(s.work_voice_mode)));
    else if (s.carry_review.id[0]) {
        char source[128]; snprintf(source, sizeof source, PRO_TR("With text from %s"), s.carry_review.source);
        ht_pro_text(f, 44, 83, 632, &ht_pro_24, color(0x627466), source);
    }
    pro_visual_character(f, &character, recording ? HT_CHARACTER_LISTENING : HT_CHARACTER_WORKING,
                          false, 185, 132, ms(), s.quiet, false);
    const char *title = s.voice_start_pending ? PRO_TR("Getting ready...") :
        recording ? (s.voice_review_preview ? PRO_TR("Release to review.") : PRO_TR("Listening...")) :
        s.voice_search ? PRO_TR("Finding...") :
        s.voice_review || s.voice_return == DRAFT || s.voice_return == FORM || question_view(s.voice_return) ?
        PRO_TR("Preparing your words...") : PRO_TR("Sending...");
    ht_pro_rect(f, 28, 480, 664, 112, 24, color(0xfbf9ef));
    ht_pro_text(f, 44, 496, 632, &ht_pro_42, color(0x263b34), title);
    ht_pro_text(f, 44, 554, 632, &ht_pro_24, color(0x627466),
        recording ? (s.voice_review ? PRO_TR("Tap to review.") : can_review ? PRO_TR("Tap to send. Hold to review first.") : PRO_TR("Tap to finish speaking.")) :
        PRO_TR("Your words stay with the selected pane."));
    ht_pro_rect(f, 0, 596, 720, 124, 0, color(0xfbf9ef));
    pro_control(f, 44, 618, 288, 72, s.voice_waiting && !s.voice_review ? PRO_TR("Stop sending") : PRO_TR("Discard"), A_VOICE_ABORT, 0, true);
    if (can_review) pro_control(f, 388, 618, 288, 72, s.voice_review ? PRO_TR("Review") : PRO_TR("Review first"), A_VOICE_STOP, 1, true);
    else ht_pro_text(f, 388, 642, 288, &ht_pro_24, color(0x627466), recording ? PRO_TR("Tap the creature to finish") : PRO_TR("One moment..."));
    pro_hit(40, 106, 640, 474, A_PET, 0, recording);
}
