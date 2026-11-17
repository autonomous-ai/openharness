#include "max_i2c.h"

#include "pins_max.h"

#include "esp_log.h"

i2c_master_bus_handle_t max_i2c_bus(void)
{
    i2c_master_bus_handle_t bus = NULL;
    if (i2c_master_get_bus_handle(MAX_I2C_PORT, &bus) == ESP_OK) return bus;
    // app_main makes the first call, before any task that uses the bus exists. A later caller only gets here when
    // that call failed; two of them racing lose one attempt (the port refuses the second) and try again next time.
    const i2c_master_bus_config_t cfg = {
        .i2c_port = MAX_I2C_PORT,
        .sda_io_num = MAX_I2C_SDA,
        .scl_io_num = MAX_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&cfg, &bus) != ESP_OK) {
        ESP_LOGE("max_i2c", "I2C bus %d (SDA %d, SCL %d) did not come up", MAX_I2C_PORT, MAX_I2C_SDA, MAX_I2C_SCL);
        return NULL;
    }
    return bus;
}
