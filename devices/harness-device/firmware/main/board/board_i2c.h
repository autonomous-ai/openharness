// Shared I2C master bus (SDA=15/SCL=14). Touch (CST9217) and the audio codecs
// (ES7210/ES8311) live on the same bus — there can be only ONE bus handle per port,
// so both must use this. Created lazily on first call.
#pragma once

#include "driver/i2c_master.h"

// Returns the shared bus (creates it once). Safe across concurrent task retries.
// NULL on failure or if another initializer has not finished within 500 ms.
i2c_master_bus_handle_t board_i2c_get(void);
