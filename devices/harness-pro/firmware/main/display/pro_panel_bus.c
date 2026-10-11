#include "pro_panel_bus.h"

#include "board_pins.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_check.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_st7703.h"
#include "esp_ldo_regulator.h"
#include "esp_log.h"

static const char *TAG = "pro_panel_bus";

#define BL_TIMER   LEDC_TIMER_0
#define BL_CHANNEL LEDC_CHANNEL_0
#define BL_MAX_DUTY ((1 << BSP_LCD_BL_RES_BITS) - 1)

static esp_lcd_panel_io_handle_t s_io;
static esp_lcd_dsi_bus_handle_t  s_bus;
static esp_ldo_channel_handle_t  s_phy_pwr;
static uint8_t                   s_level;

/*
 * Backlight. An AP3032 boost drives the LED string and its feedback pin is what this PWM moves, so the
 * duty is INVERTED — more duty is dimmer. The invert is done by the LEDC peripheral rather than by
 * arithmetic here, so the number in the register reads the same way the number in the code does.
 *
 * This is real dimming: the boost converter is the only thing between the PWM and the light.
 */
void pro_backlight_init(void)
{
    const gpio_config_t en = {
        .pin_bit_mask = 1ULL << BSP_LCD_BL_EN,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&en);
    gpio_set_level(BSP_LCD_BL_EN, 1);

    const ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = BSP_LCD_BL_RES_BITS,
        .timer_num = BL_TIMER,
        .freq_hz = BSP_LCD_BL_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer);

    const ledc_channel_config_t ch = {
        .gpio_num = BSP_LCD_BL_PWM,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = BL_CHANNEL,
        .timer_sel = BL_TIMER,
        .duty = 0,
        .hpoint = 0,
        .flags.output_invert = true,
    };
    ledc_channel_config(&ch);
}

void pro_backlight_set(uint8_t level)
{
    s_level = level;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL, (uint32_t)BL_MAX_DUTY * level / 255u);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL);
}

uint8_t pro_backlight_level(void) { return s_level; }

void pro_backlight_log(void)
{
    ESP_LOGI(TAG, "backlight · BL_EN(GPIO%d)=%d · PWM GPIO%d · duty=%lu/%d · inverted",
             BSP_LCD_BL_EN, gpio_get_level(BSP_LCD_BL_EN), BSP_LCD_BL_PWM,
             (unsigned long)ledc_get_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL), BL_MAX_DUTY);
}

void pro_backlight_enable(bool on)
{
    gpio_set_level(BSP_LCD_BL_EN, on ? 1 : 0);
}

esp_err_t pro_panel_bus_open(esp_lcd_panel_handle_t *out_panel, esp_lcd_dsi_bus_handle_t *out_bus)
{
    ESP_RETURN_ON_FALSE(out_panel, ESP_ERR_INVALID_ARG, TAG, "out_panel");

    /* The DSI PHY runs off an internal LDO, and it has to be up before the bus is created. Getting this
     * wrong does not fail loudly — the bus is created and the panel simply never lights. */
    const esp_ldo_channel_config_t ldo = {
        .chan_id = BSP_LCD_DSI_PHY_LDO_CHAN,
        .voltage_mv = BSP_LCD_DSI_PHY_LDO_MV,
    };
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo, &s_phy_pwr), TAG, "DSI PHY LDO (VO%d) refused",
                        BSP_LCD_DSI_PHY_LDO_CHAN);

    esp_lcd_dsi_bus_config_t bus = ST7703_PANEL_BUS_DSI_2CH_CONFIG();
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus, &s_bus), TAG, "dsi bus");

    esp_lcd_dbi_io_config_t dbi = ST7703_PANEL_IO_DBI_CONFIG();
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(s_bus, &dbi, &s_io), TAG, "dbi io");

    esp_lcd_dpi_panel_config_t dpi = ST7703_720_720_PANEL_60HZ_DPI_CONFIG(LCD_COLOR_PIXEL_FORMAT_RGB565);
    /* ONE framebuffer. The renderer rasterises damage strips and pushes them with draw_bitmap, so the
     * pixels are copied in rather than swapped. Handing the renderer the panel's own buffers instead
     * would save the copy but needs the buffer-switch protocol and its own tear handling. */
    dpi.num_fbs = 1;

    const st7703_vendor_config_t vendor = {
        .mipi_config = { .dsi_bus = s_bus, .dpi_config = &dpi },
    };
    const esp_lcd_panel_dev_config_t dev = {
        .reset_gpio_num = BSP_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = BSP_LCD_BIT_PER_PIXEL,
        .vendor_config = (void *)&vendor,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7703(s_io, &dev, out_panel), TAG, "st7703");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(*out_panel), TAG, "panel reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(*out_panel), TAG, "panel init");
    if (out_bus) *out_bus = s_bus;
    return ESP_OK;
}
