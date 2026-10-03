#include "runtime.h"
#include "touch.h"
#include "display.h"
#include "board.h"
#include "board_pins.h"
#include "board_i2c.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_cst816s.h"
#include "esp_lcd_touch_cst9217.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <assert.h>
static esp_lcd_touch_handle_t controller;
static esp_lcd_panel_io_handle_t io;
static TaskHandle_t touch_task_handle;
static atomic_uint presses, failures, inferred, last_press;
static atomic_bool held, controller_ready;
static void touch_irq(esp_lcd_touch_handle_t tp)
{
    (void)tp;
    BaseType_t wake = pdFALSE;
    if (touch_task_handle)
        vTaskNotifyGiveFromISR(touch_task_handle, &wake);
    if (wake)
        portYIELD_FROM_ISR();
}
static bool open_touch(void)
{
    const board_t *b = board();
    if (b->touch == TOUCH_NONE)
        return false;
    esp_lcd_panel_io_i2c_config_t c =
        b->touch == TOUCH_CST816S
            ? (esp_lcd_panel_io_i2c_config_t)ESP_LCD_TOUCH_IO_I2C_CST816S_CONFIG()
            : (esp_lcd_panel_io_i2c_config_t)ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
    c.scl_speed_hz = BSP_I2C_FREQ_HZ;
    if (esp_lcd_new_panel_io_i2c(board_i2c_get(), &c, &io) != ESP_OK)
        return false;
    esp_lcd_touch_config_t t = {.x_max = 466,
                                .y_max = 466,
                                .rst_gpio_num = b->touch_rst,
                                .int_gpio_num = BSP_TOUCH_INT,
                                .flags = {.mirror_x = b->touch_mirror, .mirror_y = b->touch_mirror},
                                .interrupt_callback = touch_irq};
    esp_err_t err = b->touch == TOUCH_CST816S ? esp_lcd_touch_new_i2c_cst816s(io, &t, &controller)
                                              : esp_lcd_touch_new_i2c_cst9217(io, &t, &controller);
    if (err != ESP_OK) {
        controller = NULL;
        esp_lcd_panel_io_del(io);
        io = NULL;
        return false;
    }
    atomic_store(&controller_ready, true);
    return true;
}
static void task(void *arg)
{
    (void)arg;
    bool prev = false, swallow = false;
    unsigned errors = 0;
    int64_t last_good = 0, retry_at = 0;
    uint16_t last_x = 0, last_y = 0;
    for (;;) {
        int64_t now = esp_timer_get_time();
        if (!controller) {
            if (now >= retry_at) {
                open_touch();
                retry_at = now + 5000000;
            }
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(100));
            continue;
        }
        uint16_t x = last_x, y = last_y, strength = 0;
        uint8_t count = 0;
        bool down = false, trusted = true, invalidate = true;
        esp_err_t rc = esp_lcd_touch_read_data(controller);
        if (rc == ESP_OK) {
            errors = 0;
            down = esp_lcd_touch_get_coordinates(controller, &x, &y, &strength, &count, 1) &&
                   count > 0;
            // A malformed controller coordinate must never become an action or a swipe.
            if (down && (x >= HT_WIDTH || y >= HT_HEIGHT)) {
                down = false;
                trusted = false;
            }
            if (down) {
                last_good = now;
                last_x = x;
                last_y = y;
            }
        } else if (rc == ESP_ERR_INVALID_RESPONSE && board()->touch == TOUCH_CST9217) {
            trusted = false;
            // This controller also returns stale ACKs while idle. With a previously verified
            // UP there is no contact to infer; ignore that idle sample, without swallowing the
            // next real DOWN. During a contact, however, any missing sample invalidates taps.
            invalidate = prev;
            // Preserve the proven stale-ACK recovery, expressed in time so a faster poll cannot
            // split a touch.
            errors = 0;
            down = prev && now - last_good < 100000;
            if (prev && !down)
                atomic_fetch_add(&inferred, 1);
        } else {
            trusted = false;
            atomic_fetch_add(&failures, 1);
            if (++errors >= 8) {
                atomic_store(&controller_ready, false);
                esp_lcd_touch_del(controller);
                controller = NULL;
                esp_lcd_panel_io_del(io);
                io = NULL;
                retry_at = now + 100000;
                errors = 0;
            }
        }
        if (!trusted && invalidate) {
            // Neither a stale ACK, a malformed coordinate nor a failed read is a tap release.
            // Do not re-arm on the next DOWN from the same still-held finger.
            display_lock();
            habitat_touch_cancel();
            display_unlock();
            swallow = swallow || prev || count > 0;
        }
        if (down && !prev) {
            atomic_fetch_add(&presses, 1);
#ifdef DEVICE_PERF_BENCH
            if (atomic_load(&presses) <= 16) ESP_LOGI("PERF", "touch raw x=%u y=%u", x, y);
#endif
            atomic_store(&last_press, (uint32_t)(now / 1000));
            if (display_is_asleep()) {
                display_lock();
                habitat_touch_cancel();
                display_wake();
                display_unlock();
                swallow = true;
            } else
                habitat_input_stamp(now);
        }
        if (down)
            display_bump_activity();
        if (!swallow && (down || prev)) {
            display_lock();
            // PWR can put the screen to sleep halfway through a contact, even
            // while this task waits for the UI lock. Cancel under that same lock
            // and consume the rest of the contact, including after a PWR wake.
            if (display_is_asleep()) {
                habitat_touch_cancel();
                swallow = true;
            } else {
                habitat_touch(down, x, y, (uint32_t)(now / 1000));
            }
            display_unlock();
        }
        if (!down && trusted)
            swallow = false;
        prev = down;
        atomic_store(&held, down);
        // GPIO wakes immediately. Active samples have a 4ms fallback; idle fallback catches a
        // missed IRQ.
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(down ? 4 : 20));
    }
}
void touch_init(void)
{
    assert(xTaskCreatePinnedToCore(task, "habitat_touch", 4096, NULL, 7, &touch_task_handle, 1) ==
           pdPASS);
}
uint32_t touch_activity_generation(void) { return atomic_load(&presses); }
void touch_stats(touch_stats_t *out)
{
    uint32_t pressed_at = atomic_load(&last_press);
    *out = (touch_stats_t){.presses = atomic_load(&presses),
                           .last_press_ms_ago =
                               (uint32_t)(esp_timer_get_time() / 1000) - pressed_at,
                           .read_failures = atomic_load(&failures),
                           .inferred_releases = atomic_load(&inferred),
                           .controller_ok = atomic_load(&controller_ready),
                           .held_now = atomic_load(&held)};
}
