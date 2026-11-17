// The one I2C bus of the bring-up board (port 1, SDA GPIO7, SCL GPIO8): the touch controller, the ES8311 and the
// display board's MCU. The panel driver (esp_lcd_ota7290b) opens port 1 by itself and reuses a bus that already
// exists there, so app_main brings the bus up before the panel.
#pragma once

#include "driver/i2c_master.h"

// The bus on port 1, whoever created it; created here when nobody has. NULL when it would not come up (logged): a
// later call tries again.
i2c_master_bus_handle_t max_i2c_bus(void);
