#include "max_turn_ppa.h"

#include "max_turn.h"

#include "driver/ppa.h"

_Static_assert(MAX_TURN_CCW_DEGREES == 90 || MAX_TURN_CCW_DEGREES == 270, "the turn is a quarter either way");

static ppa_client_handle_t s_srm;

esp_err_t max_turn_ppa_open(void)
{
    const ppa_client_config_t config = {.oper_type = PPA_OPERATION_SRM};
    return s_srm ? ESP_OK : ppa_register_client(&config, &s_srm);
}

esp_err_t max_turn_ppa(const uint16_t *src, int w, int h, uint16_t *dst, size_t dst_bytes)
{
    if (!s_srm || w <= 0 || h <= 0) return ESP_ERR_INVALID_STATE;
    // Blocking: the strip is the renderer's again, and the band the panel's, when this returns, as after the CPU turn.
    const ppa_srm_oper_config_t op = {
        .in = {.buffer = src, .pic_w = (uint32_t)w, .pic_h = (uint32_t)h, .block_w = (uint32_t)w, .block_h = (uint32_t)h,
               .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .out = {.buffer = dst, .buffer_size = (uint32_t)dst_bytes, .pic_w = (uint32_t)h, .pic_h = (uint32_t)w,
                .srm_cm = PPA_SRM_COLOR_MODE_RGB565},
        .rotation_angle = MAX_TURN_CCW_DEGREES == 270 ? PPA_SRM_ROTATION_ANGLE_270 : PPA_SRM_ROTATION_ANGLE_90,
        .scale_x = 1.0f,
        .scale_y = 1.0f,
        .mode = PPA_TRANS_MODE_BLOCKING,
    };
    return ppa_do_scale_rotate_mirror(s_srm, &op);
}
