#include "max_turn_ppa.h"

#include <stdatomic.h>

#include "max_turn.h"

#include "driver/ppa.h"
#include "esp_attr.h"

_Static_assert(MAX_TURN_CCW_DEGREES == 90 || MAX_TURN_CCW_DEGREES == 270, "the turn is a quarter either way");

static ppa_client_handle_t s_srm[MAX_TURN_PPA_LANES];
static atomic_int s_queued;   // every lane's queued turns that have not landed

// A turn has landed. A blocking one (no semaphore) is waited for by the driver itself.
static bool IRAM_ATTR landed(ppa_client_handle_t client, ppa_event_data_t *event, void *done)
{
    (void)client;
    (void)event;
    if (!done) return false;
    atomic_fetch_sub(&s_queued, 1);
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR((SemaphoreHandle_t)done, &woken);
    return woken == pdTRUE;
}

esp_err_t max_turn_ppa_open(void)
{
    const ppa_client_config_t config = {.oper_type = PPA_OPERATION_SRM, .max_pending_trans_num = 2};
    const ppa_event_callbacks_t callbacks = {.on_trans_done = landed};
    for (int lane = 0; lane < MAX_TURN_PPA_LANES; lane++) {
        if (s_srm[lane]) continue;
        esp_err_t err = ppa_register_client(&config, &s_srm[lane]);
        if (err == ESP_OK) err = ppa_client_register_event_callbacks(s_srm[lane], &callbacks);
        if (err != ESP_OK) return err;
    }
    return ESP_OK;
}

esp_err_t max_turn_ppa_into(int lane, const uint16_t *src, int w, int h, uint16_t *pic, int pic_w, int pic_h,
                            size_t pic_bytes, int x, int y, SemaphoreHandle_t done)
{
    if (lane < 0 || lane >= MAX_TURN_PPA_LANES || !s_srm[lane] || w <= 0 || h <= 0) return ESP_ERR_INVALID_STATE;
    const ppa_srm_oper_config_t op = {
        .in = {.buffer = src, .pic_w = (uint32_t)w, .pic_h = (uint32_t)h, .block_w = (uint32_t)w, .block_h = (uint32_t)h,
               .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .out = {.buffer = pic, .buffer_size = (uint32_t)pic_bytes, .pic_w = (uint32_t)pic_w, .pic_h = (uint32_t)pic_h,
                .block_offset_x = (uint32_t)x, .block_offset_y = (uint32_t)y, .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .rotation_angle = MAX_TURN_CCW_DEGREES == 270 ? PPA_SRM_ROTATION_ANGLE_270 : PPA_SRM_ROTATION_ANGLE_90,
        .scale_x = 1.0f,
        .scale_y = 1.0f,
        .mode = done ? PPA_TRANS_MODE_NON_BLOCKING : PPA_TRANS_MODE_BLOCKING,
        .user_data = done,
    };
    if (done) atomic_fetch_add(&s_queued, 1);   // first: the turn may land before the call returns
    const esp_err_t err = ppa_do_scale_rotate_mirror(s_srm[lane], &op);
    if (err != ESP_OK && done) atomic_fetch_sub(&s_queued, 1);
    return err;
}

int max_turn_ppa_queued(void) { return atomic_load(&s_queued); }

esp_err_t max_turn_ppa(const uint16_t *src, int w, int h, uint16_t *dst, size_t dst_bytes)
{
    return max_turn_ppa_into(0, src, w, h, dst, h, w, dst_bytes, 0, 0, NULL);
}
