.PHONY: check runtime build vm
check:
	python3 -m unittest discover -s tests -p 'test_*.py' -v
	python3 tools/check.py
runtime:
	bash tools/build-runtime.sh
build:
	sudo bash build.sh
vm:
	python3 tests/vm.py --iso $(ISO) --firmware $(or $(FIRMWARE),bios)
