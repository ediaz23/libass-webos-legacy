cmake_minimum_required(VERSION 3.16)
project(webos_libass_wasm LANGUAGES C CXX)

include(ExternalProject)

# ===== Layout =====
set(DEPS_DIR                "${CMAKE_SOURCE_DIR}/lib")
set(SRC_DIR                 "${CMAKE_SOURCE_DIR}/src")
set(SUPERBUILD_DIR    "${CMAKE_BINARY_DIR}/_deps_build")
set(PREFIX_DIR            "${CMAKE_SOURCE_DIR}/build/libraries")
set(DIST_JS_DIR         "${CMAKE_SOURCE_DIR}/build/js")
set(EP_META_DIR         "${CMAKE_BINARY_DIR}/_meta")

file(MAKE_DIRECTORY "${SUPERBUILD_DIR}")
file(MAKE_DIRECTORY "${EP_META_DIR}")
file(MAKE_DIRECTORY "${PREFIX_DIR}")
file(MAKE_DIRECTORY "${DIST_JS_DIR}")
file(MAKE_DIRECTORY "${DIST_JS_DIR}/modern")
file(MAKE_DIRECTORY "${DIST_JS_DIR}/legacy")

# ===== Tools =====
find_program(PKG_CONFIG_EXECUTABLE pkg-config REQUIRED)
find_program(MESON_EXECUTABLE meson REQUIRED)
find_program(NINJA_EXECUTABLE ninja REQUIRED)
find_program(EMCC_EXECUTABLE emcc REQUIRED)

# ===== Emscripten toolchain detection =====
if(NOT DEFINED ENV{EMSDK})
    message(FATAL_ERROR "EMSDK env var not set. This project must be built inside the emscripten/emsdk container.")
endif()

set(EMSCRIPTEN_CMAKE_TOOLCHAIN "$ENV{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
if(NOT EXISTS "${EMSCRIPTEN_CMAKE_TOOLCHAIN}")
    message(FATAL_ERROR "Emscripten CMake toolchain not found at: ${EMSCRIPTEN_CMAKE_TOOLCHAIN}")
endif()

# ===== Dep compile flags =====
# Shared flags for every dep. Verified with `make inspect-wasm`: removing any
# of the -mno-* or -fno-exceptions triggers a post-MVP section (DataCount /
# Tag / etc.) that Chromium 68 rejects at load time. MIN_CHROME_VERSION on
# the final link doesn't rewrite already-emitted .o files.
set(WASM_COMMON_FLAGS
    -O3
    -flto                         # link-time optimization across dep .o files
    -fno-exceptions               # avoids Tag section (ID 13)
    -mno-bulk-memory              # avoids DataCount section (ID 12)
    -mno-sign-ext                 # forbid post-MVP sign-extension ops
    -mno-nontrapping-fptoint      # forbid non-trapping fp→int conversions
    -mno-reference-types          # forbid externref / funcref
)
set(WASM_CXX_ONLY_FLAGS -fno-rtti)     # no C++ RTTI (saves size, no dynamic_cast)

# CMake-style space-separated strings (for CMAKE_C_FLAGS in ep_cmake).
string(REPLACE ";" " " WASM_C_FLAGS   "${WASM_COMMON_FLAGS}")
set(_wasm_cxx_list ${WASM_CXX_ONLY_FLAGS} ${WASM_COMMON_FLAGS})
string(REPLACE ";" " " WASM_CXX_FLAGS "${_wasm_cxx_list}")

# Meson cross-file — [built-in options] is the meson equivalent of CFLAGS;
# with a cross-file, meson ignores env CFLAGS. Template lives in patches/
# and is expanded by configure_file (@VAR@ substitution).
string(REPLACE ";" "', '" MESON_C_ARGS   "'${WASM_COMMON_FLAGS}'")
string(REPLACE ";" "', '" MESON_CPP_ARGS "'${_wasm_cxx_list}'")
set(MESON_CROSS_FILE "${CMAKE_BINARY_DIR}/emscripten-cross.ini")
configure_file(
    "${CMAKE_SOURCE_DIR}/patches/emscripten-cross.ini.in"
    "${MESON_CROSS_FILE}"
    @ONLY
)

set(_env
    "PKG_CONFIG_PATH=${PREFIX_DIR}/lib/pkgconfig:${PREFIX_DIR}/lib64/pkgconfig"
    "EM_PKG_CONFIG_PATH=${PREFIX_DIR}/lib/pkgconfig:${PREFIX_DIR}/lib64/pkgconfig"
    "CMAKE_PREFIX_PATH=${PREFIX_DIR}"
    "PATH=${PREFIX_DIR}/bin:$ENV{PATH}"
)

# ===== Helpers =====
function(ep_meson name srcdir)
    set(extra_setup_args ${ARGN})
    set(_build_subdir "${SUPERBUILD_DIR}/${name}")

    ExternalProject_Add(${name}
        PREFIX         "${EP_META_DIR}/${name}"
        SOURCE_DIR "${srcdir}"
        BINARY_DIR "${SUPERBUILD_DIR}"
        CONFIGURE_COMMAND
            ${CMAKE_COMMAND} -E rm -rf "${_build_subdir}"
            COMMAND ${CMAKE_COMMAND} -E make_directory "${_build_subdir}"
            COMMAND ${CMAKE_COMMAND} -E env ${_env}
                            ${MESON_EXECUTABLE} setup "${_build_subdir}" "${srcdir}"
                                --cross-file "${MESON_CROSS_FILE}"
                                --prefix "${PREFIX_DIR}"
                                --libdir "lib"
                                --default-library=static
                                --buildtype=release   # meson default is debug (-O0)
                                -Db_lto=true          # link-time optimization
                                ${extra_setup_args}
        BUILD_COMMAND
            ${CMAKE_COMMAND} -E env ${_env}
            ${MESON_EXECUTABLE} compile -C "${_build_subdir}"
        INSTALL_COMMAND
            ${CMAKE_COMMAND} -E env ${_env}
            ${MESON_EXECUTABLE} install -C "${_build_subdir}"
        USES_TERMINAL_BUILD ON
    )
endfunction()

function(ep_cmake name srcdir)
    set(extra_cmake_args ${ARGN})

    ExternalProject_Add(${name}
        PREFIX         "${EP_META_DIR}/${name}"
        SOURCE_DIR "${srcdir}"
        BINARY_DIR "${SUPERBUILD_DIR}/${name}"
        CMAKE_ARGS
            -DCMAKE_TOOLCHAIN_FILE=${EMSCRIPTEN_CMAKE_TOOLCHAIN}
            -DCMAKE_INSTALL_PREFIX=${PREFIX_DIR}
            -DBUILD_SHARED_LIBS=OFF
            -DCMAKE_POSITION_INDEPENDENT_CODE=ON
            -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON
            -DCMAKE_C_FLAGS=${WASM_C_FLAGS}      # cmake ignores env CFLAGS
            -DCMAKE_CXX_FLAGS=${WASM_CXX_FLAGS}
            ${extra_cmake_args}
        BUILD_COMMAND
            ${CMAKE_COMMAND} --build "${SUPERBUILD_DIR}/${name}"
        INSTALL_COMMAND
            ${CMAKE_COMMAND} --install "${SUPERBUILD_DIR}/${name}"
        USES_TERMINAL_BUILD ON
    )
endfunction()

# Apply a patch to a dep's source tree, idempotently. Reads `srcfile` and
# only invokes `patch` if `marker` is missing (patch not applied yet). The
# patch's working directory is the parent of srcfile.
function(apply_patch_if_missing srcfile marker patchfile)
    file(READ "${srcfile}" _content)
    if(NOT _content MATCHES "${marker}")
        get_filename_component(_workdir "${srcfile}" DIRECTORY)
        message(STATUS "Applying patch: ${patchfile}")
        execute_process(
            COMMAND patch -p1 -i "${patchfile}"
            WORKING_DIRECTORY "${_workdir}"
            RESULT_VARIABLE _rc
        )
        if(NOT _rc EQUAL 0)
            message(FATAL_ERROR "patch failed (rc=${_rc}): ${patchfile}")
        endif()
    endif()
endfunction()

# ===== Paths inside lib/ =====
set(PATH_BROTLI     "${DEPS_DIR}/brotli")
set(PATH_FREETYPE "${DEPS_DIR}/freetype")
set(PATH_FRIBIDI    "${DEPS_DIR}/fribidi")
set(PATH_HARFBUZZ "${DEPS_DIR}/harfbuzz")
set(PATH_LIBASS     "${DEPS_DIR}/libass")

# ===== Patches =====
# harfbuzz's meson.build unconditionally probes for pthreads on non-windows
# hosts and adds -pthread. clang refuses to combine that with -mno-bulk-memory
# / -mno-sign-ext, so we patch out the probe on emscripten (HB_NO_MT already
# disables threading at compile time).
apply_patch_if_missing(
    "${PATH_HARFBUZZ}/meson.build"
    "system\\(\\) != 'emscripten'"
    "${CMAKE_SOURCE_DIR}/patches/harfbuzz-skip-emscripten-threads.patch"
)

# ===== Dependencies =====
ep_cmake(brotli_ep "${PATH_BROTLI}")

ep_meson(freetype_ep "${PATH_FREETYPE}"
    -Dbrotli=enabled
    -Dbzip2=disabled
    -Dharfbuzz=disabled           # avoid meson fetching hb as a subproject (adds -pthread)
    -Dmmap=disabled
    -Dpng=disabled
    -Dtests=disabled
    -Dzlib=disabled
)
add_dependencies(freetype_ep brotli_ep)

ep_meson(fribidi_ep "${PATH_FRIBIDI}"
    -Ddocs=false
    -Dtests=false
)
add_dependencies(fribidi_ep freetype_ep)

ep_meson(harfbuzz_ep "${PATH_HARFBUZZ}"
    -Dfreetype=enabled
    -Dtests=disabled
    -Dintrospection=disabled
    -Ddocs=disabled
    -Ddoc_tests=false
    -Dutilities=disabled
    # -Dc_args= on the CLI REPLACES the cross-file's c_args (meson doesn't
    # append), so the global flags must be repeated here.
    "-Dc_args=${WASM_C_FLAGS} -DHB_NO_MT"
    "-Dcpp_args=${WASM_CXX_FLAGS} -DHB_NO_MT -Wno-nontrivial-memaccess"
)
add_dependencies(harfbuzz_ep freetype_ep fribidi_ep)

ep_meson(libass_ep "${PATH_LIBASS}"
    -Dtest=disabled
    -Dcompare=disabled
    -Dprofile=disabled
    -Dfuzz=disabled
    -Dcheckasm=disabled
    -Dfontconfig=disabled
    -Dlibunibreak=disabled
    -Drequire-system-font-provider=false
)
add_dependencies(libass_ep freetype_ep fribidi_ep harfbuzz_ep)

# ===== Inputs =====
set(LIBASS_DEPS
    "${PREFIX_DIR}/lib/libfribidi.a"
    "${PREFIX_DIR}/lib/libbrotlicommon.a"
    "${PREFIX_DIR}/lib/libbrotlidec.a"
    "${PREFIX_DIR}/lib/libfreetype.a"
    "${PREFIX_DIR}/lib/libharfbuzz.a"
    "${PREFIX_DIR}/lib/libass.a"
)

set(SRC_CPP "${SRC_DIR}/libass.cpp")
set(PRE_JS "${SRC_DIR}/pre-worker.js")

# ===== emcc args =====
set(PERFORMANCE_ARGS
    -s BINARYEN_EXTRA_PASSES=--one-caller-inline-max-function-size=19306
    -s INVOKE_RUN=0
    -s DISABLE_EXCEPTION_CATCHING=1
    -s TEXTDECODER=1
    --no-heap-copy
    -flto
    -fno-exceptions
    --memory-init-file 0
)

set(SIZE_ARGS
    -s POLYFILL=0
    -s FILESYSTEM=0
    -s AUTO_JS_LIBRARIES=0
    -s AUTO_NATIVE_LIBRARIES=0
    -s HTML5_SUPPORT_DEFERRING_USER_SENSITIVE_REQUESTS=0
    -s INCOMING_MODULE_JS_API=[\"locateFile\",\"printErr\"]
    -s USE_SDL=0
    -s MINIMAL_RUNTIME=1
)

function(add_libass_wasm_target target_name out_js min_chrome modern debug_build)
    if(debug_build)
        set(opt_level -O0)
    else()
        set(opt_level -O3)
    endif()

    if(modern)
        set(modularize 1)
        set(export_es6 1)
        set(wasm 1)
        set(legacy_vm 0)
    else()
        set(modularize 0)
        set(export_es6 0)
        set(wasm 0)
        set(legacy_vm 1)
    endif()

    add_custom_command(
        OUTPUT "${out_js}"
        COMMAND ${CMAKE_COMMAND} -E env ${_env}
            ${EMCC_EXECUTABLE}
            "${SRC_CPP}"
            ${LIBASS_DEPS}
            -I${PREFIX_DIR}/include
            -I${PREFIX_DIR}/include/freetype2
            ${PERFORMANCE_ARGS}
            ${SIZE_ARGS}
            -lembind
            --pre-js "${PRE_JS}"
            -s EXPORTED_FUNCTIONS=[\"_malloc\",\"_free\"]
            -s EXPORT_KEEPALIVE=1
            -s EXPORTED_RUNTIME_METHODS=[\"getTempRet0\",\"setTempRet0\"]
            -s IMPORTED_MEMORY=1
            -s MIN_CHROME_VERSION=${min_chrome}
            -s ENVIRONMENT=web,worker
            -s EXIT_RUNTIME=0
            -s WASM_BIGINT=0
            -s ALLOW_MEMORY_GROWTH=1
            -s MODULARIZE=${modularize}
            -s EXPORT_ES6=${export_es6}
            -s WASM=${wasm}
            -s LEGACY_VM_SUPPORT=${legacy_vm}
            -s EXPORT_NAME=LibassWorker
            ${opt_level}
            -o "${out_js}"
        DEPENDS libass_ep ${LIBASS_DEPS} "${SRC_CPP}" "${PRE_JS}"
        VERBATIM
    )

    add_custom_target(${target_name} ALL DEPENDS "${out_js}")
endfunction()

# ===== Targets =====
# TARGET_MODE gates which wasm targets are declared, so the CMake state in the
# modern container never mentions legacy targets and vice versa.
if(NOT DEFINED TARGET_MODE)
    message(FATAL_ERROR "TARGET_MODE must be set (modern|legacy).")
endif()

if(TARGET_MODE STREQUAL "modern")
    add_libass_wasm_target(
        libass_modern_min
        "${DIST_JS_DIR}/modern/worker.min.js"
        68
        TRUE
        FALSE
    )

    add_libass_wasm_target(
        libass_modern_debug
        "${DIST_JS_DIR}/modern/worker.debug.js"
        68
        TRUE
        TRUE
    )
elseif(TARGET_MODE STREQUAL "legacy")
    add_libass_wasm_target(
        libass_legacy_min
        "${DIST_JS_DIR}/legacy/worker.min.js"
        38
        FALSE
        FALSE
    )

    add_libass_wasm_target(
        libass_legacy_debug
        "${DIST_JS_DIR}/legacy/worker.debug.js"
        38
        FALSE
        TRUE
    )
else()
    message(FATAL_ERROR "TARGET_MODE must be 'modern' or 'legacy' (got '${TARGET_MODE}').")
endif()

message(STATUS "Libraries prefix: ${PREFIX_DIR}")
message(STATUS "ExternalProject meta: ${EP_META_DIR}")
message(STATUS "JS output: ${DIST_JS_DIR}")
