// The end of a frame, which the Pro's pro_display.h has no call for: its panel shows each strip as it lands. A
// double-buffered output paints whole frames into the buffer off screen and flips to it, so it needs to know when the
// strips max_present pushed add up to one frame. Each platform's display implements it.
#pragma once

// The strips pushed since the last call are one whole frame: show it. From the render task, after a max_present that
// pushed pixels.
void max_frame_show(void);
