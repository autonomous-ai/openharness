# Greenhouse sensor firmware

Reads temperature and soil moisture and reports them over MQTT once a minute. The board runs a JavaScript
interpreter; `make` packs `src/` into `build/firmware.bin`.

```
make            # build/firmware.bin
make flash      # build, then write it to the board with flashtool
make clean
```

Device settings (Wi-Fi, MQTT) live in `src/config.js`.
