#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET="${1:-all}"
MODE="${2:-full}"

usage () {
    echo "usage: $(basename "$0") [modern|legacy|all] [full|quick]" >&2
    exit 2
}

case "$TARGET" in
    modern|legacy|all) ;;
    *) usage ;;
esac

case "$MODE" in
    full|quick) ;;
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

compile () {
    local image="$1"
    local target="$2"
    local pre="$3"
    echo "==> Compiling '${target}' in ${image} (${MODE})"
    docker run --rm \
        -v "$PWD:/work" \
        "$image" \
        bash -lc "${pre}make ${target}"
}

build_target () {
    local target="$1"
    local image emsdk
    if [[ "$target" == "modern" ]]; then
        image=libass-webos-legacy
        emsdk=4.0.13
    else
        image=libass-webos-legacy-old
        emsdk=3.1.40
    fi

    ensure_image "$image" "$emsdk"

    local pre=""
    if [[ "$MODE" == "full" ]]; then
        pre="make clean-libs && "
    fi
    compile "$image" "$target" "$pre"

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

echo "==> Done."
