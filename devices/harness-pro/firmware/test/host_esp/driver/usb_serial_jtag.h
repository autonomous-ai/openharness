// Host-test stand-in for the USB-Serial-JTAG driver header (test_cable_link.c defines the functions).
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
typedef struct { uint32_t tx_buffer_size, rx_buffer_size; } usb_serial_jtag_driver_config_t;
esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *cfg);
esp_err_t usb_serial_jtag_driver_uninstall(void);
int usb_serial_jtag_read_bytes(void *buf, uint32_t length, TickType_t ticks);
int usb_serial_jtag_write_bytes(const void *src, size_t size, TickType_t ticks);
bool usb_serial_jtag_is_connected(void);
void usb_serial_jtag_rx_stats(uint32_t *isr_bytes, uint32_t *ring_drops);
const char *esp_err_to_name(esp_err_t e);
