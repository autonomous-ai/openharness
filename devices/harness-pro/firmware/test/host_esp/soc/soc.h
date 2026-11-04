// Host-test stand-in for soc/soc.h: register access goes to the test's register file.
#pragma once
#include <stdint.h>
uint32_t host_reg_read(uint32_t addr);
void host_reg_write(uint32_t addr, uint32_t value);
#define REG_READ(addr) host_reg_read((uint32_t)(addr))
#define REG_WRITE(addr, value) host_reg_write((uint32_t)(addr), (uint32_t)(value))
