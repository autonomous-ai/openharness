// Where things sit on the glass — the one file that differs between a round face and a square one.
//
// ui_screens.c used to carry these itself, and every value in it was a device pixel on a 466 circle.
// That was not a style: a round face eats its own corners, so the numbers were measured against a
// CHORD rather than a margin, and several of them say so in their comments. A square face has no such
// constraint, so the two sets below are re-derived rather than scaled.
//
// WHAT IS NOT HERE: type sizes. The two panels are 10.48 and 10.01 pixels per millimetre — within 5% —
// so a 38px name is the same size against a thumb on both, and the fonts are shared unchanged. Scaling
// type with the resolution would make the Pro read like a tablet held at arm's length.
//
// metrics_round466.h holds exactly what shipped. If a value in it ever changes, that is a change to the
// dial and must be treated as one.
#pragma once

// One board, one face. The fork that chose between this and a 720 square went with the Pro's firmware.
#include "metrics_round466.h"
