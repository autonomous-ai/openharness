/* The Pro side button: tap to go back/stop, hold 0.8 s to toggle the screen.
 * Dock-only firmware never cuts power or parks the button task; a subsequent
 * press must still be seen after any length of hold. What a press does belongs
 * to the app layer, through ptt_set_handlers().
 */
#include "ptt_pro.h"

#include "board_pins.h"
#include "pro_button_filter.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ptt";

#define POLL_MS            20
#define HOLD_SCREEN_MS     800

static ptt_handlers_t s_handlers;

void ptt_set_handlers(const ptt_handlers_t *handlers)
{
    s_handlers = handlers ? *handlers : (ptt_handlers_t){0};
}

static void ptt_task(void *arg)
{
    (void)arg;
    const gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << BSP_PWR_BTN,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));

    int prev = 1;                 /* active low: 1 = up, 0 = pressed */
    int64_t pressed_at = 0;
    bool hold_fired = false;
    pro_button_filter_t filter = {0};
    bool was_noisy = false;

    for (;;) {
        const uint32_t sample_ms = (uint32_t)(esp_timer_get_time() / 1000);
        const int now = !pro_button_sample(&filter, !gpio_get_level(BSP_PWR_BTN), sample_ms);
        if (filter.noisy != was_noisy) {
            ESP_LOGW(TAG, "button input %s", filter.noisy ? "noisy; waiting for stable release" : "stable again");
            was_noisy = filter.noisy;
        }

        if (prev == 1 && now == 0) {                      /* fresh press */
            /* The press edge acts at once — waiting to see whether it becomes a hold would put a delay
             * on the one gesture that is used in a hurry. */
            ESP_LOGI(TAG, "button press");
            if (s_handlers.on_press) s_handlers.on_press();
            pressed_at = esp_timer_get_time();
            hold_fired = false;
        } else if (now == 0) {                            /* still down */
            const int64_t held_ms = (esp_timer_get_time() - pressed_at) / 1000;
            if (!hold_fired && held_ms >= HOLD_SCREEN_MS) {
                hold_fired = true;                        /* once per press */
                ESP_LOGI(TAG, "button hold");
                if (s_handlers.on_hold) s_handlers.on_hold();
            }
        }
        prev = now;

        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

void ptt_start(void)
{
    xTaskCreate(ptt_task, "ptt", 4096, NULL, 5, NULL);
}
