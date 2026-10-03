// The dial's own settings, in NVS.
//
// Local display, sound, gesture, voice-language and screen-lock preferences. Everything this file
// used to hold — the WiFi networks, the backend URL, the device
// token, the SDS provisioning blob, the E2EE identity and its pinned peers, the last-selected machine —
// existed so the device could find a network and prove who it was to a backend. A cable answers both, and
// the account lives on the computer at the other end of it.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CFG_VLANG_MAX 8    // "en" / "vi" + nul, with room

// Open NVS. Call once, early — everything below is a no-op until it has run.
void config_store_init(void);

// Screen brightness, 0..255. The renderer applies it to the OLED panel.
uint8_t config_load_brightness(void);
void    config_save_brightness(uint8_t level);

// Habitat starts muted. The saved preference survives firmware updates.
bool config_load_muted(void);
bool config_save_muted(bool muted);

// Local Habitat experiments: bit 0 = legacy focus face, bit 2 = quiet reactions,
// bit 3 = straight title (default: curved), bit 4 = do not follow the desktop companion.
//
// BIT 1 IS RETIRED, NOT FREE. It was rim scrolling — drag a finger around the bezel — and devices in
// the field still hold it set. A new preference given that bit would inherit their answer, so the
// next one takes bit 4.
uint8_t config_load_habitat_options(void);
bool config_save_habitat_options(uint8_t options);

// Stable character id. Missing values use the image's default; the UI validates ids.
uint8_t config_load_habitat_character(uint8_t fallback);
bool config_save_habitat_character(uint8_t character);

// The voice language the dial captures in. The daemon PROPOSES one from the computer's locale on every
// `welcome`; once the user has picked here, this wins — the person holding the dial may well speak
// something other than the laptop is set to.
void config_load_voicelang(char *out, size_t cap);
void config_save_voicelang(const char *lang);

// Which way a drag on the dial moves the window's scrollback. False (the default, and what every build
// before this one did): the text follows the finger. True: the view does.
bool config_load_scroll_reversed(void);
void config_save_scroll_reversed(bool reversed);

// Which way a horizontal swipe walks the carousel. False (the default): a swipe left goes to the NEXT
// agent in the list. True: it goes to the previous one.
bool config_load_swipe_reversed(void);
void config_save_swipe_reversed(bool reversed);

// Factory reset (BOOT held at power-on, or Settings → Reset): forget all of the above.
bool config_clear_all(void);
