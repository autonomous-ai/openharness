// The dial's own settings, in NVS.
//
// Four things, and that is the whole list: screen brightness, the voice language, the screen-lock pattern,
// and nothing else. Everything this file used to hold — the WiFi networks, the backend URL, the device
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

// Screen lock: a 3x3 pattern, stored as a short digit string.
bool config_lock_enabled(void);
bool config_check_lock(const char *pattern);
void config_set_lock(const char *pattern);
void config_clear_lock(void);

// CoreS3 STA credentials. Empty ssid = none saved. The PSK is stored as-is in NVS (same
// namespace as the rest of the dial settings); never logged.
#define CFG_WIFI_SSID_MAX 33
#define CFG_WIFI_PASS_MAX 65
bool config_load_wifi(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap);
void config_save_wifi(const char *ssid, const char *pass);
void config_clear_wifi(void);

// USB-pairing token (64 hex chars). WiFi welcome must present the same value.
#define CFG_BIND_MAX 65
void config_save_bind(const char *hex);
void config_clear_bind(void);
bool config_has_bind(void);
bool config_bind_matches(const char *hex);

// Factory reset (BOOT held at power-on, or Settings → Reset): forget all of the above.
bool config_clear_all(void);
