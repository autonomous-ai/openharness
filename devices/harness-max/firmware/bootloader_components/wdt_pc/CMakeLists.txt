# The Pro's bootloader hook, compiled where it is: save each core's last PC and SP after a watchdog reset
# (main/sys/wdt_pc.h). The bootloader build only looks in THIS project's bootloader_components/, so the Max needs this
# directory; the source stays the Pro's.
set(pro_fw ${CMAKE_CURRENT_LIST_DIR}/../../../../harness-pro/firmware)
idf_component_register(SRCS "${pro_fw}/bootloader_components/wdt_pc/wdt_pc.c"
                       PRIV_INCLUDE_DIRS "${pro_fw}/main/sys"
                       PRIV_REQUIRES hal soc esp_rom)
