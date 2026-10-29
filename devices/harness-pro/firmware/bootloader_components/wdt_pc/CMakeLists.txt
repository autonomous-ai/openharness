# The bootloader half of wdt_pc.h: save each core's last PC and SP after a watchdog reset, before the bootloader
# re-arms the recorder. IDF links bootloader_components/ into the bootloader build by itself.
idf_component_register(SRCS "wdt_pc.c"
                       PRIV_INCLUDE_DIRS "../../main/sys"
                       PRIV_REQUIRES hal soc esp_rom)
