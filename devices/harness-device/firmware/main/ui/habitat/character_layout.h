#pragma once
#include "character_types.h"

// The recap is cut to this many codepoints before Focus lays it out.
enum { HT_CHARACTER_RECAP_CHARS = 90 };
// `foreground` over `background` at `opacity` (0..255), per RGB565 channel: the fade of a page or a chevron.
uint16_t ht_character_caption_ink(uint16_t foreground, uint16_t background, uint8_t opacity);
