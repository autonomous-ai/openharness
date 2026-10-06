/* Differential oracle: exact ef2ca597a462507f91f80ee2c972e79242925c81
 * ui_notif_replace, except naming and the deliberate incoming-question freshness
 * assignment shared with the readiness change. Never linked into firmware. */
static void reference_notif_replace(const cable_notif_t *rows, int count)
{
    display_lock();
#ifdef DEVICE_PRO_COMPANION
    if (!s.connected) { display_unlock(); return; }
    // Display lock serializes this bounded scratch array without using the UI
    // task's stack. The snapshot contains unread notices, not open questions.
    static EXT_RAM_BSS_ATTR cable_notif_t questions[NOTICES];
    int question_count=0;
    for (int i=0; i<s.notice_count; i++) if (s.notice[i].question) questions[question_count++]=s.notice[i];
#endif
    char selected[ID_MAX]; notice_selection(selected, sizeof selected);
    cable_notif_t held = {0};
    if (selected[0] && s.notice[s.offset].read_on_dial && s.notice[s.offset].read_token[0])
        held = s.notice[s.offset];
    if (!rows || count < 0) count = 0;
    if (count > NOTICES) count = NOTICES;
    s.notice_count = 0;
    for (int i = count - 1; i >= 0; i--) {
        notice_add(rows[i].agent_id, rows[i].name, rows[i].machine, rows[i].summary,
                   rows[i].question, rows[i].failed);
        for (int j = 0; j < s.notice_count; j++) if (!strcmp(s.notice[j].agent_id, rows[i].agent_id)) {
            COPY(s.notice[j].read_token, rows[i].read_token);
            s.notice[j].read_on_dial = notice_was_read(&s.notice[j]);
            if (rows[i].question) s.notice[j].question_current=s.connected;
            break;
        }
    }
#ifdef DEVICE_PRO_COMPANION
    // Reserve a currently read result before merging the pending catalog.
    // A full 64-question + eight-unread snapshot must not displace its reader.
    if (held.agent_id[0] && !held.question) {
        bool present=false;
        for (int i=0; i<s.notice_count; i++) if (!strcmp(s.notice[i].agent_id,held.agent_id)) present=true;
        if (!present) {
            int at=s.notice_count<NOTICES ? s.notice_count++ : -1;
            if (at<0) for (int i=s.notice_count-1; i>=0; i--) if (!s.notice[i].question) { at=i; break; }
            if (at>=0) s.notice[at]=held;
        }
    }
    for (int k=0; k<question_count; k++) {
        const cable_notif_t *old=&questions[k]; int at=-1;
        for (int i=0; i<s.notice_count; i++) if (!strcmp(s.notice[i].agent_id,old->agent_id)) { at=i; break; }
        if (at>=0 && s.notice[at].question) {
            cable_notif_t *n=&s.notice[at];
            if (!strcmp(n->read_token,old->read_token) ||
                (!old->read_token[0] && old->question_id[0] && !strcmp(n->summary,old->summary))) {
                COPY(n->question_id,old->question_id); n->question_signature=old->question_signature;
                n->question_unavailable=old->question_unavailable;
                n->read_on_dial=old->read_on_dial;
            }
            continue; // A new token is a new occurrence, never the old question ID.
        }
        if (at<0) {
            if (s.notice_count==NOTICES) {
                // Questions take priority over the oldest result; never evict a
                // different unresolved question to retain this one.
                for (int i=s.notice_count-1; i>=0; i--) if (!s.notice[i].question && strcmp(s.notice[i].agent_id,selected)) { at=i; break; }
                if (at<0 && pro_notice_pinned(old,selected)) {
                    for (int i=s.notice_count-1; i>=0; i--) if (!pro_notice_pinned(&s.notice[i],selected)) { at=i; break; }
                }
                if (at<0) { s.notice_overflow=true; continue; }
                if (s.notice[at].question) s.notice_overflow=true;
            } else at=s.notice_count++;
        }
        s.notice[at]=*old;
    }
    if (!s.q.pending && (s.q.valid || s.q.loading) && s.q.notice_token[0]) {
        for (int i=0; i<s.notice_count; i++) {
            const cable_notif_t *n=&s.notice[i];
            if (!n->question || strcmp(n->agent_id,s.q.agent) || !strcmp(n->read_token,s.q.notice_token)) continue;
            s.q.valid=s.q.loading=false;s.q.revision++;
            COPY(s.q.error,"The question changed. Open the alert again.");
            if (question_view(s.view)) view(QUESTION);
            break;
        }
    }
#endif
    // An unread absence acknowledges the read, not an answer. Keep the current
    // result card in place as before; Pro questions remain until exact resolution.
    for (int i = 0; i < NOTICES; i++) if (s.notice_reads[i].pending) {
        bool present = false;
        for (int j = 0; j < count; j++)
            if (!strcmp(rows[j].agent_id, s.notice_reads[i].id) &&
                !strcmp(rows[j].read_token, s.notice_reads[i].token)) present = true;
        if (!present) s.notice_reads[i].pending = false;
    }
    bool retained = false;
    for (int i = 0; i < s.notice_count; i++) if (!strcmp(s.notice[i].agent_id, selected)) retained = true;
    if (held.agent_id[0] && !retained && s.notice_count < NOTICES) {
        s.notice[s.notice_count++] = held;
    }
    notice_restore_selection(selected);
    notice_sync_view();
    change();
    display_unlock();
}
