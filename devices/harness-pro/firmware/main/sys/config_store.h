// The device's own settings, in NVS.
//
// Local display, sound and voice-language preferences. Everything this file
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

// Starts muted. The saved preference survives firmware updates.
bool config_load_muted(void);
bool config_save_muted(bool muted);

// The voice language the device captures in. The daemon PROPOSES one from the computer's locale on every
// `welcome`; once the user has picked here, this wins — the person holding the device may well speak
// something other than the laptop is set to.
void config_load_voicelang(char *out, size_t cap);
// Pro uses the same en/vi choice for its built-in interface. False means the
// preference was not durably saved; leave a retry available in the picker.
bool config_save_voicelang(const char *lang);
