// Host-test stand-in for hal/efuse_hal.h (test_fw_update.c sets the revision).
#pragma once
#include <stdint.h>
uint32_t efuse_hal_chip_revision(void);
