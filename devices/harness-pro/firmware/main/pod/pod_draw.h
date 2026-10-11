#pragma once
// Pod's own run kinds: a cell sprite (with zoom), an anti-aliased ring arc and a vertical gradient and an anti-aliased triangle. They are
// Pro runs (ht_run_t.pro_kind >= POD_KIND_BASE) that ht_pro_raster hands to pod_draw_raster.
#include "pod_types.h"

enum { POD_KIND_BASE = 16, POD_CELL = 16, POD_ARC, POD_GRAD, POD_TRI };

// A dial pet frame at (x, y). zoom is in eighths (8 = 1x, >8 clamps to 1x, 0 draws nothing); the frame pointer
// and zoom live in the run so a new frame changes the picture's bytes.
bool pod_cell(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom8);
// A ring slice: centre, radius and band width in sixteenths of a px, mid +- half degrees anticlockwise from
// 3 o'clock, anti-aliased across the band with hard ends. w16 == 0 adds an empty run that keeps its slot.
bool pod_arc(ht_scene_t *s, int cx16, int cy16, int r16, int w16, int mid_deg, int half_deg, uint16_t ink);
// A top-to-bottom gradient in a rect rounded like ht_pro_rect.
bool pod_grad(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom);
// A filled triangle, vertices in sixteenths of a px (either winding), anti-aliased across a 1 px ramp centred on each
// edge. ink is native RGB565. False (nothing added) for a degenerate triangle or a coordinate beyond +-1023 px.
bool pod_tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink);
// The same with some edges marked inner (bit i = the edge from vertex i to i+1): an inner edge is not anti-aliased
// but bleeds a pixel outward, so two triangles that share it leave no seam (anti-aliasing both sides of a shared
// edge composites to only 75% along it). Use it only for edges that lie inside the figure.
bool pod_tri_inner(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink, unsigned inner);
void pod_draw_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out);
