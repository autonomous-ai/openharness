#pragma once
#include <stdbool.h>
#include <stdint.h>

// GT911 1.2.1 reports up to five tracked contacts. Read all of them so a third
// finger can cancel a chord instead of being silently hidden by a two-point cap.
#define PRO_CONTACTS_MAX 5
typedef struct { uint16_t x, y; uint8_t id; } pro_contact_t;
typedef enum { PRO_CONTACT_NONE, PRO_CONTACT_PASS, PRO_CONTACT_CANCEL,
               PRO_CONTACT_BEGIN, PRO_CONTACT_END } pro_contact_event_t;
typedef struct { pro_contact_event_t event; int step; } pro_contact_result_t;
typedef enum { PRO_CONTACT_IDLE, PRO_CONTACT_SINGLE, PRO_CONTACT_PAIR,
               PRO_CONTACT_TAIL, PRO_CONTACT_BLOCKED } pro_contact_phase_t;
typedef struct {
    pro_contact_phase_t phase;
    pro_contact_t origin[2], last[2];
    uint32_t started, sampled, tail;
    uint8_t updates, tail_id;
    int direction, step;
} pro_contacts_t;

static inline int pro_contact_abs(int n) { return n < 0 ? -n : n; }
static inline void pro_contacts_block(pro_contacts_t *s)
{
    s->phase = PRO_CONTACT_BLOCKED;
    s->step = 0;
}
static inline pro_contact_result_t pro_contacts_cancel(pro_contacts_t *s)
{
    pro_contacts_block(s);
    return (pro_contact_result_t){PRO_CONTACT_CANCEL, 0};
}
static inline int pro_contact_find(const pro_contact_t *p, unsigned n, uint8_t id)
{
    for (unsigned i = 0; i < n; i++) if (p[i].id == id) return (int)i;
    return -1;
}
static inline pro_contact_result_t pro_contacts_sample(pro_contacts_t *s,
    const pro_contact_t *p, unsigned n, uint32_t now)
{
    if (s->phase == PRO_CONTACT_BLOCKED) {
        if (!n) *s = (pro_contacts_t){0};
        return (pro_contact_result_t){PRO_CONTACT_NONE, 0};
    }
    if (n > 2 || (n && !p)) return pro_contacts_cancel(s);
    for (unsigned i = 0; i < n; i++) {
        if (p[i].x >= 720 || p[i].y >= 720) return pro_contacts_cancel(s);
        for (unsigned j = 0; j < i; j++)
            if (p[i].id == p[j].id) return pro_contacts_cancel(s);
    }
    if (!n) {
        pro_contact_result_t result = {PRO_CONTACT_NONE, 0};
        if (s->phase == PRO_CONTACT_SINGLE) result.event = PRO_CONTACT_PASS;
        if (s->phase == PRO_CONTACT_PAIR || s->phase == PRO_CONTACT_TAIL) {
            result.event = PRO_CONTACT_END;
            if (now - s->started <= 1200 && now - s->sampled <= 120 &&
                (s->phase != PRO_CONTACT_TAIL || now - s->tail <= 180))
                result.step = s->step;
        }
        *s = (pro_contacts_t){0};
        return result;
    }
    if (s->phase == PRO_CONTACT_IDLE) {
        s->started = s->sampled = now;
        s->origin[0] = s->last[0] = p[0];
        if (n == 1) {
            s->phase = PRO_CONTACT_SINGLE;
            return (pro_contact_result_t){PRO_CONTACT_PASS, 0};
        }
    } else if (s->phase == PRO_CONTACT_SINGLE) {
        int i = pro_contact_find(p, n, s->origin[0].id);
        if (i < 0) return pro_contacts_cancel(s);
        if (n == 1) {
            s->last[0] = p[0];
            if (pro_contact_abs((int)p[0].x - s->origin[0].x) >= 24 ||
                pro_contact_abs((int)p[0].y - s->origin[0].y) >= 24)
                s->direction = 1; // This contact has already moved, even if it returns.
            return (pro_contact_result_t){PRO_CONTACT_PASS, 0};
        }
        // A second finger may join a fresh, still press. It cannot reinterpret
        // an already moving scroll or a long-held written control as navigation.
        if (now - s->started > 180 || s->direction ||
            pro_contact_abs((int)p[i].x - s->origin[0].x) >= 24 ||
            pro_contact_abs((int)p[i].y - s->origin[0].y) >= 24 ||
            pro_contact_abs((int)s->last[0].x - s->origin[0].x) >= 24 ||
            pro_contact_abs((int)s->last[0].y - s->origin[0].y) >= 24)
            return pro_contacts_cancel(s);
    } else {
        if (now - s->started > 1200 || now - s->sampled > 120)
            return pro_contacts_cancel(s);
        if (s->phase == PRO_CONTACT_TAIL || n == 1) {
            if (n != 1 || (s->phase == PRO_CONTACT_TAIL && p[0].id != s->tail_id))
                return pro_contacts_cancel(s);
            int i = pro_contact_find(s->last, 2, p[0].id);
            if (i < 0 || pro_contact_abs((int)p[0].x - s->last[i].x) > 24 ||
                pro_contact_abs((int)p[0].y - s->last[i].y) > 24)
                return pro_contacts_cancel(s);
            if (s->phase == PRO_CONTACT_PAIR) {
                s->phase = PRO_CONTACT_TAIL;
                s->tail = now;
                s->tail_id = p[0].id;
            }
            if (now - s->tail > 180) return pro_contacts_cancel(s);
            s->sampled = now;
            return (pro_contact_result_t){PRO_CONTACT_NONE, 0};
        }
        int dx[2], dy[2];
        bool moved = false;
        for (int i = 0; i < 2; i++) {
            int j = pro_contact_find(p, n, s->origin[i].id);
            if (j < 0 || pro_contact_abs((int)p[j].x - s->last[i].x) > 160 ||
                pro_contact_abs((int)p[j].y - s->last[i].y) > 160)
                return pro_contacts_cancel(s);
            dx[i] = (int)p[j].x - s->origin[i].x;
            dy[i] = (int)p[j].y - s->origin[i].y;
            if (pro_contact_abs(dy[i]) > 56) return pro_contacts_cancel(s);
            moved |= p[j].x != s->last[i].x || p[j].y != s->last[i].y;
            s->last[i] = p[j];
        }
        if (pro_contact_abs(dx[0] - dx[1]) > 64) return pro_contacts_cancel(s);
        if (!s->direction && pro_contact_abs(dx[0]) >= 32 && dx[0] * dx[1] > 0)
            s->direction = dx[0] > 0 ? 1 : -1;
        if (s->direction && (dx[0] * s->direction < -24 || dx[1] * s->direction < -24))
            return pro_contacts_cancel(s);
        if (moved && s->updates < 255) s->updates++;
        s->sampled = now;
        s->step = s->updates >= 2 && now - s->started >= 60 &&
                  dx[0] * dx[1] > 0 && pro_contact_abs(dx[0]) >= 96 &&
                  pro_contact_abs(dx[1]) >= 96 &&
                  pro_contact_abs(dx[0]) >= 2 * pro_contact_abs(dy[0]) &&
                  pro_contact_abs(dx[1]) >= 2 * pro_contact_abs(dy[1])
                      ? (dx[0] < 0 ? 1 : -1) : 0;
        return (pro_contact_result_t){PRO_CONTACT_NONE, 0};
    }
    s->phase = PRO_CONTACT_PAIR;
    s->origin[0] = s->last[0] = p[0];
    s->origin[1] = s->last[1] = p[1];
    s->started = s->sampled = now;
    s->updates = 0;
    s->direction = s->step = 0;
    return (pro_contact_result_t){PRO_CONTACT_BEGIN, 0};
}
