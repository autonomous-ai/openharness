#include "command_face.h"
#include <string.h>

const ht_rect_t ht_command_targets[4] = {
    {93, 78, 280, 66}, {57, 161, 352, 118}, {93, 298, 280, 66}, {113, 369, 240, 60}
};
static void centered(ht_scene_t *scene, int y, int width, const ht_font_t *font,
                     uint16_t fg, uint16_t bg, const char *text)
{
    const char *p = text ? text : "";
    int cells = 0;
    while (*p) { ht_utf8_next(&p); cells++; }
    if (cells * font->width > width) cells = width / font->width;
    ht_text(scene, (HT_WIDTH - cells * font->width) / 2, y, cells * font->width,
            font, fg, bg, text ? text : "");
}
void ht_command_face(ht_scene_t *scene, const ht_command_face_t *face)
{
    centered(scene, 97, 280, &ht_mono_20, face->foreground,
             face->pressed == 0 ? face->selection : scene->background, face->heading);
    const char *subject = face->subject ? face->subject : "";
    bool one = ht_can_display(subject, &ht_mono_20, 340, 1);
    int start = scene->count;
    ht_wrap(scene, 63, one ? 192 : 171, 340, 2, 0, &ht_mono_20, face->foreground, subject);
    // One text size throughout; long task names wrap before showing continuation.
    if (!ht_can_display(subject, &ht_mono_20, 340, 2) && scene->count > start) {
        ht_run_t *last = &scene->runs[scene->count - 1];
        char *p = last->text;
        int cells = 0;
        while (*p && cells < 340 / ht_mono_20.width - 3) { const char *next = p; ht_utf8_next(&next); p = (char *)next; cells++; }
        strcpy(p, "...");
    }
    for (int i = start; i < scene->count; i++) {
        ht_run_t *r = &scene->runs[i];
        const char *p = r->text;
        int cells = 0;
        while (*p) { ht_utf8_next(&p); cells++; }
        r->w = cells * r->font->width;
        r->x = (HT_WIDTH - r->w) / 2;
        if (face->pressed == 1) r->bg = face->selection;
    }
    centered(scene, 257, 320, &ht_mono_20, face->dim, scene->background, face->context);
    centered(scene, 315, 280, &ht_mono_20, face->enabled ? face->accent : face->dim,
             face->pressed == 2 ? face->selection : scene->background, face->primary);
    centered(scene, 386, 240, &ht_mono_20, face->foreground,
             face->pressed == 3 ? face->selection : scene->background, face->secondary);
}
