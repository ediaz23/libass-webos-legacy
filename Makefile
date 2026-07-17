CMAKE := /usr/bin/cmake
BUILD_DIR := build

.PHONY: modern legacy configure-modern configure-legacy clean clean-libs clean-js rebuild-modern rebuild-legacy

configure-modern:
	$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release -DTARGET_MODE=modern

configure-legacy:
	$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release -DTARGET_MODE=legacy

modern: configure-modern
	$(CMAKE) --build $(BUILD_DIR) --target libass_modern_min libass_modern_debug -j

legacy: configure-legacy
	$(CMAKE) --build $(BUILD_DIR) --target libass_legacy_min libass_legacy_debug -j

clean:
	rm -rf $(BUILD_DIR)
	rm -rf build/js
	rm -rf build/libraries

clean-libs:
	rm -rf build/libraries
	rm -rf $(BUILD_DIR)/_deps_build
	rm -rf $(BUILD_DIR)/_meta

clean-js:
	rm -rf build/js

rebuild-modern: clean modern
rebuild-legacy: clean legacy
