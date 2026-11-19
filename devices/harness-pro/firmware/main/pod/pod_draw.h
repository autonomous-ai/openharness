#pragma once
// Pod's own run kinds: a cell sprite (with zoom), an anti-aliased ring arc and a vertical gradient and an anti-aliased triangle. They are
// Pro runs (ht_run_t.pro_kind >= POD_KIND_BASE) that ht_pro_raster hands to pod_draw_raster.
#include "pod_types.h"

enum { POD_KIND_BASE = 16, POD_CELL = 16, POD_ARC, POD_GRAD, POD_TRI, POD_VEIL };

// A dial pet frame at (x, y). zoom is in eighths (8 = 1x, 16 = an exact 2x nearest-neighbour scale, 9..15 and >16 clamp to 1x, 0 draws nothing); the frame pointer
// and zoom live in the run so a new frame changes the picture's bytes.
bool pod_cell(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom8);
// pod_cell for a frame whose ground is known: everything under it is the one colour `ground` (native RGB565) and stays so until it is drawn (what is
// drawn after it may overlap). A zoom below 1x is then resampled once onto that colour and kept (pod_draw.c, "baked cells"); the pixels are those
// the resampler would write, so the picture does not change, only how often it is worked out. From 1x on this is pod_cell.
// The same at a zoom in sixteenths: 1..15 below 1x (an even count is the eighths' run exactly), 16 is 1x, 32 a 2x, anything else above 1x is 1x. An hd
// pet (a frame stored at the size it is shown) lands between the eighths here.
bool pod_cell16(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom16);
bool pod_cell_flat16(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom16, uint16_t ground);
bool pod_cell_flat(ht_scene_t *s, int x, int y, const ht_cell_frame_t *f, unsigned zoom8, uint16_t ground);
// Test hooks: forget every baked frame; how many were baked since; the pixels they hold.
void pod_cell_bake_reset(void);
unsigned pod_cell_bakes(void);
unsigned pod_cell_bake_px(void);
// A ring slice: centre, radius and band width in sixteenths of a px, mid +- half degrees anticlockwise from
// 3 o'clock, anti-aliased across the band with hard ends. w16 == 0 adds an empty run that keeps its slot.
bool pod_arc(ht_scene_t *s, int cx16, int cy16, int r16, int w16, int mid_deg, int half_deg, uint16_t ink);
// A top-to-bottom gradient in a rect rounded like ht_pro_rect.
bool pod_grad(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom);
// The same with anti-aliased corners (the coverage of ht_pro_rect_aa), blended onto what is under them. One run.
void pod_grad_aa(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom);
// Pets Home cards: pod_grad_aa with the colour steps dithered (4 x 4 Bayer between the two nearest RGB565 levels per channel), so a slow
// gradient reads smooth instead of in horizontal bands. Costs a little more per pixel than pod_grad_aa.
void pod_grad_aa_dither(ht_scene_t *s, int x, int y, int w, int h, int radius, uint16_t top, uint16_t bottom);
// A filled triangle, vertices in sixteenths of a px (either winding), anti-aliased across a 1 px ramp centred on each
// edge. ink is native RGB565. False (nothing added) for a degenerate triangle or a coordinate beyond +-1023 px.
bool pod_tri(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink);
// The same with some edges marked inner (bit i = the edge from vertex i to i+1): an inner edge is not anti-aliased
// but bleeds a pixel outward, so two triangles that share it leave no seam (anti-aliasing both sides of a shared
// edge composites to only 75% along it). Use it only for edges that lie inside the figure.
bool pod_tri_inner(ht_scene_t *s, int x0, int y0, int x1, int y1, int x2, int y2, uint16_t ink, unsigned inner);
// A veil over what is already drawn in the rect, to clip and fade a neighbour peeking in at a card's edge: the part on the card's side of the line
// x = edge (the left of it when inside_left, else the right) is mixed `k` of 255 toward the card's vertical gradient (top at row gy0, bottom gh rows
// further down), the rest is painted `bg`, which clips whatever spilled past the card. One run; the rect's rows must be clear of the card's corners.
void pod_veil(ht_scene_t *s, int x, int y, int w, int h, int edge, bool inside_left, int gy0, int gh, uint16_t top, uint16_t bottom, uint16_t bg, unsigned k);
void pod_draw_raster(const ht_run_t *r, ht_rect_t clip, uint16_t *out);
