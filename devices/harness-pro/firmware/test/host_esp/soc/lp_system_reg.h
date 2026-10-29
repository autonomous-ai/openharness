// Host-test stand-in: the P4's LP store registers (offsets as in IDF, base made up).
#pragma once
#define DR_REG_LP_SYS_BASE 0x2000u
#define LP_SYSTEM_REG_LP_STORE11_REG (DR_REG_LP_SYS_BASE + 0x58)
#define LP_SYSTEM_REG_LP_STORE12_REG (DR_REG_LP_SYS_BASE + 0x5c)
#define LP_SYSTEM_REG_LP_STORE13_REG (DR_REG_LP_SYS_BASE + 0x60)
#define LP_SYSTEM_REG_LP_STORE14_REG (DR_REG_LP_SYS_BASE + 0x64)
#define LP_SYSTEM_REG_LP_STORE15_REG (DR_REG_LP_SYS_BASE + 0x68)
