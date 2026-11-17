// What the cable reaches on Linux, chosen at run time, before pro_cable_start: the scripted demo daemon (main/demo),
// or a real daemon over TCP carrying the cable's byte stream, framed as on USB. cable_linux.c implements the Pro's
// cable/cable_link.h over either.
#pragma once

#define CABLE_LINUX_PORT 7531   // the daemon's HARNESS_CABLE_TCP=host:7531

// The default: the fake daemon runs inside this program, on the link's reader thread.
void cable_linux_use_demo(void);

// Listen on `port` (every address, IPv4 and IPv6) for one daemon at a time; a new connection replaces the old one.
// Development only: whoever reaches the port is the cable, and the cable is the authorization.
void cable_linux_use_tcp(int port);
