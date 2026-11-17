// The panic handler's printers, which last_words.c's backtrace hook calls; on Linux to stderr (the hook itself is
// never called: a Linux crash is the kernel's).
#pragma once

void panic_print_str(const char *str);
void panic_print_hex(int value);
