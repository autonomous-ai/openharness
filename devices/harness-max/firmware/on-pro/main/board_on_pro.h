// Harness Max on the desk Harness Pro: the board table (board/board.h, the Max's) and the Pro's own boot duties.
#pragma once

// The Pro's ESP32-C5 is its Wi-Fi coprocessor and this firmware talks over the cable only: its enable is held low so
// it stays in reset, as the Pro's firmware does (board_pro.c).
void board_on_pro_hold_coprocessor(void);
