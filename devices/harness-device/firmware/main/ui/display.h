// Display bring-up: CO5300 AMOLED over QSPI + LVGL v9 port.
#pragma once

#include "lvgl.h"

#include <stdbool.h>
#include <stdint.h>

// Initialize the QSPI bus, CO5300 panel and LVGL, add the PSRAM object pool,
// allocate internal-DMA draw buffers, and spawn the handler task.
void display_init(void);
// Minimal display for the dedicated OTA boot mode (small draw buffers, no touch) — leaves internal RAM
// for the big WiFi RX buffers. Pair with ui_ota_boot_show / ui_ota_boot_pct.
void display_init_ota(void);

// Set the AMOLED brightness (CO5300 DCS 0x51): 0x00 = dimmest, 0xFF = max. Applied live.
void display_set_brightness(uint8_t level);

// Lock/unlock the LVGL mutex. ANY code that touches LVGL objects from outside
// the LVGL task (e.g. the WiFi/WS tasks via ui_screens.c) must hold this.
// `display_lock()` carries the caller's name so a wait past 2s can be logged with who is waiting and
// who is holding — see display_lock_at. The macro keeps every call site as it was.
void display_lock_at(const char *who);
#define display_lock() display_lock_at(__func__)
void display_unlock(void);

// Idle battery-save: turn the AMOLED panel off / back on. `display_wake()` repaints the current
// screen and re-arms the idle timer. Call sites run on the LVGL task (idle check + touch wake).
void display_sleep(void);
void display_wake(void);
bool display_is_asleep(void);
// Register a power hook: cb(false) fires on sleep, cb(true) on wake. Used by the UI screen-lock to arm
// re-lock on sleep and show the unlock overlay on wake. Runs under display_lock (recursive).
void display_set_power_cb(void (*cb)(bool on));
// Reset the idle-off timer without a touch — ui_screens calls this while a voice turn is recording/
// uploading/processing (voice uses the PWR key, not the touchscreen, so the screen must not auto-off).
void display_bump_activity(void);

#if defined(DEVICE_BOARD_M5CORES3)
// The 466x466 virtual display. Exposed for the CoreS3 native layer, which has to pause this one's
// refresh before it may paint: two displays, one panel.
lv_display_t *display_virtual_display(void);

// The draw buffers this display already owns, so the native 320x240 display can share them instead of
// allocating a second pair. A 320-wide partial buffer needs strictly less room than the 466-wide one
// here, and internal DMA RAM on this board is down to tens of kilobytes. Safe ONLY while exactly one
// of the two displays is unpaused - see display_cores3_native_activate().
void display_shared_draw_buffers(void **b1, void **b2, uint32_t *bytes);
#endif
