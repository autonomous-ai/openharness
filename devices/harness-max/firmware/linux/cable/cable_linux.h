// What the cable reaches on Linux, chosen at run time, before pro_cable_start: a real daemon over TCP (the default) or
// over USB through a gadget's serial port, both carrying the cable's byte stream framed as on USB, or the scripted demo
// daemon (main/demo). cable_linux.c implements the Pro's cable/cable_link.h over any of them.
#pragma once

#define CABLE_LINUX_PORT 7531                 // the daemon's HARNESS_CABLE_TCP=host:7531
#define CABLE_LINUX_USB_PORT "/dev/ttyGS0"    // the serial port of the gadget orangepi/harness-max-usb makes

// Listen on `port` (every address, IPv4 and IPv6) for one daemon at a time; a new connection replaces the old one.
// Development only: whoever reaches the port is the cable, and the cable is the authorization.
void cable_linux_use_tcp(int port);

// The cable over USB, as on the device: `port` is the serial port of a USB gadget with the Harness devices' ids, so a
// daemon finds it as it finds a Harness Max. The host is there while the gadget is configured, as `udc_state` (a
// /sys/class/udc/<controller>/state file) says; NULL reads the first controller's.
void cable_linux_use_usb(const char *port, const char *udc_state);

// The scripted demo daemon runs inside this program, on the link's reader thread: the bar without a computer.
void cable_linux_use_demo(void);
