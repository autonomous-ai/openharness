// Host-test stand-in for the USB-Serial-JTAG PHY pull override (test_cable_link.c defines the functions).
#pragma once
#include <stdbool.h>
typedef struct { bool dp_pu, dm_pu, dp_pd, dm_pd; } usb_serial_jtag_pull_override_vals_t;
void usb_serial_jtag_ll_phy_enable_pull_override(const usb_serial_jtag_pull_override_vals_t *vals);
void usb_serial_jtag_ll_phy_disable_pull_override(void);
