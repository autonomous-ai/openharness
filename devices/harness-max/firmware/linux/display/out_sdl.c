// The glass in an SDL window: the macOS simulator. The mouse is the finger. SDL scales the glass to the window (its
// logical size), and maps the mouse back, so the window can be any size and keep the glass's shape.
//
// macOS wants the window, the renderer and the events on the main thread: the render task only copies its pixels in
// and, once they make a whole frame, wakes the main loop, which uploads them and presents.
#include "max_output.h"

#include <SDL.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"

static const char *TAG = "sdl";

static SDL_Window *s_window;
static SDL_Renderer *s_renderer;
static SDL_Texture *s_texture;
static int s_w, s_h;
static Uint32 s_wake;   // the user event that tells the main loop there are pixels to show

// The render task's pixels, waiting for the main loop. Under s_mu.
static SDL_mutex *s_mu;
static uint16_t *s_pixels;
static SDL_Rect s_dirty;   // empty: nothing new
static bool s_dark;
static atomic_bool s_wake_queued;

// The finger, from the main loop's mouse events to the touch task's polls. Under s_mu.
static bool s_down, s_inside;
static int s_mx, s_my;

static uint32_t s_shot_at_ms;   // 0: no screenshot asked for
static const char *s_shot_path;

bool max_output_open(int glass_w, int glass_h)
{
    // Audio is SDL's too, and SDL wants to be initialised on the main thread.
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) != 0) {
        ESP_LOGE(TAG, "SDL_Init: %s", SDL_GetError());
        return false;
    }
    s_w = glass_w;
    s_h = glass_h;
    // The largest window of the glass's shape that fits 90% of the screen, at most the glass's own size in points.
    int win_w = glass_w, win_h = glass_h;
    SDL_Rect usable;
    if (SDL_GetDisplayUsableBounds(0, &usable) == 0 && win_w > usable.w * 9 / 10) {
        win_w = usable.w * 9 / 10;
        win_h = glass_h * win_w / glass_w;
    }
    SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "linear");
    s_window = SDL_CreateWindow("Harness Max", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, win_w, win_h,
                                SDL_WINDOW_ALLOW_HIGHDPI | SDL_WINDOW_RESIZABLE);
    s_renderer = s_window ? SDL_CreateRenderer(s_window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_TARGETTEXTURE) : NULL;
    s_texture = s_renderer ? SDL_CreateTexture(s_renderer, SDL_PIXELFORMAT_RGB565, SDL_TEXTUREACCESS_STREAMING, glass_w,
                                               glass_h)
                           : NULL;
    s_pixels = calloc((size_t)glass_w * glass_h, sizeof *s_pixels);
    s_mu = SDL_CreateMutex();
    s_wake = SDL_RegisterEvents(1);
    if (!s_texture || !s_pixels || !s_mu || s_wake == (Uint32)-1) {
        ESP_LOGE(TAG, "no window: %s", SDL_GetError());
        return false;
    }
    SDL_RenderSetLogicalSize(s_renderer, glass_w, glass_h);
    ESP_LOGI(TAG, "window %dx%d for the %dx%d glass", win_w, win_h, glass_w, glass_h);
    return true;
}

void max_output_paint(const uint16_t *glass, int x, int y, int w, int h)
{
    SDL_LockMutex(s_mu);
    for (int r = y; r < y + h; r++) memcpy(&s_pixels[r * s_w + x], &glass[r * s_w + x], (size_t)w * sizeof *glass);
    const SDL_Rect rect = {x, y, w, h};
    if (SDL_RectEmpty(&s_dirty)) s_dirty = rect;
    else SDL_UnionRect(&s_dirty, &rect, &s_dirty);
    SDL_UnlockMutex(s_mu);
}

void max_output_show(void)
{
    if (!atomic_exchange(&s_wake_queued, true)) {
        SDL_Event wake = {.type = s_wake};
        SDL_PushEvent(&wake);   // thread-safe: wakes the main loop
    }
}

void max_output_power(bool on)
{
    SDL_LockMutex(s_mu);
    s_dark = !on;
    s_dirty = (SDL_Rect){0, 0, s_w, s_h};
    SDL_UnlockMutex(s_mu);
    SDL_Event wake = {.type = s_wake};
    SDL_PushEvent(&wake);
}

pro_touch_sample_t max_output_touch(int *x, int *y)
{
    SDL_LockMutex(s_mu);
    const bool down = s_down, inside = s_inside;
    if (x) *x = s_mx;
    if (y) *y = s_my;
    SDL_UnlockMutex(s_mu);
    // A press in the letterbox around the glass is off the glass, as the device's point off its panel.
    return !down ? PRO_TOUCH_NONE : inside ? PRO_TOUCH_ONE : PRO_TOUCH_BAD;
}

// Mouse coordinates arrive in the glass's (the renderer's logical size); outside it they run past its edges.
static void mouse(bool down, int x, int y)
{
    SDL_LockMutex(s_mu);
    s_down = down;
    s_inside = x >= 0 && y >= 0 && x < s_w && y < s_h;
    s_mx = x;
    s_my = y;
    SDL_UnlockMutex(s_mu);
}

static void present(void)
{
    SDL_LockMutex(s_mu);
    const bool dark = s_dark;
    if (!SDL_RectEmpty(&s_dirty)) {
        SDL_UpdateTexture(s_texture, &s_dirty, &s_pixels[s_dirty.y * s_w + s_dirty.x], s_w * (int)sizeof *s_pixels);
        s_dirty = (SDL_Rect){0, 0, 0, 0};
    }
    SDL_UnlockMutex(s_mu);
    SDL_SetRenderDrawColor(s_renderer, 0, 0, 0, 255);
    SDL_RenderClear(s_renderer);
    if (!dark) SDL_RenderCopy(s_renderer, s_texture, NULL, NULL);
    SDL_RenderPresent(s_renderer);
}

// The glass as the renderer draws it, read back from a target of the glass's size, to a BMP.
static void screenshot(void)
{
    SDL_Texture *target = SDL_CreateTexture(s_renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_TARGET, s_w, s_h);
    SDL_Surface *shot = SDL_CreateRGBSurfaceWithFormat(0, s_w, s_h, 32, SDL_PIXELFORMAT_ARGB8888);
    bool ok = target && shot && SDL_SetRenderTarget(s_renderer, target) == 0;
    if (ok) {
        SDL_RenderCopy(s_renderer, s_texture, NULL, NULL);
        ok = SDL_RenderReadPixels(s_renderer, NULL, SDL_PIXELFORMAT_ARGB8888, shot->pixels, shot->pitch) == 0;
        SDL_SetRenderTarget(s_renderer, NULL);
    }
    ok = ok && SDL_SaveBMP(shot, s_shot_path) == 0;
    if (ok) ESP_LOGI(TAG, "screenshot %dx%d: %s", s_w, s_h, s_shot_path);
    else ESP_LOGE(TAG, "screenshot %s failed: %s", s_shot_path, SDL_GetError());
    SDL_FreeSurface(shot);
    if (target) SDL_DestroyTexture(target);
    exit(ok ? EXIT_SUCCESS : EXIT_FAILURE);
}

void max_output_screenshot(uint32_t after_ms, const char *path)
{
    s_shot_at_ms = after_ms ? after_ms : 1;
    s_shot_path = path;
}

void max_output_run(void)
{
    for (;;) {
        SDL_Event ev;
        // The timeout only bounds how late a screenshot is; every change arrives as an event.
        if (SDL_WaitEventTimeout(&ev, 100)) {
            do {
                if (ev.type == SDL_QUIT) exit(EXIT_SUCCESS);
                if (ev.type == s_wake) atomic_store(&s_wake_queued, false);
                if (ev.type == SDL_MOUSEBUTTONDOWN && ev.button.button == SDL_BUTTON_LEFT) mouse(true, ev.button.x, ev.button.y);
                if (ev.type == SDL_MOUSEBUTTONUP && ev.button.button == SDL_BUTTON_LEFT) mouse(false, ev.button.x, ev.button.y);
                if (ev.type == SDL_MOUSEMOTION && (ev.motion.state & SDL_BUTTON_LMASK)) mouse(true, ev.motion.x, ev.motion.y);
            } while (SDL_PollEvent(&ev));
            present();
        }
        if (s_shot_at_ms && SDL_GetTicks() >= s_shot_at_ms) screenshot();
    }
}
