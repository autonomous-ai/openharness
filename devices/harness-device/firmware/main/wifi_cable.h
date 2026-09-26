// CoreS3 LAN cable: same frames as USB, one TCP client, only after USB pairing.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WIFI_CABLE_PORT 17420

void wifi_cable_on_sta_up(void);
void wifi_cable_on_sta_down(void);
void wifi_cable_drop(void);
bool wifi_cable_client(void);
bool wifi_cable_write(const uint8_t *data, size_t n);
