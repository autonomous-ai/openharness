#include "runtime.h"
#include "touch.h"
#include "display.h"
#include "board.h"
#include "board_pins.h"
#include "board_i2c.h"
#include "driver/i2c_master.h"
#include "esp_lcd_panel_io.h"
#if defined(CONFIG_IDF_TARGET_ESP32P4)
// The Pro's controller is opened by ui/touch_gt911.c behind touch_ctrl.h — the interface that already
// existed for this exact split, and the same one the LVGL renderer uses. GT911 is polled rather than
// interrupt-driven (int_gpio_num = GPIO_NUM_NC there), which this task was already built for: the IRQ
// below only ever shortened the wait, it was never what produced a sample.
#include "touch_ctrl.h"
#else
#include "esp_lcd_touch_cst816s.h"
#include "esp_lcd_touch_cst9217.h"
#endif
#include "esp_timer.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <assert.h>
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
#include "pro_contacts.h"
_Static_assert(CONFIG_ESP_LCD_TOUCH_MAX_POINTS >= PRO_CONTACTS_MAX,
               "Pro must observe all GT911 contacts to reject extra fingers safely");
#endif
static esp_lcd_touch_handle_t controller;
static esp_lcd_panel_io_handle_t io;
static TaskHandle_t touch_task_handle;
static atomic_uint presses, failures, inferred, last_press;
static atomic_bool held, controller_ready;
#if !defined(CONFIG_IDF_TARGET_ESP32P4)
static void touch_irq(esp_lcd_touch_handle_t tp)
{
    (void)tp;
    BaseType_t wake = pdFALSE;
    if (touch_task_handle)
        vTaskNotifyGiveFromISR(touch_task_handle, &wake);
    if (wake)
        portYIELD_FROM_ISR();
}
#endif
#if defined(CONFIG_IDF_TARGET_ESP32P4)
static bool open_touch(void)
{
    if (!touch_ctrl_open(&io, &controller)) {
        controller = NULL;
        io = NULL;
        return false;
    }
    atomic_store(&controller_ready, true);
    return true;
}
#else
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
#endif
static void task(void *arg)
{
    (void)arg;
    bool prev = false, swallow = false;
    unsigned errors = 0;
    int64_t retry_at = 0;
#if !defined(CONFIG_IDF_TARGET_ESP32P4)
    int64_t last_good = 0;
#endif
    uint16_t last_x = 0, last_y = 0;
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
    pro_contacts_t contacts = {0};
#endif
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
        uint16_t x = last_x, y = last_y;
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
        pro_contact_t points[PRO_CONTACTS_MAX] = {0};
#else
        uint16_t strength = 0;
#endif
        uint8_t count = 0;
        bool down = false, trusted = true, invalidate = true;
        esp_err_t rc = esp_lcd_touch_read_data(controller);
        if (rc == ESP_OK) {
            errors = 0;
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
            esp_lcd_touch_point_data_t data[PRO_CONTACTS_MAX] = {0};
            trusted = esp_lcd_touch_get_data(controller, data, &count, PRO_CONTACTS_MAX) == ESP_OK &&
                      count <= PRO_CONTACTS_MAX;
            for (unsigned i = 0; trusted && i < count; i++) {
                points[i] = (pro_contact_t){data[i].x, data[i].y, data[i].track_id};
                if (data[i].x >= HT_WIDTH || data[i].y >= HT_HEIGHT) trusted = false;
                for (unsigned j = 0; j < i; j++)
                    if (data[i].track_id == data[j].track_id) trusted = false;
            }
            down = trusted && count > 0;
            if (down) { x = points[0].x; y = points[0].y; }
#else
            down = esp_lcd_touch_get_coordinates(controller, &x, &y, &strength, &count, 1) &&
                   count > 0;
#endif
            // A malformed controller coordinate must never become an action or a swipe.
            if (down && (x >= HT_WIDTH || y >= HT_HEIGHT)) {
                down = false;
                trusted = false;
            }
            if (down) {
#if !defined(CONFIG_IDF_TARGET_ESP32P4)
                last_good = now;
#endif
                last_x = x;
                last_y = y;
            }
#if !defined(CONFIG_IDF_TARGET_ESP32P4)
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
#endif
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
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
            if (swallow) pro_contacts_block(&contacts);
#endif
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
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
                pro_contact_result_t event = pro_contacts_sample(&contacts, points, count,
                                                                 (uint32_t)(now / 1000));
                switch (event.event) {
                case PRO_CONTACT_PASS: habitat_touch(down, x, y, (uint32_t)(now / 1000)); break;
                case PRO_CONTACT_CANCEL: habitat_touch_cancel(); break;
                case PRO_CONTACT_BEGIN:
                    if (!habitat_workspace_gesture_begin()) pro_contacts_block(&contacts);
                    break;
                case PRO_CONTACT_END: habitat_workspace_gesture_end(event.step); break;
                case PRO_CONTACT_NONE: break;
                }
#else
                habitat_touch(down, x, y, (uint32_t)(now / 1000));
#endif
            }
            display_unlock();
        }
#if defined(CONFIG_IDF_TARGET_ESP32P4) && defined(DEVICE_PRO_COMPANION)
        // A wake/error/sleep quarantine belongs to the whole physical contact,
        // even if a controller reset temporarily lost the previous count.
        if (swallow) pro_contacts_block(&contacts);
        if (!down && trusted) (void)pro_contacts_sample(&contacts, NULL, 0, (uint32_t)(now / 1000));
#endif
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
#ifdef DEVICE_PRO_COMPANION
    const unsigned touch_stack = 10240;
#else
    const unsigned touch_stack = 4096;
#endif
    assert(xTaskCreatePinnedToCore(task, "habitat_touch", touch_stack, NULL, 7, &touch_task_handle, 1) ==
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
