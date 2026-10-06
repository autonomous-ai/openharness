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

// Screen brightness, 0..100. The dim overlay is applied by the UI; this only remembers the level.
uint8_t config_load_brightness(void);
void    config_save_brightness(uint8_t level);

// Habitat starts muted. The saved preference survives firmware updates.
bool config_load_muted(void);
bool config_save_muted(bool muted);

// Local Habitat experiments: bit 0 = legacy focus face, bit 1 = rim scroll,
// bit 2 = quiet reactions, bit 3 = straight title (default: curved).
uint8_t config_load_habitat_options(void);
bool config_save_habitat_options(uint8_t options);

// Stable character id. Missing values use the image's default; the UI validates ids.
uint8_t config_load_habitat_character(uint8_t fallback);
bool config_save_habitat_character(uint8_t character);
// Opt-in illustrated-art installation: select Tim once, then retain user choices.
bool config_select_illustrated_tim_once(void);

// Pro appearance is one preference: stable daemon id in the low byte, scene
// choice in the high byte. The UI validates both and supplies the migration
// fallback. This key never changes the round dial's character preference.
uint16_t config_load_pro_appearance(uint16_t fallback);
bool config_save_pro_appearance(uint16_t value);
uint8_t config_load_pro_living(uint8_t fallback);
bool config_save_pro_living(uint8_t value);

// The voice language the dial captures in. The daemon PROPOSES one from the computer's locale on every
// `welcome`; once the user has picked here, this wins — the person holding the dial may well speak
// something other than the laptop is set to.
void config_load_voicelang(char *out, size_t cap);
// Pro uses the same en/vi choice for its built-in interface. False means the
// preference was not durably saved; leave a retry available in the picker.
bool config_save_voicelang(const char *lang);

// Which way a drag on the dial moves the window's scrollback. False (the default, and what every build
// before this one did): the text follows the finger. True: the view does.
bool config_load_scroll_reversed(void);
void config_save_scroll_reversed(bool reversed);

// Which way a horizontal swipe walks the carousel. False (the default): a swipe left goes to the NEXT
// agent in the list. True: it goes to the previous one.
bool config_load_swipe_reversed(void);
void config_save_swipe_reversed(bool reversed);

// Screen lock: a 3x3 pattern, stored as a short digit string.
bool config_lock_enabled(void);
bool config_check_lock(const char *pattern);
void config_set_lock(const char *pattern);
void config_clear_lock(void);

// Factory reset (BOOT held at power-on, or Settings → Reset): forget all of the above.
bool config_clear_all(void);

#ifdef DEVICE_PRO_COMPANION
#include "pro_recovery_bookmark.h"
// One metadata-only bookmark. No words, source passage or send permission.
bool config_load_pro_recovery(pro_recovery_bookmark_t *bookmark);
bool config_save_pro_recovery(const pro_recovery_bookmark_t *bookmark);
bool config_clear_pro_recovery(void);
#endif
