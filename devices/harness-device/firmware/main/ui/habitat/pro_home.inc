/* Presence first. The whole glass is one creature; words live on their own sheet. */
static unsigned pro_home_living_mood(void)
{
    if (s.view==VOICE) return !s.voice_start_pending && !s.voice_waiting && audio_client_recording()?1:2;
    if (s.nap || !s.connected) return 4;
    if (s.voice_retry_until || s.speech_error_until || carry.error[0]) return 5;
    if (pro_speech_visible()) return s.speech.playing?3:2;
    if (notice_unread() || waiting() || s.q.pending) return PRO_LIVING_ATTENTION;
    agent_t *a=active();
    if (a && a->busy) return 2;
    if (pro_send_feedback_text(ms())) return 3;
    return 0;
}
static void pro_render_home(ht_scene_t *f)
{
    ht_scene_clear(f,color(0x101019));
    pro_living_image(f,s.living_selected,pro_home_living_mood(),s.living_frame,40,40,640);
    pro_hit(0,0,720,720,A_PET,0,true);
}
static void pro_render_voice(ht_scene_t *f)
{
    ht_scene_clear(f,color(0x101019));
    pro_living_image(f,s.living_selected,pro_home_living_mood(),s.living_frame,40,40,640);
    pro_hit(0,0,720,720,A_PET,0,true);
}
