// An app image's header, ESP-IDF's layout. fw_update.c reads it only from an accepted image, which Linux never has.
#pragma once

#include <stdint.h>

typedef struct __attribute__((packed)) {
    uint8_t magic, segment_count, spi_mode, spi_speed_size;
    uint32_t entry_addr;
    uint8_t wp_pin, spi_pin_drv[3];
    uint16_t chip_id;
    uint8_t min_chip_rev;
    uint16_t min_chip_rev_full, max_chip_rev_full;
    uint8_t reserved[4], hash_appended;
} esp_image_header_t;
