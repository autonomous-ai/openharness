/* Pro supply policy. The Pro is a dock-only USB device: the battery supply stays disabled. */
#include "power.h"
#include "board_pins.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"

static const char *TAG = "power";
static bool s_ready;

void power_hold_init(void)
{
    // Q9/Q6 gate the battery boost supply; USB powers VCC5V independently.
    // Preload before enabling output so the dock-only build never asserts it.
    ESP_ERROR_CHECK(gpio_set_level(BSP_PWR_HOLD, 0));
    // GPIO1 is also an LP/RTC pad. Take digital ownership explicitly rather
    // than only changing the HP direction and inheriting its boot mux state.
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << BSP_PWR_HOLD,
        .mode = GPIO_MODE_INPUT_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
}

bool power_init(void)
{
    if (!s_ready) {
        ESP_LOGI(TAG, "dock-only power; battery latch GPIO%d=%d",
                 BSP_PWR_HOLD, gpio_get_level(BSP_PWR_HOLD));
        s_ready = true;
    }
    return true;
}

// No cell, charger polling or battery ADC allocation in the dock-only build.
int power_battery_pct(void) { return -1; }
bool power_is_charging(void) { return false; }
bool power_is_on_external(void) { return true; }
