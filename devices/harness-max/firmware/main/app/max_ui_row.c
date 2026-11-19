// App Detail's row in motion (max_ui_internal.h), as V3's OverviewPage moves it. Each agent's look eases to where the
// page sends it, as V3's implicit animations do: the widths together as the row's one move (kRowEase over 420 ms), a
// sliver's pet, words and dimming, the open agent's face, ground and panel. The scroll is carried along with the move
// while an agent opens, goes back to the closed agent once the cells have their width again, and to the front when
// the model sends it there. The finger drags the row px by px; let go with no agent open it settles on a cell's edge
// (one further when flung), open it rests where it was let go. All of it runs on the clock (now_ms), never on frames.
// The touch task and the render task both come here: 1 KB frames.
#include <string.h>

#include "max_ui_draw.h"

enum {
    Q = 65536,
    FLING_V = DX(50),     // px/s: a slower lift is no fling (Flutter's kMinFlingVelocity, 50 logical px/s)
    FLING_PX = DX(18),    // and one that went less than this in its last moves (kTouchSlop)
    TRACK_MS = 100,       // the speed is the finger's over its last 100 ms (VelocityTracker's horizon)
    STOPPED_MS = 40,      // a finger that rested this long before a move or the lift had stopped
    WORDS_MS = 200, FACE_MS = 250, DIM_MS = 350, GROUND_MS = 350, PANEL_IN_MS = 440, PANEL_OUT_MS = 300, DOT_MS = 250,
};

static int imin(int a, int b) { return a < b ? a : b; }
static int imax(int a, int b) { return a > b ? a : b; }
static int iabs(int v) { return v < 0 ? -v : v; }

// ---- the curves ----

// Flutter's _evaluateCubic(a, b, m): 3a(1-m)^2 m + 3b(1-m)m^2 + m^3, all Q16.
static int32_t bezier(int64_t a, int64_t b, int64_t m)
{
    const int64_t u = Q - m, um = u * m >> 16;
    return (int32_t)((3 * a * (um * u >> 16) + 3 * b * (um * m >> 16) + (m * m >> 16) * m) >> 16);
}
// Cubic(x1, y1, x2, y2).transform(t): halve [0, 1] until the curve's x is within .001 of t.
static int32_t cubic(int32_t x1, int32_t y1, int32_t x2, int32_t y2, int32_t t)
{
    if (t <= 0) return 0;
    if (t >= Q) return Q;
    int32_t lo = 0, hi = Q;
    for (;;) {
        const int32_t mid = (lo + hi) / 2, x = bezier(x1, x2, mid);
        if (iabs(t - x) * 1000 < Q || hi - lo < 2) return bezier(y1, y2, mid);
        if (x < t) lo = mid;
        else hi = mid;
    }
}

int32_t max_ease(max_curve_t curve, int32_t t)
{
    if (curve == MAX_EASE_ROW) return cubic(Q / 5, Q * 4 / 5, Q / 5, Q, t);   // Cubic(.2, .8, .2, 1)
    if (curve == MAX_EASE_LATE) {   // Interval(140 / 440, 1, ease): nothing for the first 140 ms of 440
        const int32_t begin = 140 * Q / 440;
        if (t <= begin) return 0;
        t = (int32_t)((int64_t)(t - begin) * Q / (Q - begin));
    }
    return cubic(Q / 4, Q / 10, Q / 4, Q, t);   // Curves.ease, Cubic(.25, .1, .25, 1)
}

// ---- the tweens ----

int32_t max_tween_at(const max_tween_t *t, uint32_t now_ms)
{
    const int32_t gone = (int32_t)(now_ms - t->at);
    if (!t->ms || gone >= t->ms) return t->to;
    if (gone <= 0) return t->from;
    const int32_t e = max_ease((max_curve_t)t->curve, (int32_t)((int64_t)gone * Q / t->ms));
    return t->from + (int32_t)(((int64_t)(t->to - t->from) * e + Q / 2) >> 16);
}
bool max_tween_done(const max_tween_t *t, uint32_t now_ms)
{
    return !t->ms || (int32_t)(now_ms - t->at) >= t->ms || t->from == t->to;
}
static void rest(max_tween_t *t, int32_t v) { *t = (max_tween_t){v, v, 0, 0, 0}; }
// From where it is now to `to`, again from the start: the row's move restarts every width together.
static void run(max_tween_t *t, int32_t to, uint32_t ms, max_curve_t curve, uint32_t now_ms)
{
    *t = (max_tween_t){max_tween_at(t, now_ms), to, now_ms, (uint16_t)ms, (uint8_t)curve};
}
// An implicit animation: a new end starts it again from where it is; the same end leaves it running.
static void ease_to(max_tween_t *t, int32_t to, uint32_t ms, max_curve_t curve, uint32_t now_ms)
{
    if (t->to != to) run(t, to, ms, curve, now_ms);
}

// ---- the row ----

// The agent open across the row: the agent page's, while it is in the row.
static const char *open_id(const int *row, int n)
{
    if (max_m.view != MAX_VIEW_AGENT) return "";
    for (int i = 0; i < n; i++)
        if (!strcmp(max_m.agents[row[i]].id, max_m.selected)) return max_m.selected;
    return "";
}
static int row_of(int out[MAX_AGENTS]) { return max_m.link ? max_row(out) : 0; }
static max_look_t *look_of(const char *id)
{
    for (int i = 0; i < max_m.row.look_count; i++)
        if (!strcmp(max_m.row.looks[i].id, id)) return &max_m.row.looks[i];
    return NULL;
}
static int width_for(const char *id, const char *open)
{
    return !open[0] ? CELL_W : !strcmp(id, open) ? OPEN_W : SLIVER_W;
}

// Where the scroll rests: the open agent with a sliver before it where there is one (V3 _openScroll), else the cell
// row_first at the row's left edge.
static int open_px(const char *open, const int *row, int n)
{
    int at = 0;
    for (int i = 0; i < n; i++)
        if (!strcmp(max_m.agents[row[i]].id, open)) at = i;
    return imax(0, imin((at - 1) * SLIVER_W, OPEN_W + (n - 1) * SLIVER_W - ROW_W));
}
static int closed_px(int n)
{
    const int last = imax(0, n - MAX_CELLS);
    return imax(0, imin(max_m.row_first, last)) * CELL_W;
}

// The row's width at now_ms: its agents' widths as they ease.
static int content_w(uint32_t now_ms)
{
    int row[MAX_AGENTS], w = 0;
    const int n = row_of(row);
    for (int i = 0; i < n; i++) {
        const max_look_t *l = look_of(max_m.agents[row[i]].id);
        w += l ? max_tween_at(&l->w, now_ms) : width_for(max_m.agents[row[i]].id, max_m.row.open);
    }
    return w;
}

// The scroll at now_ms within the row as it is then: a drag's, else where its tween is.
static int scroll_at(uint32_t now_ms, int content)
{
    const max_row_t *r = &max_m.row;
    const int px = r->drag ? r->drag_px : max_tween_at(&r->px, now_ms);
    return imax(0, imin(px, content - ROW_W));
}

int max_row_layout(uint32_t now_ms, max_place_t out[MAX_AGENTS], int *px)
{
    int row[MAX_AGENTS];
    const int n = row_of(row);
    const char *open = max_m.row.open;
    int content = 0;
    for (int i = 0; i < n; i++) {
        const max_agent_t *a = &max_m.agents[row[i]];
        const max_look_t *l = look_of(a->id);
        out[i] = (max_place_t){a, l, 0, l ? max_tween_at(&l->w, now_ms) : width_for(a->id, open)};
        content += out[i].w;
    }
    const int scroll = scroll_at(now_ms, content);
    for (int i = 0, x = ROW_X - scroll; i < n; x += out[i].w, i++) out[i].x = x;
    if (px) *px = scroll;
    return n;
}

// An agent's look at rest where the page sends it.
static void look_rest(max_look_t *l, const char *open, bool seen)
{
    const bool opened = open[0] && !strcmp(l->id, open), sliver = open[0] && !opened;
    rest(&l->w, width_for(l->id, open));
    rest(&l->sl, sliver ? MAX_ONE : 0);
    rest(&l->words, sliver ? 0 : MAX_ONE);
    rest(&l->face, opened ? 0 : MAX_ONE);
    rest(&l->dim, sliver ? MAX_ONE : 0);
    rest(&l->ground, opened ? MAX_ONE : 0);
    rest(&l->panel, opened ? MAX_ONE : 0);
    rest(&l->dot, seen ? MAX_ONE : 0);
}
// Each part on its way there, as V3's cell eases it: a part whose end is unchanged runs on.
static void look_send(max_look_t *l, const char *open, uint32_t now_ms)
{
    const bool opened = open[0] && !strcmp(l->id, open), sliver = open[0] && !opened;
    ease_to(&l->sl, sliver ? MAX_ONE : 0, MAX_ROW_MS, MAX_EASE_ROW, now_ms);
    ease_to(&l->words, sliver ? 0 : MAX_ONE, WORDS_MS, MAX_EASE, now_ms);
    ease_to(&l->face, opened ? 0 : MAX_ONE, FACE_MS, MAX_EASE, now_ms);
    ease_to(&l->dim, sliver ? MAX_ONE : 0, DIM_MS, MAX_EASE, now_ms);
    ease_to(&l->ground, opened ? MAX_ONE : 0, GROUND_MS, MAX_EASE, now_ms);
    if (opened) ease_to(&l->panel, MAX_ONE, PANEL_IN_MS, MAX_EASE_LATE, now_ms);
    else ease_to(&l->panel, 0, PANEL_OUT_MS, MAX_EASE, now_ms);
}

// At least half of it on the glass: its dot is lit.
static bool seen(const max_place_t *p)
{
    const int l = imax(p->x, ROW_X), r = imin(p->x + p->w, ROW_X + ROW_W);
    return p->w > 0 && 2 * (r - l) >= p->w;
}

void max_row_step(uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    int row[MAX_AGENTS];
    const int n = row_of(row);
    const char *open = open_id(row, n);
    const bool fresh = !r->had, turned = strcmp(open, r->open) != 0;
    // The looks of the row's agents, in its order; one new to the row starts where the page sends it.
    static max_look_t kept[MAX_AGENTS];   // 5 KB: past the render task's frame; only the render task steps the row
    for (int i = 0; i < n; i++) {
        const max_look_t *l = look_of(max_m.agents[row[i]].id);
        if (l) kept[i] = *l;
        else {
            memset(&kept[i], 0, sizeof kept[i]);
            memcpy(kept[i].id, max_m.agents[row[i]].id, ID_MAX);
            look_rest(&kept[i], fresh ? open : r->open, false);
        }
    }
    memcpy(r->looks, kept, (size_t)n * sizeof kept[0]);
    r->look_count = n;
    if (fresh) {   // another page just now: the row is laid out where it rests (V3 builds the page afresh)
        for (int i = 0; i < n; i++) look_rest(&r->looks[i], open, false);
        r->drag = r->grab = r->back = false;
        rest(&r->px, open[0] ? open_px(open, row, n) : closed_px(n));
    } else if (turned) {
        const int px = scroll_at(now_ms, content_w(now_ms));
        for (int i = 0; i < n; i++) {
            max_look_t *l = &r->looks[i];
            run(&l->w, width_for(l->id, open), MAX_ROW_MS, MAX_EASE_ROW, now_ms);
            look_send(l, open, now_ms);
        }
        r->drag = false;   // the page moved under the finger: it lets go of the row
        r->back = false;
        if (open[0]) {   // carried along with the move to where the open agent rests (V3 _carry)
            r->px = (max_tween_t){px, open_px(open, row, n), now_ms, MAX_ROW_MS, MAX_EASE_ROW};
        } else {         // it stays while the cells take their width, then goes back (V3 _back)
            rest(&r->px, px);
            r->back = true;
            r->back_at = now_ms + MAX_ROW_MS;
        }
    } else if (!open[0] && !r->drag) {
        if (r->back && (int32_t)(now_ms - r->back_at) >= 0) {
            r->back = false;
            r->px = (max_tween_t){max_tween_at(&r->px, r->back_at), closed_px(n), r->back_at, MAX_ROW_MS, MAX_EASE_ROW};
        } else if (!r->back && max_m.row_first != r->first) {   // to the front, or wherever the model sent it
            run(&r->px, closed_px(n), MAX_ROW_MS, MAX_EASE_ROW, now_ms);
        }
    }
    memcpy(r->open, open, sizeof r->open);
    r->first = max_m.row_first;
    // The dots follow the scroll: lit while at least half the agent is on the glass.
    static max_place_t at[MAX_AGENTS];
    max_row_layout(now_ms, at, NULL);
    for (int i = 0; i < n; i++) {
        if (fresh) rest(&r->looks[i].dot, seen(&at[i]) ? MAX_ONE : 0);
        else ease_to(&r->looks[i].dot, seen(&at[i]) ? MAX_ONE : 0, DOT_MS, MAX_EASE, now_ms);
    }
}

bool max_row_moving(uint32_t now_ms)
{
    const max_row_t *r = &max_m.row;
    if (r->back || !max_tween_done(&r->px, now_ms)) return true;
    for (int i = 0; i < r->look_count; i++) {
        const max_look_t *l = &r->looks[i];
        const max_tween_t *parts[] = {&l->w, &l->sl, &l->words, &l->face, &l->dim, &l->ground, &l->panel, &l->dot};
        for (unsigned k = 0; k < sizeof parts / sizeof parts[0]; k++)
            if (!max_tween_done(parts[k], now_ms)) return true;
    }
    return false;
}

// ---- the finger ----

static void track(int x, uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    if (r->track_n == MAX_TRACK) {
        memmove(r->track_x, r->track_x + 1, (MAX_TRACK - 1) * sizeof r->track_x[0]);
        memmove(r->track_t, r->track_t + 1, (MAX_TRACK - 1) * sizeof r->track_t[0]);
        r->track_n--;
    }
    r->track_x[r->track_n] = (int16_t)x;
    r->track_t[r->track_n++] = now_ms;
}

// The scroll's speed as the finger lets go at now_ms, px/s: the finger's over its last moves within TRACK_MS of the
// newest, none older than a rest of STOPPED_MS, and nothing when it rested that long before the lift. A lift that is
// no fling (too slow, or too short a way in those moves) is a speed of 0.
static int fling(uint32_t now_ms)
{
    const max_row_t *r = &max_m.row;
    if (!r->track_n) return 0;
    const int last = r->track_n - 1;
    if (now_ms - r->track_t[last] > STOPPED_MS) return 0;
    int first = last;
    while (first > 0 && r->track_t[last] - r->track_t[first - 1] <= TRACK_MS &&
           r->track_t[first] - r->track_t[first - 1] <= STOPPED_MS)
        first--;
    const int dx = r->track_x[last] - r->track_x[first];
    const uint32_t dt = r->track_t[last] - r->track_t[first];
    if (!dt || iabs(dx) <= FLING_PX) return 0;
    const int v = (int)((int64_t)-dx * 1000 / (int32_t)dt);   // the scroll runs against the finger
    return iabs(v) > FLING_V ? v : 0;
}


void max_row_down(int x, uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    // The row's own ground: not the columns beside it, not the open agent (its drag is its own: V3 _Opening), not
    // under the form or the update screen.
    r->grab = r->drawn && (max_m.view == MAX_VIEW_OVERVIEW || max_m.view == MAX_VIEW_AGENT) && !max_form_open() &&
              max_m.update_pct < 0 && x >= ROW_X && x < ROW_X + ROW_W && !(x >= r->open_l && x < r->open_r);
    r->drag = false;
    r->track_n = 0;
    track(x, now_ms);
}

void max_row_move(int x, uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    if (!r->grab) return;
    track(x, now_ms);
    if (!r->drag) {
        if (iabs(x - max_m.down_x) <= MAX_TAP_SLOP) return;
        // It takes the row from where it is: the carry, the way back and any settle stop there, and the slop the finger
        // went first is not the row's (Flutter's DragStartBehavior.start).
        const int content = content_w(now_ms);
        const int px = scroll_at(now_ms, content);
        rest(&r->px, px);
        r->back = false;
        r->drag = true;
        r->drag_x = x;
        r->drag_px = px;
    }
    // Move by move, each held at the row's ends (ClampingScrollPhysics): a finger that went past an end and comes
    // back moves the row at once.
    r->drag_px = imax(0, imin(r->drag_px + r->drag_x - x, content_w(now_ms) - ROW_W));
    r->drag_x = x;
    max_m.dirty = true;
}

// Let go with this speed: no agent open, the row settles on a cell's edge, the nearest or, flung, the next one the way
// it went (V3 SnapPhysics), and row_first is that cell; open, it rests where it is.
static void settle(int v, uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    int row[MAX_AGENTS];
    const int n = row_of(row), px = scroll_at(now_ms, content_w(now_ms));
    r->drag = false;
    rest(&r->px, px);
    if (!r->open[0]) {
        const int side = v > 0 ? 1 : v < 0 ? -1 : 0, last = imax(0, n - MAX_CELLS);
        const int cell = imax(0, imin((2 * px + side * CELL_W + CELL_W) / (2 * CELL_W), last));
        max_m.row_first = r->first = cell;
        run(&r->px, cell * CELL_W, MAX_ROW_MS, MAX_EASE_ROW, now_ms);
    }
    max_m.dirty = true;
}

bool max_row_up(int x, uint32_t now_ms)
{
    max_row_t *r = &max_m.row;
    const bool dragged = r->drag;
    (void)x;
    if (dragged) settle(fling(now_ms), now_ms);
    r->grab = false;
    return dragged;
}

void max_row_cancel(void)
{
    const max_row_t *r = &max_m.row;
    if (r->drag) settle(0, r->track_t[r->track_n - 1]);   // a lost finger rests: no fling, from its last move
    max_m.row.grab = false;
}
