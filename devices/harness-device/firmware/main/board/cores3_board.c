// M5Stack CoreS3 board bring-up: AW9523B IO expander + AXP2101 power rails.
// See cores3_board.h for what is cross-checked where.
#include "cores3_board.h"

#include "board_pins.h"
#include "board_i2c.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "cores3";

#define AXP2101_ADDR        BSP_AXP2101_I2C_ADDR
#define AXP2101_LDO_ONOFF   0x90    // LDOS ON/OFF control 0
#define AXP2101_ALDO1_VOLT  0x92    // AW88298 speaker amp rail (1.8V)
#define AXP2101_ALDO2_VOLT  0x93    // ES7210 mic ADC rail (3.3V)
#define AXP2101_DLDO1_VOLT  0x99    // LCD backlight
#define AXP_DLDO1_EN        (1 << 7)

static i2c_master_dev_handle_t s_aw;
static i2c_master_dev_handle_t s_axp;

static esp_err_t wr(i2c_master_dev_handle_t dev, uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return dev ? i2c_master_transmit(dev, buf, sizeof buf, pdMS_TO_TICKS(50)) : ESP_FAIL;
}

static int rd(i2c_master_dev_handle_t dev, uint8_t reg)
{
    uint8_t out = 0;
    if (!dev || i2c_master_transmit_receive(dev, &reg, 1, &out, 1, pdMS_TO_TICKS(50)) != ESP_OK) return -1;
    return out;
}

static i2c_master_dev_handle_t dev_add(uint8_t addr)
{
    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) return NULL;
    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = BSP_I2C_FREQ_HZ,
    };
    i2c_master_dev_handle_t dev = NULL;
    if (i2c_master_bus_add_device(bus, &cfg, &dev) != ESP_OK) return NULL;
    return dev;
}

// AW9523B port bit set/clear on the P0/P1 output latches (0x02/0x03).
static void aw_bit(uint8_t out_reg, uint8_t mask, bool on)
{
    int cur = rd(s_aw, out_reg);
    uint8_t v = on ? ((uint8_t)(cur < 0 ? 0 : cur) | mask) : (uint8_t)(cur < 0 ? 0 : cur) & (uint8_t)~mask;
    wr(s_aw, out_reg, v);
}

void cores3_board_power_init(void)
{
    if (s_aw) return;

    // AW9523B: P0 drives the enables (P0_0 touch, P0_2 audio front-end, P0_7 SY7088 boost);
    // P1_1 is the LCD reset and must drive; P1_2 stays an input (touch INT comes through it).
    s_aw = dev_add(BSP_AW9523_I2C_ADDR);
    if (!s_aw) { ESP_LOGE(TAG, "AW9523B @0x%02X not answering — LCD/audio rails stay off", BSP_AW9523_I2C_ADDR); return; }
    wr(s_aw, AW9523_P0_CFG, 0x00);        // P0[7:0] all outputs
    wr(s_aw, AW9523_P1_CFG, 0b11111101);  // P1_1 output, P1_2 (touch INT) input, rest input
    wr(s_aw, AW9523_GCR, 0x10);           // P1 push-pull (P0 keeps its default mode)
    wr(s_aw, AW9523_P0_OUT, 0b10000101);  // boost + touch + audio front-end ON, amp quiet for now
    wr(s_aw, AW9523_P1_OUT, 0x00);        // LCD held in reset until cores3_lcd_reset()

    // AXP2101 rails, per M5Unified's Power.begin for this board. ALDO1 (1.8V) feeds the
    // AW88298, ALDO2 (3.3V) the ES7210; camera (ALDO3) and TF (ALDO4) stay off — this app
    // uses neither. DLDO1 comes up here and is voltage-set by the brightness path.
    s_axp = dev_add(AXP2101_ADDR);
    if (!s_axp) { ESP_LOGE(TAG, "AXP2101 @0x%02X not answering — rails off", AXP2101_ADDR); return; }
    wr(s_axp, AXP2101_LDO_ONOFF, 0xBF);   // ALDO1-4 + BLDO1/2 + DLDO1 enabled
    wr(s_axp, AXP2101_ALDO1_VOLT, 18 - 5);
    wr(s_axp, AXP2101_ALDO2_VOLT, 33 - 5);
    wr(s_axp, 0x94, 0);                   // ALDO3 (camera) off — camera unused by this app
    wr(s_axp, 0x95, 0);                   // ALDO4 (TF card) off — card unused by this app
    wr(s_axp, 0x27, 0x00);                // PWR key: hold 1s / power-off 4s (matches M5Unified)
    wr(s_axp, 0x69, 0x11);                // CHGLED setting
    wr(s_axp, 0x10, 0x30);                // PMU common config
    wr(s_axp, 0x30, 0x0F);                // ADC on (battery voltage)

    ESP_LOGI(TAG, "AW9523B + AXP2101 rails up");
}

void cores3_lcd_reset(void)
{
    cores3_board_power_init();
    if (!s_aw) return;
    aw_bit(AW9523_P1_OUT, 0x02, false);   // P1_1 low
    vTaskDelay(pdMS_TO_TICKS(10));
    aw_bit(AW9523_P1_OUT, 0x02, true);    // out of reset
    vTaskDelay(pdMS_TO_TICKS(120));
}

void cores3_backlight_set(uint8_t level)
{
    cores3_board_power_init();
    if (!s_axp) return;
    if (level == 0) {
        int en = rd(s_axp, AXP2101_LDO_ONOFF);
        wr(s_axp, AXP2101_LDO_ONOFF, (uint8_t)(en < 0 ? 0 : en) & (uint8_t)~AXP_DLDO1_EN);
        return;
    }
    uint8_t reg = (uint8_t)((level + 641) >> 5);   // M5GFX mapping: 255 → reg 28 (3.3V)
    wr(s_axp, AXP2101_DLDO1_VOLT, reg < 28 ? reg : 28);
}

void cores3_audio_rail(bool on)
{
    cores3_board_power_init();
    if (!s_aw) return;
    aw_bit(AW9523_P0_OUT, 0b00000100, on);         // P0_2 audio front-end enable
    if (on) wr(s_axp, AXP2101_ALDO1_VOLT, 18 - 5); // AW88298 rail up
    else wr(s_axp, AXP2101_ALDO1_VOLT, 0);
}

void cores3_es7210_apply_sequence(void)
{
    static const struct { uint8_t reg, val; } SEQ[] = {
        { 0x06, 0x00 }, // DIGITAL_PDN: all ADCs active
        { 0x07, 0x20 }, // ADC_OSR
        { 0x08, 0x10 }, // MODE_CFG
        { 0x09, 0x30 }, // TCT0_CHPINI
        { 0x0A, 0x30 }, // TCT1_CHPINI
        { 0x20, 0x0a }, // ADC34_HPF2
        { 0x21, 0x2a }, // ADC34_HPF1
        { 0x22, 0x0a }, // ADC12_HPF2
        { 0x23, 0x2a }, // ADC12_HPF1
        { 0x02, 0xC1 },
        { 0x04, 0x01 },
        { 0x05, 0x00 },
        { 0x11, 0x60 },
        { 0x40, 0x42 }, // ANALOG_SYS
        { 0x41, 0x70 }, // MICBIAS12
        { 0x42, 0x70 }, // MICBIAS34
        { 0x43, 0x1B }, // MIC1_GAIN
        { 0x44, 0x1B }, // MIC2_GAIN
        { 0x45, 0x00 }, // MIC3_GAIN
        { 0x46, 0x00 }, // MIC4_GAIN
        { 0x4B, 0x00 }, // MIC12_PDN: mics 1/2 powered
        { 0x4C, 0xFF }, // MIC34_PDN: mics 3/4 off (this board has two mics)
        { 0x01, 0x14 }, // CLK_ON_OFF
    };
    if (!s_axp) cores3_board_power_init();
    i2c_master_dev_handle_t es = dev_add(BSP_ES7210_I2C_ADDR);
    if (!es) { ESP_LOGW(TAG, "ES7210 @0x%02X not reachable — mic unconfigured", BSP_ES7210_I2C_ADDR); return; }
    i2c_master_transmit(es, (uint8_t[]){ 0x00, 0xFF }, 2, pdMS_TO_TICKS(50));   // RESET_CTL
    i2c_master_transmit(es, (uint8_t[]){ 0x00, 0x41 }, 2, pdMS_TO_TICKS(50));   // out of reset, clocks on
    for (unsigned i = 0; i < sizeof SEQ / sizeof SEQ[0]; i++)
        wr(es, SEQ[i].reg, SEQ[i].val);
    // The per-open device handle is a one-use add on this bus; removing keeps the census honest.
    i2c_master_bus_rm_device(es);
    ESP_LOGI(TAG, "ES7210 board sequence applied");
}
