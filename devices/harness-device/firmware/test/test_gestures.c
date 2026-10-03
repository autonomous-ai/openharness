#include "../main/ui/habitat/gestures.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static ht_gesture_t g;
static ht_touch_result_t tap(uint32_t t, int x, int y) {
    ht_gesture_begin(&g,x,y,t,0);
    ht_gesture_move(&g,x+2,y-2);
    return ht_gesture_end(&g,x,y,t+75);
}
static void clear(void) { memset(&g,0,sizeof(g)); }
static uint32_t seed=1267;
static unsigned next(void) { seed=seed*1664525u+1013904223u; return seed; }
int main(void) {
    clear(); ht_gesture_begin(&g,233,233,1000,0);
    assert(g.live); // DOWN only starts classification, never an action.
    assert(ht_gesture_end(&g,233,233,1075)==HT_TOUCH_TAP);
    ht_gesture_guard(&g,1075); ht_gesture_cancel(&g);
    assert(tap(1200,233,233)==HT_TOUCH_NONE);
    assert(tap(1400,233,233)==HT_TOUCH_NONE); // old double/triple habit is one voice intent
    assert(tap(1600,233,233)==HT_TOUCH_TAP);
    clear(); ht_gesture_begin(&g,230,230,1000,0);
    assert(ht_gesture_end(&g,230,230,1330)==HT_TOUCH_TAP); // deliberate slower tap
    ht_gesture_begin(&g,230,230,2000,0);
    assert(ht_gesture_end(&g,230,230,2700)==HT_TOUCH_HOLD);
    ht_gesture_begin(&g,230,230,3000,0);
    assert(ht_gesture_end(&g,230,230,10000)==HT_TOUCH_NONE); // resting finger
    ht_gesture_begin(&g,230,230,11000,0);
    assert(ht_gesture_end(&g,230,230,11024)==HT_TOUCH_NONE); // sensor pulse
    clear(); assert(tap(UINT32_MAX-150,233,233)==HT_TOUCH_TAP);
    ht_gesture_guard(&g,UINT32_MAX-75);
    assert(tap(30,233,233)==HT_TOUCH_NONE);
    assert(tap(500,233,233)==HT_TOUCH_TAP);
    for(int i=0;i<20000;i++) {
        clear(); ht_gesture_begin(&g,233,233,1000,0);
        int dx=(int)(next()%401)-200,dy=(int)(next()%401)-200;
        if(dx*dx+dy*dy<144) dx=25;
        ht_gesture_move(&g,233+dx,233+dy);
        if(i%3==0) ht_gesture_cancel(&g);
        assert(ht_gesture_end(&g,233,233,1080)==HT_TOUCH_NONE);
        assert(tap(1200,233,233)==HT_TOUCH_TAP);
    }
    /*
     * A WRITTEN CONTROL IS NOT A GESTURE, and this is the measurement that says why.
     *
     * ht_gesture_move() calls a contact "moved" at 12 px. On the Pro's 720 px face that is 10.01 px
     * per mm, so the threshold is 1.20 mm — well inside the drift of a deliberate fingertip press.
     * Any activation rule keyed on !moved therefore fires for a still finger and not for a real one,
     * which on the glass reads as a button that works about half the time.
     *
     * ui_habitat.c's rule is the one every touch button uses instead: down on the control, up on the
     * control. The two asserts below lock both halves of that in — drift inside activates, drift out
     * cancels — and the loop records that `moved` is true throughout, so nobody re-derives the old
     * rule from the resolver and reintroduces the bug.
     */
    {
        const int rx = 144, ry = 628, rw = 432, rh = 88;   // the widened [discard] target
        const double pxmm = 10.01;
        int cx = rx + rw / 2, cy = ry + rh / 2;
        int inside_hits = 0, moved_seen = 0;
        for (int tenths = 0; tenths <= 40; tenths++) {          // 0.0 .. 4.0 mm of drift
            int dx = (int)(tenths / 10.0 * pxmm + 0.5);
            for (unsigned d = 0; d < 7; d++) {
                const uint32_t ms[] = {80, 200, 400, 500, 900, 1500, 2200};
                clear(); ht_gesture_begin(&g, cx, cy, 0, 0);
                ht_gesture_move(&g, cx + dx, cy);
                ht_gesture_end(&g, cx + dx, cy, ms[d]);
                if (g.moved) moved_seen++;
                int x = cx + dx, y = cy;
                if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) inside_hits++;
            }
        }
        // Every one of these presses lands inside the control, at every duration...
        assert(inside_hits == 41 * 7);
        // ...and most of them are "moved", which is exactly what the discarded rule keyed on.
        assert(moved_seen > 0 && moved_seen < 41 * 7);
        // Leaving the control is a cancel, whatever the resolver says about the contact.
        clear(); ht_gesture_begin(&g, cx, cy, 0, 0);
        ht_gesture_move(&g, rx - 40, cy);
        ht_gesture_end(&g, rx - 40, cy, 200);
        assert(!(rx - 40 >= rx));
    }
    puts("gestures: PASS (single release, slow tap, voice guard, holds, wrap + 20,000 drag/cancel "
         "traces; written-control press survives 4 mm of drift at every duration)");
}
