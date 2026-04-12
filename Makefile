CMAKE := /usr/bin/cmake
BUILD_DIR := build

.PHONY: all modern legacy debug release clean clean-libs clean-js rebuild

all: release

release:
	$(CMAKE) -S . -B $(BUILD_DIR) -D$(CMAKE)_BUILD_TYPE=Release
	$(CMAKE) --build $(BUILD_DIR) -j

debug:
	$(CMAKE) -S . -B $(BUILD_DIR) -D$(CMAKE)_BUILD_TYPE=Debug
	$(CMAKE) --build $(BUILD_DIR) -j

modern: release
	$(CMAKE) --build $(BUILD_DIR) --target libass_modern_min libass_modern_debug -j

legacy: release
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

rebuild: clean all