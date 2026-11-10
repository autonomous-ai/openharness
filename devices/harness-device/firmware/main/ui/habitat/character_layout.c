#include "character_layout.h"

uint16_t ht_character_caption_ink(uint16_t fg, uint16_t bg, uint8_t opacity)
{
    unsigned inverse = 255 - opacity;
    unsigned r = (((fg >> 11) * opacity + (bg >> 11) * inverse) + 127) / 255;
    unsigned g = ((((fg >> 5) & 63) * opacity + ((bg >> 5) & 63) * inverse) + 127) / 255;
    unsigned b = (((fg & 31) * opacity + (bg & 31) * inverse) + 127) / 255;
    return (uint16_t)((r << 11) | (g << 5) | b);
}
