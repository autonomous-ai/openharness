#include "board_i2c.h"
#include "board_pins.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdatomic.h>

static const char *TAG = "board_i2c";
static _Atomic(i2c_master_bus_handle_t) s_bus;
static atomic_flag s_initializing = ATOMIC_FLAG_INIT;

i2c_master_bus_handle_t board_i2c_get(void)
{
    i2c_master_bus_handle_t bus = atomic_load_explicit(&s_bus, memory_order_acquire);
    if (bus) return bus;
    // Normal startup creates the bus before any worker exists. If that attempt
    // fails, touch and audio may retry together: only one may allocate port 0.
    // Never hold a critical section while the SDK allocates or waits on hardware.
    int64_t deadline = esp_timer_get_time() + 500000;
    while (atomic_flag_test_and_set_explicit(&s_initializing, memory_order_acquire)) {
        bus = atomic_load_explicit(&s_bus, memory_order_acquire);
        if (bus) return bus;
        if (esp_timer_get_time() >= deadline) return NULL;
        vTaskDelay(1);
    }
    bus = atomic_load_explicit(&s_bus, memory_order_acquire);
    if (bus) {
        atomic_flag_clear_explicit(&s_initializing, memory_order_release);
        return bus;
    }
    i2c_master_bus_config_t cfg = {
        .i2c_port = BSP_I2C_PORT,
        .sda_io_num = BSP_I2C_SDA,
        .scl_io_num = BSP_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&cfg, &bus) != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus init failed");
        bus = NULL;
    } else {
        atomic_store_explicit(&s_bus, bus, memory_order_release);
    }
    atomic_flag_clear_explicit(&s_initializing, memory_order_release);
    return bus;
}
