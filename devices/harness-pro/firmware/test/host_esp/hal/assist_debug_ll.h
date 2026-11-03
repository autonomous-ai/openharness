// Host-test stand-in for hal/assist_debug_ll.h: the test records that the bus clock was turned on.
#pragma once
#include <stdbool.h>
void _assist_debug_ll_enable_bus_clock(bool enable);
