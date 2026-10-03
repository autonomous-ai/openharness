#include "character_types.h"
#include "perf_bench.h"

static bool due(uint32_t now, uint32_t deadline) { return (int32_t)(now - deadline) >= 0; }
static void deadline(ht_character_reaction_t *m, uint32_t now, uint32_t at)
{
    uint32_t left = due(now, at) ? 1 : at - now;
    if (left < m->next_ms) m->next_ms = left;
}
bool ht_character_reaction_tick(ht_character_reaction_t *m, uint32_t now, ht_character_mood_t mood,
                        bool quiet, bool visible, bool down, int x, unsigned level, uint32_t activity)
{
    ht_character_pose_t old = m->pose, p = {0};
    m->next_ms = 1000;
    if (!m->initialized) {
        m->initialized = true;
        m->next_blink = now + 5700;
        m->blink_until = m->reaction_until = m->release_until = now;
        m->mood = mood; m->activity = activity;
    }
    if (!visible || quiet || mood == HT_CHARACTER_ASLEEP || mood == HT_CHARACTER_OFFLINE) {
        m->next_blink = now + 5700;
        m->blink_until = m->reaction_until = m->release_until = now;
    } else {
        if ((activity != m->activity || mood != m->mood) &&
            (mood == HT_CHARACTER_WORKING || mood == HT_CHARACTER_DONE || mood == HT_CHARACTER_ATTENTION)) {
            // Repeated tool packets cannot restart an endless busy animation.
            bool completed = mood == HT_CHARACTER_DONE && m->mood != HT_CHARACTER_DONE;
            if (completed || (due(now, m->reaction_until) && (!m->reaction_at || now - m->reaction_at >= 2000))) {
                m->reaction_at = now;
                m->reaction_until = now + (completed ? 1320 : 720);
            }
        }
        if (down) {
            // The eyes follow the finger relative to the middle of the FACE, not to 233 — which is
            // the dial's centre and a third of the way across the Pro's, so every touch there read
            // as a look to the right.
            int gaze = (x - HT_WIDTH / 2) / 40;
            p.look = gaze < -2 ? -2 : gaze > 2 ? 2 : gaze;
            p.pressed = true;
            m->release_until = now + 400;
        } else if (m->was_down || !due(now, m->release_until)) {
            p.look = old.look;
            deadline(m, now, m->release_until);
        }
        if (!down && due(now, m->next_blink)) {
            m->blink_until = now + 110;
            m->sequence++;
            m->next_blink = now + 5700 + (m->sequence % 5) * 413;
        }
        p.blink = !down && !due(now, m->blink_until);
        if (!down) deadline(m, now, p.blink ? m->blink_until : m->next_blink);
        if (!due(now, m->reaction_until)) {
            p.hands = (uint8_t)(1 + (now - m->reaction_at) / 120 % 2);
            if (mood == HT_CHARACTER_DONE && !down) {
                // A brief glance right, glance left, then a blink and smile.
                // The completion event owns this finite cue; repeated status
                // packets cannot sustain it, and touch always keeps its gaze.
                uint32_t age = now - m->reaction_at;
                p.look = age < 360 ? 2 : age < 720 ? -2 : 0;
                p.blink = age >= 840 && age < 960;
            }
            deadline(m, now, now + 120 - (now - m->reaction_at) % 120);
        }
        if (mood == HT_CHARACTER_LISTENING) {
            p.level = old.level;
            if (m->mood != mood || now - m->level_at >= 125) {
                p.level = level > 4 ? 4 : (uint8_t)level;
                m->level_at = now;
            }
            deadline(m, now, m->level_at + 125);
        }
    }
    m->pose = p; m->mood = mood; m->activity = activity; m->was_down = down;
    return p.look != old.look || p.hands != old.hands || p.level != old.level ||
           p.blink != old.blink || p.pressed != old.pressed;
}
bool ht_character_motion_step(ht_character_motion_t *m, const ht_character_animation_t *a,
                              uint32_t now, ht_character_mood_t mood, bool quiet, bool visible,
                              bool down, int x, unsigned level, uint32_t activity, bool animate)
{
    if (!a || !a->frames || !a->duration || !a->ends) return false;
#ifdef DEVICE_OCTOPUS_BENCH
    animate = animate && octopus_perf_animate();
#endif
    bool changed = ht_character_reaction_tick(&m->reaction, now, mood, quiet, visible, down, x, level, activity);
    bool running = animate && visible && !quiet && !down &&
        mood != HT_CHARACTER_ASLEEP && mood != HT_CHARACTER_OFFLINE;
    // The body keeps its gentle idle pace while listening. Microphone-driven
    // mouth/eye reactions remain independent and continue at their own cadence.
    uint8_t rate = mood == HT_CHARACTER_IDLE || mood == HT_CHARACTER_LISTENING ? 2 : 1;
    uint8_t old_frame = m->frame;
    if (m->animation != a) {
        changed = true;
        m->phase = m->remainder = 0;
        m->initialized = false;
        m->animation = a;
    }
    if (m->initialized && m->running && running) {
        uint32_t scaled = (now - m->last_ms) % (a->duration * m->rate) + m->remainder;
        m->phase = (m->phase + scaled / m->rate) % a->duration;
        m->remainder = scaled % m->rate;
    } else m->remainder = 0;
    if (m->rate != rate) m->remainder = 0;
    m->initialized = true; m->running = running; m->rate = rate; m->last_ms = now;
    m->frame = 0;
    while (m->frame + 1 < a->frames && m->phase >= a->ends[m->frame]) m->frame++;
    m->next_ms = m->reaction.next_ms;
    if (running) {
        uint32_t next = (a->ends[m->frame] - m->phase) * rate - m->remainder;
        if (next < m->next_ms) m->next_ms = next ? next : 1;
    }
    return changed || m->frame != old_frame;
}
