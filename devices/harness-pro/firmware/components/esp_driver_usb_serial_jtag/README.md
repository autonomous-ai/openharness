# esp_driver_usb_serial_jtag (project override)

A copy of ESP-IDF 5.5.4's `components/esp_driver_usb_serial_jtag` (Apache-2.0, Espressif headers kept; `test_apps/`
dropped). A project component of the same name replaces the IDF one. The only change is two atomic RX counters in the
ISR and `usb_serial_jtag_rx_stats()`: bytes pulled from the hardware FIFO, and ring-buffer pushes that failed. They
tell a loss below the driver (USB) from a loss above it (ring full, framing). Re-copy from IDF when the IDF version moves.
