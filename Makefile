CMAKE := /usr/bin/cmake
BUILD_DIR := build

.PHONY: modern legacy configure-modern configure-legacy clean clean-libs clean-js rebuild-modern rebuild-legacy dump-flags inspect-wasm

configure-modern:
	$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release -DTARGET_MODE=modern

configure-legacy:
	$(CMAKE) -S . -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release -DTARGET_MODE=legacy

# Show the meson cross-file and the flags each build system actually recorded
# for a representative dep. Run after a full build to verify propagation.
dump-flags:
	@echo '=== meson cross-file (emscripten-cross.ini) ==='
	@cat $(BUILD_DIR)/emscripten-cross.ini 2>/dev/null || echo '(missing — run configure first)'
	@echo
	@echo '=== harfbuzz meson buildoptions (c_args / cpp_args) ==='
	@sed -n 's/.*"name": "c_args".*"value": \(\[[^]]*\]\).*/c_args   = \1/p; s/.*"name": "cpp_args".*"value": \(\[[^]]*\]\).*/cpp_args = \1/p' \
	    $(BUILD_DIR)/_deps_build/harfbuzz_ep/meson-info/intro-buildoptions.json 2>/dev/null \
	    || echo '(harfbuzz build dir missing — did you run a full build?)'
	@echo
	@echo '=== brotli cmake flags (from CMakeCache.txt) ==='
	@grep -E '^CMAKE_C(XX)?_FLAGS(_RELEASE)?:' $(BUILD_DIR)/_deps_build/brotli_ep/CMakeCache.txt 2>/dev/null \
	    || echo '(brotli build dir missing — did you run a full build?)'

modern: configure-modern
	$(CMAKE) --build $(BUILD_DIR) --target libass_modern_min libass_modern_debug -j
	@$(MAKE) --no-print-directory dump-flags

legacy: configure-legacy
	$(CMAKE) --build $(BUILD_DIR) --target libass_legacy_min libass_legacy_debug -j
	@$(MAKE) --no-print-directory dump-flags

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

# List wasm section IDs and sizes. IDs 0-11 are MVP. 12=DataCount, 13=Tag
# (exception handling). Anything > 11 explains why Chromium 68 rejects it.
# Usage: make inspect-wasm WASM=build/js/modern/worker.min.wasm
WASM ?= build/js/modern/worker.min.wasm
inspect-wasm:
	@python3 scripts/inspect-wasm.py $(WASM)
