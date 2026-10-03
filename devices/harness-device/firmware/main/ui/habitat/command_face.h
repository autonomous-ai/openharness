#pragma once
#include "terminal.h"

// Shared by the device and the pixel-exact host preview. One subject, one primary action.
typedef struct {
    const char *heading, *subject, *context, *primary, *secondary;
    uint16_t foreground, dim, accent, selection;
    int pressed; // 0 heading, 1 subject, 2 primary, 3 secondary; -1 none
    bool enabled;
} ht_command_face_t;
extern const ht_rect_t ht_command_targets[4];
void ht_command_face(ht_scene_t *scene, const ht_command_face_t *face);
