// The chip revision on Linux (esp/esp.c): 0. fw_update.c reads it only for an accepted image, which Linux never has.
#pragma once

#include <stdint.h>

uint32_t efuse_hal_chip_revision(void);
