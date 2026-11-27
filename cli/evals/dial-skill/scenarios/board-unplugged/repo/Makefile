PORT ?= auto
BAUD ?= 921600

build/firmware.bin: package.json tools/pack.js src/config.js src/main.js
	node tools/pack.js src $@

.PHONY: flash clean
flash: build/firmware.bin
	flashtool --port $(PORT) --baud $(BAUD) write 0x10000 build/firmware.bin

clean:
	rm -rf build
