#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"
MODE="${2:-full}"

MODERN_IMAGE=libass-webos-legacy
LEGACY_IMAGE=libass-webos-legacy-old
MODERN_EMSDK=4.0.13
LEGACY_EMSDK=3.1.40

usage () {
    echo "usage: $(basename "$0") [modern|legacy|all] [full|quick|clean|clean-libs|clean-js]" >&2
    exit 2
}

case "$TARGET" in
    modern|legacy|all) ;;
    *) usage ;;
esac

case "$MODE" in
    full|quick|clean|clean-libs|clean-js) ;;
    *) usage ;;
esac

image_exists () {
    docker image inspect "$1" >/dev/null 2>&1
}

build_image () {
    local image="$1"
    local emsdk="$2"
    echo "==> Building Docker image ${image} (emsdk ${emsdk})"
    docker buildx build \
        -t "$image" \
        --build-arg "EMSDK_VERSION=${emsdk}" \
        --network=host \
        .
}

ensure_image () {
    local image="$1"
    local emsdk="$2"
    if ! image_exists "$image"; then
        build_image "$image" "$emsdk"
    fi
}

clean_paths () {
    local paths="$1"
    rm -rf ${paths}
}

clean_libs () {
    echo "==> Cleaning C libs"
    clean_paths "build/libraries build/_deps_build build/_meta"
}

clean_js () {
    local target="$1"
    local paths=""
    if [[ "$target" == "all" || "$target" == "modern" ]]; then
        paths="${paths} build/js/modern dist/modern"
    fi
    if [[ "$target" == "all" || "$target" == "legacy" ]]; then
        paths="${paths} build/js/legacy dist/legacy"
    fi
    if [[ "$target" == "all" ]]; then
        paths="${paths} dist/types"
    fi
    echo "==> Cleaning JS artifacts:${paths}"
    clean_paths "${paths}"
}

case "$MODE" in
    clean-libs)
        clean_libs
        exit 0
        ;;
    clean-js)
        clean_js "$TARGET"
        exit 0
        ;;
    clean)
        clean_libs
        clean_js "$TARGET"
        exit 0
        ;;
esac

compile () {
    local image="$1"
    local target="$2"
    echo "==> Compiling '${target}' in ${image} (${MODE})"
    docker run --rm \
        -v "$PWD:/work" \
        --user "$(id -u):$(id -g)" \
        "$image" \
        bash -lc "make ${target}"
}

build_target () {
    local target="$1"
    local image emsdk
    if [[ "$target" == "modern" ]]; then
        image="$MODERN_IMAGE"
        emsdk="$MODERN_EMSDK"
    else
        image="$LEGACY_IMAGE"
        emsdk="$LEGACY_EMSDK"
    fi

    ensure_image "$image" "$emsdk"

    if [[ "$MODE" == "full" ]]; then
        clean_libs
        clean_js "$target"
    fi
    compile "$image" "$target"

    echo "==> Bundling JS (webpack, ${target})"
    npm run "webpack-${target}"
}

npm install

if [[ "$TARGET" == "all" || "$TARGET" == "modern" ]]; then
    build_target "modern"
fi

if [[ "$TARGET" == "all" || "$TARGET" == "legacy" ]]; then
    build_target "legacy"
fi

echo "==> Emitting TypeScript declarations"
npm run types

echo "==> Done."
